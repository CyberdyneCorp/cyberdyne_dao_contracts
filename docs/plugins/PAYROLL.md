# PayrollPlugin

Per-plugin spec for the Cyberdyne DAO PayrollPlugin (TRD §6.3, ROADMAP P2).

| | |
|---|---|
| Source | `src/plugins/payroll/PayrollPlugin.sol` |
| Setup | `src/plugins/payroll/PayrollPluginSetup.sol` |
| Base | `PluginUUPSUpgradeable` (OSx commons v1.4) |
| Permission ID | `MANAGE_PAYROLL_PERMISSION = keccak256("MANAGE_PAYROLL_PERMISSION")` |
| Date library | `lib/BokkyPooBahsDateTimeLibrary.sol` (vendored, MIT) |
| Max recipients | 100 (`MAX_RECIPIENTS`) |

## 1. What it does

- Maintains an on-chain list of payroll recipients (payee, token, amount).
- Pays every active recipient **once per month**, on a fixed day-of-month chosen at install.
- Recipient management (`addRecipient` / `removeRecipient` / `setAmount` / `setPayDayOfMonth`) is vote-gated through the DAO.
- The monthly `executePayroll()` crank is **permissionless** — anyone can call it. Idempotent within a month.

## 2. Trust + custody model

- Plugin holds **no funds**. All ETH and ERC20 lives in the DAO.
- Plugin is granted `EXECUTE_PERMISSION` on the DAO so its monthly crank can issue `IExecutor.execute(callId, actions, allowFailureMap)` to move treasury funds to payees.
- The crank is the only `executePayroll` call site; the DAO is the only call site for management functions (gated by `MANAGE_PAYROLL_PERMISSION`).
- Plugin upgrades require `UPGRADE_PLUGIN_PERMISSION` on the plugin, granted only to the DAO. UUPS via `_authorizeUpgrade` inherited from `PluginUUPSUpgradeable`.

## 3. Calendar math caveats

- `payDayOfMonth` is restricted to **1..28** at init and at every `setPayDayOfMonth`. This sidesteps February-vs-30/31 entirely.
- The current period is computed as `year * 12 + month` from `BokkyPooBahsDateTimeLibrary.timestampToDate(block.timestamp)`.
- The "due day" check is `block.timestamp`'s calendar day `>= payDayOfMonth`. There is **no upper bound** on how late the crank can run within a month — once the period boundary rolls over to the next month, that month's window closes permanently for prior periods.
- **No back-pay.** If month N is skipped (nobody called the crank), the next call in month N+1 pays only N+1. This is intentional: a back-pay loop would let anyone stack payouts. Resuming a skipped month requires a separate proposal.

## 4. Per-recipient failure tolerance

- Each call to the crank builds an `Action[]` of length `n` = active-recipient count.
- `allowFailureMap = (1 << n) - 1` — every bit is set, so any single transfer may fail without aborting the others.
- The DAO returns a `failureMap` bitmap; bit `i` set means action `i` reverted. The plugin emits `PayrollExecuted(period, n, failureMap)` so the UI/subgraph can mark per-recipient failures.
- `lastPayoutPeriod` is updated **before** the event, locking the month even if some recipients failed. A failed recipient still has to wait until next month for another attempt (vs. immediate retry).

## 5. Soft-delete preservation

- `removeRecipient` flips `active = false` but keeps the storage slot. This preserves the foreign key for prior `PayrollPayout` history (subgraph `PayrollRecipient` entity).
- A removed payee cannot be re-added under the same address; `addRecipient` would revert `RecipientAlreadyExists`. To rotate keys for an existing person, the DAO uses a different payee address (the historic record stays attached to the old one).

## 6. Keeper integration

