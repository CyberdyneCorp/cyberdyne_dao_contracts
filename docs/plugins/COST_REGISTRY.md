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
| Max entries | 300 default (`MAX_ENTRIES()`, governance-settable up to `MAX_ENTRIES_CEILING` = 1000) |
| Max per crank | 100 (`MAX_PER_PAGE`) |

## 1. What it does

- Maintains an on-chain list of recurring cost entries: `name`, `description`,
  `costUsdc` (amount in the payment token's smallest unit), `frequencyDays`
  (pay every N days), and a `payee`.
- Register / update / remove entries — and `setMaxEntries` — are **vote-gated**
  through the DAO (`MANAGE_COSTS_PERMISSION`).
- `setMaxEntries(newMax)` raises/lowers the entry-slot cap (`MAX_ENTRIES()`,
  default 300), bounded above by `MAX_ENTRIES_CEILING` (1000) and below by the
  live slot count — lets a DAO grow past 300 without a plugin upgrade.
- A **permissionless** crank disburses the USDC cost to each entry's payee once
  its period has elapsed — `processDue(offset, limit)` for an explicit window,
  `processAllDue()` for a single-page registry, or `processDueFromCursor(limit)`
  for round-robin coverage of a large one (see §4).
- Entries are publicly readable with **pagination** (`getEntries(offset, limit)`).

## 2. Trust + custody model

- Plugin holds **no funds**. All USDC lives in the DAO.
- Plugin is granted `EXECUTE_PERMISSION` on the DAO so the crank can issue
  `IExecutor.execute(callId, actions, allowFailureMap)` to move treasury USDC to
  payees. (Same shape as Payroll — see `docs/plugins/PAYROLL.md §2`.)
- The crank is the only `processDue` call site; the DAO is the only caller of the
  vote-gated mutators (`MANAGE_COSTS_PERMISSION`).
- UUPS upgrades require `UPGRADE_PLUGIN_PERMISSION`, granted only to the DAO.
- ERC20 payments route through a per-instance **`SafeTransferHelper`** (`src/common/SafeTransferHelper.sol`), deployed in `initialize`: the DAO `approve`s the helper for the exact amount and the helper does `SafeERC20.safeTransferFrom(dao → payee)`, so a token that returns `false` without reverting can't be booked as paid (audit CR-M-01). The helper is stateless, holds no funds, and grants no authority.
- The payment token is **migratable** via the vote-gated `setPaymentToken(address)` (permission ID `UPDATE_PAYMENT_TOKEN_PERMISSION`). Existing entries' `costUsdc` is stored as raw token units, so to prevent silent re-pricing the migration is **hard-gated on a decimals match**: `setPaymentToken` reverts `PaymentTokenDecimalsMismatch` if the new token's `decimals()` differs from the current one (audit CR-M-02). A same-decimals swap (e.g. one 6-dp USD stablecoin to another) is allowed; a cross-decimals move (e.g. 6-dp → 18-dp) must instead be done by a plugin upgrade that rescales entries atomically.

> **No `preview…Actions` helpers needed.** Like Payroll, the fund-moving entry (`processDue`) is **permissionless** (keeper-callable), not governance-routed — it never participates in the nested-`dao.execute` reentrancy issue that motivated [TRD §9a](../TRD.md#9a-governance-path-action-builders-previewactions). Entry-management mutators (`registerEntry` / `updateEntry` / `removeEntry` / `setMaxEntries`) are single-action plugin calls and ride through TokenVoting as one-action proposals directly.

### Upgrade migration (`initializeV2`)

`MAX_ENTRIES()` is a storage value (default 300) set in `initialize`. For an instance **upgraded** from a build where it was a `constant`, the new `_maxEntries` slot reads 0 (it was `__gap`), which would make `registerEntry` revert `EntryLimitExceeded(0)`. `initializeV2()` (`reinitializer(2)`) seeds the default once; run it atomically with the upgrade (`upgradeToAndCall(newImpl, abi.encodeCall(CostRegistryPlugin.initializeV2, ()))`). Permissionless + idempotent (writes only when zero); fresh installs never need it. Same pattern as `docs/plugins/PAYROLL.md §2`.

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
  `MAX_PER_PAGE = 100`), collects the active + due entries, and pays each as a
  **SafeERC20 pair** — `token.approve(helper, costUsdc)` + `helper.safeTransfer(token, payee, costUsdc)` (see §2) — batched through `DAO.execute`.
- **Pagination:** large registries are processed across multiple calls by
  walking `offset`. Idempotency is per-entry via `lastPaidAt`, so a re-run on
  the same window only pays whatever has since come due (nothing, if just paid).
- **`processAllDue()` convenience:** pays every due entry from index 0 in a
  single page **and reverts `RegistryExceedsSinglePage` when the registry has
  more than `MAX_PER_PAGE` slots** (audit CR-L-02) — so an operator can never
  mistake a partial first-page run for a full sweep. Larger registries must
  paginate.
- **`processDueFromCursor(limit)` (audit CR-L-03):** a round-robin crank that
  processes the page starting at a persistent `_dueCursor`, then advances the
  cursor by `limit` (wrapping at the end). Repeated permissionless calls cover
  every entry of a multi-page registry without keepers coordinating offsets.
  `dueCursor()` exposes the current offset. All three entry points share the
  private `_processDue(offset, limit)`.
- **Failed transfers revert the whole batch (audit H-03 / CR-M-01).** Earlier
  builds set `allowFailureMap = (1 << count) - 1` (every transfer failable) and
  *still* marked each entry paid — the report-missed accounting bug. The crank
  now runs with **`allowFailureMap = 0`**: any failing transfer (insufficient
  USDC, paused token, blocked payee, or a false-returning token caught by the
  SafeERC20 helper — see §2) reverts the entire batch, rolling back every
  `lastPaidAt` write. So an entry is never marked paid for a payment that didn't
  happen, and `CostPaid` is emitted only on full success.
- **Reentrancy:** each paid entry's `lastPaidAt` is advanced **before** the
  external `execute` (effects-before-interactions), so a payee that reenters the
  crank sees the entry as not-due; if the batch then reverts, that write is
  rolled back with the transaction.

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
entry of that batch reverted. Since the crank now runs with
`allowFailureMap = 0` (§4), any failure reverts the batch — so a `CostsProcessed`
event is only ever emitted with `failureMap == 0` (all paid).
`setPaymentToken` additionally emits `PaymentTokenUpdated(previous, current)`;
`setMaxEntries` emits `MaxEntriesUpdated(oldMax, newMax)`.

## 7. Storage layout (UUPS upgrade safety)

Layout snapshot at the current head is at
`docs/storage-layouts/CostRegistryPlugin.md` (regenerate via
`forge inspect CostRegistryPlugin storageLayout`). Plugin-specific state starts
after the inherited gap chain:

```
slot 301: _token (IERC20)
slot 302: _entries (CostEntry[])
slot 303: _maxEntries (uint256)     — added with the MAX_ENTRIES storage migration (initializeV2)
slot 304: _transferHelper (address) — added by audit remediation (CR-M-01 SafeERC20 helper)
slot 305: _dueCursor (uint256)      — added by audit remediation (CR-L-03 round-robin cursor)
slot 306..350: __gap[45]
```

All additions are append-only (slots 301..303 untouched); the remediation slots
304/305 came from `__gap` (`__gap[47]` → `__gap[45]`). Instances installed before
the helper slot existed run `initializeV3()` (`reinitializer(3)`) once, atomically
with the upgrade, to deploy the per-instance `SafeTransferHelper` (permissionless +
idempotent). `CostEntry` packs `payee(20)+costUsdc(uint96,12)` into one slot and
`frequencyDays(uint32)+lastPaidAt(uint64)+active(bool)` into the next; `name` and
`description` are dynamic. `costUsdc` is stored as `uint96` (≈7.9e28 max) but
the **runtime cap is `MAX_COST_USDC = 1_000_000_000_000_000`** (= $1B USDC at 6
decimals) — a defense-in-depth limit far above any realistic per-payment amount
but tight enough that an unintended extra zero in `registerEntry` /
`updateEntry` trips `CostTooLarge(costUsdc)`. Upgrades may consume slots from
`__gap` but must never reorder slots 301/302.

## 8. Slither audit notes (waivers)

`slither src/plugins/cost-registry/` — expected, accepted findings:

| Finding | Location | Disposition |
|---|---|---|
| `unused-return` on `IExecutor.execute` first return | processDue | Intentional — only `failureMap` is needed for the event. |
| `reentrancy-events` (event after external call) | processDue | Accepted. The only external call is to our own DAO; each entry's `lastPaidAt` is advanced BEFORE `execute`, so re-entry cannot re-pay an entry. |
| `timestamp` (block.timestamp comparison) | processDue / isDue | Design intent. Recurring billing is timestamp-driven; miner jitter (±15s) is immaterial at day granularity. |
| `naming-convention` on `_dao` / `__gap` | various | Matches the OSx project-wide convention (leading underscore params, double-underscore gaps). |
| `uninitialized-local` on cursor `count` | `_processDue` | False positive. Standard Solidity zero-default for a write cursor; the variable is written before it's read. Same pattern as Payroll's documented `uninitialized-local` waiver. |
| `solc-version` `0.8.17` | all files | Intentional. Project-wide pin to `0.8.17` for Cancun-safe deployment to mainnet / Base / Sepolia (matches OSx framework version). |
| `unused-state` on `__gap` | CostRegistryPlugin | Intentional. Reserves slots for future upgrades without breaking the storage layout (OZ upgrade-safety pattern). |

CI gate: `slither --fail-high`. None of the above are high-severity.

## 9. Tests

- Unit: `test/plugins/cost-registry/CostRegistryPlugin.unit.test.ts` — CRUD
  validations + events, `MAX_COST_USDC` cap, `setPaymentToken` migration +
  decimals-mismatch guard, paginated `getEntries`, crank due/not-due/inactive,
  `processAllDue` single-page guard, `processDueFromCursor` round-robin, no
  back-pay, and the audit regressions (H-03 underfunded-batch revert,
  CR-M-01 false-returning token, CR-I-01/I-02). ≥90% coverage on
  `src/plugins/cost-registry/**`.
- Invariant: `test/invariants/CostRegistry.invariant.t.sol` — plugin holds no
  token / no ETH, `entryCount` bounded, `lastPaidAt` never set into the future.
- Fork: `test/plugins/cost-registry/CostRegistryPlugin.fork.test.ts` — pays real
  USDC from a whale-seeded DAO on `mainnetFork` / `baseFork` (gated via
  `onlyOn(...)`); validates the day-based crank + no-back-pay against real tokens.
- Permission matrix: `test/plugins/PluginSetup.unit.test.ts` — asserts the 4-grant
  install set (EXECUTE, MANAGE_COSTS, UPGRADE_PLUGIN, UPDATE_PAYMENT_TOKEN).
