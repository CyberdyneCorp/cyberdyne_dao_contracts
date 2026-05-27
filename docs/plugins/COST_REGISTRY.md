# CostRegistryPlugin

Per-plugin spec for the Cyberdyne DAO CostRegistryPlugin — a vote-gated
registry of the DAO's recurring operating costs (AI tokens, cloud bills,
services…) that also disburses them in USDC.

| | |
|---|---|
| Source | `src/plugins/cost-registry/CostRegistryPlugin.sol` |
| Setup | `src/plugins/cost-registry/CostRegistryPluginSetup.sol` |
| Base | `PluginUUPSUpgradeable` (OSx commons v1.4) |
| Permission ID | `MANAGE_COSTS_PERMISSION = keccak256("MANAGE_COSTS_PERMISSION")` |
| Payment token | one ERC20 (USDC), set at install |
| Max entries | 300 (`MAX_ENTRIES`) |
| Max per crank | 100 (`MAX_PER_PAGE`) |

## 1. What it does

- Maintains an on-chain list of recurring cost entries: `name`, `description`,
  `costUsdc` (amount in the payment token's smallest unit), `frequencyDays`
  (pay every N days), and a `payee`.
- Register / update / remove entries is **vote-gated** through the DAO
  (`MANAGE_COSTS_PERMISSION`).
- A **permissionless** `processDue(offset, limit)` crank disburses the USDC cost
  to each entry's payee once its period has elapsed.
- Entries are publicly readable with **pagination** (`getEntries(offset, limit)`).

## 2. Trust + custody model

- Plugin holds **no funds**. All USDC lives in the DAO.
- Plugin is granted `EXECUTE_PERMISSION` on the DAO so the crank can issue
  `IExecutor.execute(callId, actions, allowFailureMap)` to move treasury USDC to
  payees. (Same shape as Payroll — see `docs/plugins/PAYROLL.md §2`.)
- The crank is the only `processDue` call site; the DAO is the only caller of the
  vote-gated mutators (`MANAGE_COSTS_PERMISSION`).
- UUPS upgrades require `UPGRADE_PLUGIN_PERMISSION`, granted only to the DAO.

> **No `preview…Actions` helpers needed.** Like Payroll, the fund-moving entry (`processDue`) is **permissionless** (keeper-callable), not governance-routed — it never participates in the nested-`dao.execute` reentrancy issue that motivated [TRD §9a](../TRD.md#9a-governance-path-action-builders-previewactions). Entry-management mutators (`registerEntry` / `updateEntry` / `removeEntry`) are single-action plugin calls and ride through TokenVoting as one-action proposals directly.

## 3. Payment scheduling

- Each entry is independent: it becomes due when
  `block.timestamp >= lastPaidAt + frequencyDays * 1 days`.
- `registerEntry` stamps `lastPaidAt = block.timestamp`, so the **first** payment
  is due one full period after registration (no immediate payout on register).
- `updateEntry` preserves `lastPaidAt` — editing fields never resets the clock
  (and governance can't grief the schedule by re-saving an entry).
- **No back-pay.** When the crank pays an entry it sets `lastPaidAt = now`, so
  missed periods are skipped (paying once, never N times). This is the
  anti-stacking choice — a back-pay loop would let anyone drain the treasury by
  delaying then spamming the crank. View helpers: `isDue(id)`, `nextPaymentAt(id)`.

## 4. The crank — `processDue(offset, limit)`

- Scans the entry window `[offset, offset+limit)` (`limit` clamped to
  `MAX_PER_PAGE = 100`), collects the active + due entries, and pays each via a
  USDC `transfer(payee, costUsdc)` action batched through `DAO.execute`.
- **Pagination:** large registries are processed across multiple calls by
  walking `offset`. No global cursor is needed — idempotency is per-entry via
  `lastPaidAt`, so a re-run on the same window only pays whatever has since come
  due (nothing, if just paid).
- **Per-entry failure tolerance:** `allowFailureMap = (1 << count) - 1`, so one
  payee whose transfer reverts (e.g. the DAO ran out of USDC mid-batch) never
  blocks the rest. `CostsProcessed(fromIndex, count, failureMap)` surfaces the
  page-local bitmap; `CostPaid` fires per entry.
- **Reentrancy:** each paid entry's `lastPaidAt` is advanced **before** the
  external `execute` (effects-before-interactions), so a payee that reenters the
  crank cannot trigger a second payment for the same entry. A transfer that then
  fails leaves the entry marked paid — it waits one more period (same trade-off
  as Payroll).

## 5. Soft-delete preservation

- `removeEntry` flips `active = false` but keeps the slot, so prior `CostPaid`
  history (subgraph / UI) keeps a stable foreign key. A removed entry is skipped
  by the crank and reported `active = false` by the views.
- The slot count (`entryCount`, capped at `MAX_ENTRIES = 300`) includes
  soft-deleted entries; the cap bounds the storage scan the crank performs.

## 6. Events (full table in `docs/EVENTS.md`)

| Event | Trigger | Indexed |
|---|---|---|
| `EntryRegistered(id, payee, costUsdc, frequencyDays, name)` | `registerEntry` | `id`, `payee` |
| `EntryUpdated(id, payee, costUsdc, frequencyDays)` | `updateEntry` | `id`, `payee` |
| `EntryRemoved(id)` | `removeEntry` | `id` |
| `CostPaid(id, payee, amount, paidAt)` | `processDue` (per paid entry) | `id`, `payee` |
| `CostsProcessed(fromIndex, count, failureMap)` | `processDue` (per batch) | — |

`failureMap` in `CostsProcessed` is **page-local**: bit `i` = the `i`-th paid
entry of that batch reverted.

## 7. Storage layout (UUPS upgrade safety)

Layout snapshot at the current head is at
`docs/storage-layouts/CostRegistryPlugin.md` (regenerate via
`forge inspect CostRegistryPlugin storageLayout`). Plugin-specific state starts
after the inherited gap chain:

```
slot 301: _token (IERC20)
slot 302: _entries (CostEntry[])
slot 303..350: __gap[48]
```

`CostEntry` packs `payee(20)+costUsdc(uint96,12)` into one slot and
`frequencyDays(uint32)+lastPaidAt(uint64)+active(bool)` into the next; `name` and
`description` are dynamic. `costUsdc` is `uint96` (≈7.9e28 max — far beyond any
realistic USDC amount); `registerEntry`/`updateEntry` revert `CostTooLarge` above
it. Upgrades may consume slots from `__gap` but must never reorder slots 301/302.

## 8. Slither audit notes (waivers)

`slither src/plugins/cost-registry/` — expected, accepted findings:

| Finding | Location | Disposition |
|---|---|---|
| `unused-return` on `IExecutor.execute` first return | processDue | Intentional — only `failureMap` is needed for the event. |
| `reentrancy-events` (event after external call) | processDue | Accepted. The only external call is to our own DAO; each entry's `lastPaidAt` is advanced BEFORE `execute`, so re-entry cannot re-pay an entry. |
| `timestamp` (block.timestamp comparison) | processDue / isDue | Design intent. Recurring billing is timestamp-driven; miner jitter (±15s) is immaterial at day granularity. |
| `naming-convention` on `_dao` / `__gap` | various | Matches the OSx project-wide convention (leading underscore params, double-underscore gaps). |

CI gate: `slither --fail-high`. None of the above are high-severity.

## 9. Tests

- Unit: `test/plugins/cost-registry/CostRegistryPlugin.unit.test.ts` — 23 cases
  (CRUD validations + events, paginated `getEntries`, crank due/not-due/inactive,
  no back-pay, per-entry failure isolation, windowing, `isDue`/`nextPaymentAt`).
  ≥90% coverage on `src/plugins/cost-registry/**`.
- Invariant: `test/invariants/CostRegistry.invariant.t.sol` — plugin holds no
  token / no ETH, `entryCount` bounded, `lastPaidAt` never set into the future.
- Fork: `test/plugins/cost-registry/CostRegistryPlugin.fork.test.ts` — pays real
  USDC from a whale-seeded DAO on `mainnetFork` / `baseFork` (gated via
  `onlyOn(...)`); validates the day-based crank + no-back-pay against real tokens.
- Permission matrix: `test/plugins/PluginSetup.unit.test.ts` — asserts the 3-grant
  install set (EXECUTE, MANAGE_COSTS, UPGRADE_PLUGIN).