- Production: register `executePayroll()` with **Gelato** or **Chainlink Automation** scheduled to fire on `payDayOfMonth` 12:00 UTC each month. The keeper pays its own gas; ~$2–$10/run on mainnet at current gas prices.
- Fallback: any EOA can call the crank — useful as a manual backstop and for incentive experiments in v1.1 (see TRD §16 #3).
- The crank reads `block.timestamp` directly; there is no off-chain signed payload, so keepers don't need DAO permissions or signed authorizations.

## 7. Events (full table in `docs/EVENTS.md`)

| Event | Trigger | Indexed |
|---|---|---|
| `RecipientAdded(payee, token, amount)` | `addRecipient` | `payee`, `token` |
| `RecipientRemoved(payee)` | `removeRecipient` | `payee` |
| `RecipientAmountUpdated(payee, old, new)` | `setAmount` | `payee` |
| `PayDayUpdated(old, new)` | `setPayDayOfMonth` | — |
| `PayrollExecuted(period, count, failureMap)` | `executePayroll` | `period` |

## 8. Storage layout (UUPS upgrade safety)

Layout snapshot at the current head is at `docs/storage-layouts/PayrollPlugin.md` (regenerate via `forge inspect PayrollPlugin storage-layout`). Plugin-specific state starts at slot **301** (after the inherited gap chain):

```
slot 301: _recipients (Recipient[])
slot 302: indexOfPayee (mapping)
slot 303: payDayOfMonth (uint8)
slot 304: lastPayoutPeriod (uint256)
slot 305..351: __gap[47]
```

Upgrades may consume slots from `__gap` (decreasing the gap size) but must **never** reorder or shrink anything in slots 301..304. The `forge inspect` snapshot is committed under `docs/storage-layouts/` per release tag so audit can diff layouts across versions.

## 9. Slither audit notes (waivers)

`slither src/plugins/payroll/` produces these findings; each is reviewed and accepted:

| Finding | Location | Disposition |
|---|---|---|
| `uninitialized-local` on `j` | executePayroll, allActiveRecipients | False positive. `uint256 j` defaults to 0 in Solidity; this is the idiomatic pattern for a write cursor into a freshly-allocated memory array. |
| `unused-return` on `IExecutor.execute` first return | executePayroll | Intentional. We only need `failureMap` to emit the event; the per-action `execResults bytes[]` is irrelevant to payroll semantics. |
| `reentrancy-events` (event after external call) | executePayroll | Accepted in our trust model. The only external call is to our own DAO; `lastPayoutPeriod = currentPeriod` is set BEFORE the emit, so re-entry through any recipient cannot double-pay (the next `executePayroll` would revert `AlreadyPaidThisPeriod`). |
| `timestamp` (block.timestamp comparison) | executePayroll | Design intent. Monthly payroll is by definition timestamp-driven. Miner timestamp jitter (±15s) cannot reorder calendar months at our granularity. |
| `naming-convention` on `_dao` / `_payDayOfMonth` / `__gap` | various | Intentional. Matches OSx's project-wide convention of leading-underscore for function parameters and double-underscore for inherited gaps (per OpenZeppelin's upgradeable storage_gaps guide). `MAX_RECIPIENTS` is uppercase per Solidity style. |
| `unused-state` on `__gap` | PayrollPlugin | Intentional. Reserves slots for future upgrades without breaking the storage layout (OZ upgrade-safety pattern). |

CI gate: `slither --fail-high`. None of the above are high-severity; this list updates if the implementation changes.

## 10. Tests

- Unit: `test/plugins/payroll/PayrollPlugin.unit.test.ts` — 26 cases. ≥90% coverage on `src/plugins/payroll/**` (currently 100% lines, 96% branches).
- Fork: `test/plugins/payroll/PayrollPlugin.fork.test.ts` — runs on `mainnetFork` and `baseFork` when `RPC_MAINNET` / `RPC_BASE` are set. Gated via `onlyOn(...)`; silently skipped on other networks.
- Permission matrix: `test/plugins/PluginSetup.unit.test.ts` — asserts `prepareInstallation` returns the TRD §9 set verbatim.
