# PayrollPlugin

Per-plugin spec for the Cyberdyne DAO PayrollPlugin (TRD §6.3, ROADMAP P2).

| | |
|---|---|
| Source | `src/plugins/payroll/PayrollPlugin.sol` |
| Setup | `src/plugins/payroll/PayrollPluginSetup.sol` |
| Base | `PluginUUPSUpgradeable` (OSx commons v1.4) |
| Permission ID | `MANAGE_PAYROLL_PERMISSION = keccak256("MANAGE_PAYROLL_PERMISSION")` |
| Date library | `lib/BokkyPooBahsDateTimeLibrary.sol` (vendored, MIT) |
| Max recipients | 300 default (`MAX_RECIPIENTS()`), settable up to 1000 (`MAX_RECIPIENTS_CEILING`); 100 paid per crank page (`MAX_RECIPIENTS_PER_PAGE`) |

## 1. What it does

- Maintains an on-chain list of payroll recipients (payee, token, amount).
- Pays every active recipient **once per month**, on a fixed day-of-month chosen at install.
- Recipient management (`addRecipient` / `removeRecipient` / `reactivateRecipient` / `setAmount` / `setPayDayOfMonth` / `setMaxRecipients`) is vote-gated through the DAO. (`reactivateRecipient` brings a soft-deleted payee back — see §5.)
- `setMaxRecipients(newMax)` raises/lowers the recipient-slot cap (`MAX_RECIPIENTS()`, default 300), bounded above by the hard `MAX_RECIPIENTS_CEILING` (1000) and below by the live slot count — lets a DAO grow past 300 without a plugin upgrade.
- The monthly crank is **permissionless** — anyone can call it. Idempotent within a month.
  - `executePayroll()` — pays the whole period in one batch (for payrolls up to one page).
  - `executePayrollPage(maxCount)` — pays the period across multiple cursor-tracked pages for large payrolls (see §3a).
- Skipped-month **recovery** comes in two forms (both vote-gated by `MANAGE_PAYROLL`, both bounded to a `period` strictly between `lastPayoutPeriod` and now and ≤ `MAX_FORCE_BACK_MONTHS` (12) back):
  - `executeForcePayPeriod(period)` — the **stateful, executable** path (audit M-02). Pays every active recipient once for `period` and records `forcePaidPeriod[period] = true` atomically with the transfer batch, so the same month can never be force-paid twice. Salary transfers are mandatory (`allowFailureMap = 0`) — a failed transfer reverts the whole call so it can be retried. Emits `ForcePeriodPaid(period)`. **Prefer this.**
  - `previewForcePayPeriodActions(period)` — a *view* returning the same batch for off-chain simulation / inspection; it also reverts once `forcePaidPeriod[period]` is set. See §2 for why a view exists alongside the executable path.
- **Native ETH payees are supported** — pass `token = address(0)` to `addRecipient`. The crank builds a value-bearing `Action` (`to: payee, value: amount, data: ""`) which the DAO executes as a native transfer. Mixed ETH + ERC20 batches in the same period are routine; the unit test `pays mixed ETH + ERC20 recipients in one crank` covers the path.

## 2. Trust + custody model

- Plugin holds **no funds**. All ETH and ERC20 lives in the DAO.
- Plugin is granted `EXECUTE_PERMISSION` on the DAO so its monthly crank can issue `IExecutor.execute(callId, actions, allowFailureMap)` to move treasury funds to payees.
- ERC20 payouts route through a per-instance **`SafeTransferHelper`** (`src/common/SafeTransferHelper.sol`), deployed in `initialize`. The DAO `approve`s the helper for the exact amount and the helper does `SafeERC20.safeTransferFrom(dao → payee)`, so a token that returns `false` without reverting can't be booked as paid (audit M-04). The helper is stateless, holds no funds, and grants no authority (it can only move tokens the caller already approved).
- The crank is the only `executePayroll` call site; the DAO is the only call site for management functions (gated by `MANAGE_PAYROLL_PERMISSION`).
- Plugin upgrades require `UPGRADE_PLUGIN_PERMISSION` on the plugin, granted only to the DAO. UUPS via `_authorizeUpgrade` inherited from `PluginUUPSUpgradeable`.

> **`preview…Actions` only for the recovery path.** Payroll's *recurring* fund-moving entry point (`executePayroll`) is **permissionless** (keeper-callable), not governance-routed — so it never participates in the nested-`dao.execute` reentrancy issue that motivated [TRD §9a](../TRD.md#9a-governance-path-action-builders-previewactions). Schedule mutators (`addRecipient`, `setMaxRecipients`, …) are single-action plugin calls and ride through TokenVoting as a one-action proposal directly. The **one** governance-routed fund move — the skipped-month recovery — is therefore exposed as `previewForcePayPeriodActions` (a view returning the transfer batch) rather than an `auth`-gated wrapper that calls `dao.execute` itself: such a wrapper would nest `dao.execute` inside the proposal's `dao.execute` and revert under OSx's `nonReentrant`, exactly like the swap/lending/LP fund ops.

### Upgrade migration (`initializeV2`)

`MAX_RECIPIENTS()` is a storage value (default 300) set in `initialize`. For an instance **upgraded** from a build where it was a `constant`, the new `_maxRecipients` slot reads 0 (it was `__gap`), which would make `addRecipient` revert `RecipientLimitExceeded(0)`. `initializeV2()` (`reinitializer(2)`) seeds the default once; run it atomically with the upgrade (`upgradeToAndCall(newImpl, abi.encodeCall(PayrollPlugin.initializeV2, ()))`). It is permissionless and idempotent (writes only when zero), so a forgotten call can still be repaired afterward. Fresh installs set the cap in `initialize` and never need it.

### Keeper bounty

`setKeeperBounty(token, perCrank, maxPerPeriod)` (gated by `UPDATE_BOUNTY_PERMISSION`) pays `msg.sender` a small bounty out of the DAO treasury on each successful crank, so Gelato / Chainlink Automation / random keepers have an economic incentive to call `executePayroll(Page)` on high-gas days.

- `token = address(0)` pays a native ETH bounty; an ERC20 address pays that token instead.
- `perCrank` is the amount paid per `_runPayroll` invocation (one for `executePayroll`, one per page for `executePayrollPage`).
- `maxPerPeriod` is a per-period rolling cap so paginated cranks within one month share one budget. The bounty for any single crank is clipped to the remaining cap (or 0 if exhausted). `setKeeperBounty` rejects an enabled config (`perCrank > 0`) whose `maxPerPeriod` can't fund a single crank — reverts `InvalidBountyConfig` (audit L-04).
- A bounty is awarded **only on a full page** (`count == MAX_RECIPIENTS_PER_PAGE`) **or the period's final page** (audit L-01), so a keeper can't farm the per-period cap by cranking tiny pages.
- Bounty is set to 0 by default (disabled) — installs unchanged.
- The bounty is the **only failable action** in the batch (§4): it's appended last with just its bits set in `allowFailureMap`, so if the bounty leg fails (e.g. DAO is out of the bounty token) the mandatory salaries are unaffected, and `KeeperBountyPaid` fires only when the bounty actually succeeded.
- Emits `KeeperBountyPaid(keeper, token, amount, period)` on each non-zero payout; `KeeperBountyConfigured(token, perCrank, maxPerPeriod)` on each governance reconfig.

## 3. Calendar math caveats

- `payDayOfMonth` is restricted to **1..28** at init and at every `setPayDayOfMonth`. This sidesteps February-vs-30/31 entirely.
- The current period is computed as `year * 12 + month` from `BokkyPooBahsDateTimeLibrary.timestampToDate(block.timestamp)`.
- The "due day" check is `block.timestamp`'s calendar day `>= payDayOfMonth`. There is **no upper bound** on how late the crank can run within a month — once the period boundary rolls over to the next month, that month's window closes permanently for prior periods.
- **No back-pay.** If month N is skipped (nobody called the crank), the next call in month N+1 pays only N+1. This is intentional: a back-pay loop would let anyone stack payouts. Resuming a skipped month requires a separate proposal.

## 3a. Paginated crank (large payrolls)

For payrolls larger than one batch can hold, `executePayrollPage(uint256 maxCount)` pays the current period in chunks; both cranks share one internal `_runPayroll(maxCount, requireSinglePass)`.

- **Caps.** `MAX_RECIPIENTS_PER_PAGE = 100` bounds a single batch (OSx caps `DAO.execute` at 256 actions and `allowFailureMap` is a 256-bit bitmap; 100 leaves gas headroom). `MAX_RECIPIENTS = 300` (total active + soft-deleted slots) bounds the storage scan a page performs to find the next active recipient.
- **Cursor.** Two storage words track progress: `cursorPeriod` (the period the cursor belongs to) and `payoutCursor` (the next `_recipients` index to resume from). A page resumes from the cursor when `cursorPeriod == currentPeriod`, else starts fresh at index 0 — so a new month always restarts cleanly and the cursor resets to 0 on completion.
- **Completion.** The period locks (`lastPayoutPeriod` advances) and `PayrollPeriodCompleted(period)` fires only when a page reaches the end of the recipient set. `executePayroll()` is `_runPayroll(MAX_RECIPIENTS_PER_PAGE, requireSinglePass=true)` and reverts `PayrollExceedsSinglePage` if it can't finish the period in that one batch — so it never half-pays a period.
- **Mid-period edits are frozen (audit M-03).** While a paginated period is in flight (`payoutCursor != 0 && cursorPeriod == currentPeriod`), recipient-set / amount mutations revert `PayrollMidPagination`, so a period is always paid against a consistent recipient set. A tail of only-inactive slots still completes the period in the current page without emitting a payment batch (audit L-03 — the single-pass crank scans the tail and won't spuriously revert `PayrollExceedsSinglePage`).
- **No back-pay still holds.** Only the current due period is ever processed; `executePayrollPage` reverts `AlreadyPaidThisPeriod` once the period is complete and `PageSizeZero` on `maxCount == 0`.

## 4. Mandatory salary transfers (audit H-01 / H-02)

> **Changed by external-audit remediation (issue #3).** Earlier builds set
> `allowFailureMap = (1 << count) - 1` (every bit failable), so a single
> reverting/false-returning payee was *tolerated* while the period was still
> marked complete — the H-01/H-02 accounting bug. Salary transfers are now
> **mandatory**.

- Each crank builds an `Action[]` for the active recipients in this batch/page. ERC20 legs are a **SafeERC20 pair** — `token.approve(helper, amount)` + `helper.safeTransfer(token, payee, amount)` (see §2) — and native-ETH legs are a single value transfer.
- **Salary action bits are cleared in `allowFailureMap`.** Any failing salary transfer (insufficient funds, paused token, reverting payee, a false-returning token caught by SafeERC20) reverts the **whole batch**, which rolls back the cursor / `lastPayoutPeriod` writes — so a period is never marked complete unless every salary in it actually paid. The crank can be retried once the cause is fixed.
- **Only the optional trailing keeper-bounty action is failable.** Its bits are the only ones set in `allowFailureMap`; `KeeperBountyPaid` is emitted **only** when the bounty action's bit is clear in the returned `failureMap`, so the event never overstates a payout (H-02 / L-04).
- The plugin emits `PayrollExecuted(period, count, failureMap)` per batch; `failureMap` now only ever carries the bounty bit (salary failures revert instead of being recorded).
- The cursor / `lastPayoutPeriod` are written **before** the external `execute` (effects-before-interactions): a reentrant crank reads the already-advanced cursor, and a reverted mandatory batch rolls those writes back with the transaction.
- **Mid-pagination freeze (M-03).** While a paginated period is in flight (`payoutCursor != 0 && cursorPeriod == currentPeriod`), `addRecipient` / `removeRecipient` / `reactivateRecipient` / `setAmount` revert `PayrollMidPagination`, so a single period can't be paid against a recipient set that changed between pages.

## 5. Soft-delete preservation

- `removeRecipient` flips `active = false` but keeps the storage slot. This preserves the foreign key for prior `PayrollPayout` history (subgraph `PayrollRecipient` entity).
- A removed payee cannot be re-added via `addRecipient` (it would revert `RecipientAlreadyExists`, since the slot's index is preserved). To bring a soft-deleted payee back, use **`reactivateRecipient(payee, token, amount, description)`** (audit L-02): it reuses the original slot, overwrites token / amount / description, and flips `active` back on (emitting `RecipientAdded`). It reverts `RecipientNotFound` for a payee that was never added and `RecipientAlreadyExists` for one that is currently active, and is frozen mid-pagination like the other mutators.

## 6. Keeper integration

- Production: register `executePayroll()` with **Gelato** or **Chainlink Automation** scheduled to fire on `payDayOfMonth` 12:00 UTC each month. The keeper pays its own gas; ~$2–$10/run on mainnet at current gas prices.
- Fallback: any EOA can call the crank — useful as a manual backstop and for incentive experiments in v1.1 (see TRD §16 #3).
- The crank reads `block.timestamp` directly; there is no off-chain signed payload, so keepers don't need DAO permissions or signed authorizations.

## 7. Events (full table in `docs/EVENTS.md`)

| Event | Trigger | Indexed |
|---|---|---|
| `RecipientAdded(payee, token, amount, description)` | `addRecipient` | `payee`, `token` |
| `RecipientRemoved(payee)` | `removeRecipient` | `payee` |
| `RecipientAmountUpdated(payee, old, new)` | `setAmount` | `payee` |
| `RecipientDescriptionSet(payee, oldDescription, newDescription)` | `setRecipientDescription`, and once per `addRecipient` with a non-empty description? — *no, see note*; this event covers post-creation edits | `payee` |
| `PayDayUpdated(old, new)` | `setPayDayOfMonth` | — |
| `PayrollExecuted(period, count, failureMap)` | `executePayroll` / `executePayrollPage` (once per batch/page) | `period` |
| `PayrollPeriodCompleted(period)` | final page of a period (period locks) | `period` |
| `KeeperBountyConfigured(token, perCrank, maxPerPeriod)` | `setKeeperBounty` | `token` |
| `KeeperBountyPaid(keeper, token, amount, period)` | successful bounty leg on a crank | `keeper`, `token`, `period` |
| `ForcePeriodPaid(period)` | `executeForcePayPeriod` (skipped-month recovery) | `period` |
| `MaxRecipientsUpdated(oldMax, newMax)` | `setMaxRecipients` | — |

> The recipient's free-form `description` is set at creation (carried in
> `RecipientAdded`) and edited later via `setRecipientDescription` (which
> emits `RecipientDescriptionSet(payee, oldDescription, newDescription)`).
> Indexers should treat the most recent of these two as the current label.

## 8. Storage layout (UUPS upgrade safety)

Layout snapshot at the current head is at `docs/storage-layouts/PayrollPlugin.md` (regenerate via `forge inspect PayrollPlugin storage-layout`). Plugin-specific state starts at slot **301** (after the inherited gap chain):

```
slot 301: _recipients (Recipient[])
slot 302: indexOfPayee (mapping)
slot 303: payDayOfMonth (uint8)
slot 304: lastPayoutPeriod (uint256)
slot 305: _cursorPeriod (uint256)   — pagination cursor's period
slot 306: _payoutCursor (uint256)   — next recipient index to resume from
slot 307: bountyToken (address)     — added with v1.1 keeper-bounty extension
slot 308: bountyPerCrank (uint256)
slot 309: bountyMaxPerPeriod (uint256)
slot 310: _bountyPaidThisPeriod (uint256)
slot 311: _bountyAccumPeriod (uint256)
slot 312: _maxRecipients (uint256)   — added with the MAX_RECIPIENTS storage migration (initializeV2)
slot 313: _transferHelper (address)  — added by audit remediation (M-04 SafeERC20 helper)
slot 314: forcePaidPeriod (mapping)  — added by audit remediation (M-02 force-pay guard)
slot 315..351: __gap[37]
```

All additions are **append-only**: slots 301..312 are untouched, so existing instances upgrade safely (verified — the `forge inspect` snapshot in `docs/storage-layouts/PayrollPlugin.md` shows `payDayOfMonth` still at 303, `_maxRecipients` still at 312). The audit-remediation slots 313/314 were taken from `__gap` (`__gap[39]` → `__gap[37]`). Instances installed before the helper slot existed run `initializeV3()` (`reinitializer(3)`) once — atomically with the upgrade — to deploy the per-instance `SafeTransferHelper`; it is permissionless and idempotent (writes only when the slot is zero). Upgrades may consume further `__gap` slots but must **never** reorder or shrink slots 301..314. The snapshot is committed per release tag so audit can diff layouts across versions.

## 9. Slither audit notes (waivers)

`slither src/plugins/payroll/` produces these findings; each is reviewed and accepted:

| Finding | Location | Disposition |
|---|---|---|
| `uninitialized-local` on `count` / `j` | _runPayroll, allActiveRecipients, previewForcePayPeriodActions | False positive. The counters default to 0 in Solidity; this is the idiomatic pattern for a write cursor into a freshly-allocated memory array. |
| `unused-return` on `IExecutor.execute` first return / `timestampToDate` day field | _runPayroll, previewForcePayPeriodActions | Intentional. `_runPayroll` needs only `failureMap` (the `execResults bytes[]` is irrelevant); `previewForcePayPeriodActions` needs only `(year, month)` to derive the period and ignores `day`. |
| `reentrancy-events` (event after external call) | _runPayroll | Accepted in our trust model. The only external call is to our own DAO; the cursor / `lastPayoutPeriod` are advanced BEFORE the `execute` (effects-before-interactions), so re-entry through any recipient cannot re-pay a page (a reentrant crank reads the already-advanced cursor / would revert `AlreadyPaidThisPeriod`). |
| `timestamp` (block.timestamp comparison) | _runPayroll, previewForcePayPeriodActions | Design intent. Monthly payroll (and the skipped-month recovery) is by definition timestamp-driven. Miner timestamp jitter (±15s) cannot reorder calendar months at our granularity. |
| `naming-convention` on `_dao` / `_payDayOfMonth` / `__gap` | various | Intentional. Matches OSx's project-wide convention of leading-underscore for function parameters and double-underscore for inherited gaps (per OpenZeppelin's upgradeable storage_gaps guide). `MAX_RECIPIENTS` is uppercase per Solidity style. |
| `unused-state` on `__gap` | PayrollPlugin | Intentional. Reserves slots for future upgrades without breaking the storage layout (OZ upgrade-safety pattern). |
| `incorrect-equality` on period strict-equality | `_runPayroll` (`_cursorPeriod == currentPeriod`), `_calcBountyAmount` (`_bountyAccumPeriod == currentPeriod`) | Intentional. The comparison is against a discrete uint period counter (a `year*12+month` index), not a wall-clock timestamp. Period identity *is* the semantic check ("did the cursor land on this exact month?"); a `>=` would be wrong because the cursor must reset when the period rolls over. The detector flags strict equality as a timestamp-jitter risk, which doesn't apply to a calendar period number. |
| `missing-zero-check` on `token` param | `setAmount` / `addRecipient` | Accepted. `address(0)` is the documented sentinel for native ETH (TRD §6.1); the zero-address branch is the intended ETH code path, not a missing check. |
| `cyclomatic-complexity` on `_runPayroll` / `_settlePage` | `_runPayroll`, `_settlePage` | Accepted. The crank aggregates page collection, the mandatory-salary / failable-bounty split, bounty bookkeeping, and the cursor advance; settlement is split into `_settlePage` to stay under the stack-slot limit without `via-ir`, preserving the effects-before-interactions ordering the `reentrancy-events` waiver depends on. |

CI gate: `slither --fail-high`. None of the above are high-severity; this list updates if the implementation changes.

## 10. Tests

- Unit: `test/plugins/payroll/PayrollPlugin.unit.test.ts` — incl. the `executePayrollPage` pagination suite, `setMaxRecipients`, `previewForcePayPeriodActions`, and the `initializeV2` upgrade-migration suite. ≥90% coverage on `src/plugins/payroll/**`.
- Fork: `test/plugins/payroll/PayrollPlugin.fork.test.ts` — real-USDC salary, 3-month skip scenario, the H-01 mandatory-salary revert (a reverting payee aborts the whole crank), `executeForcePayPeriod` recovery, and a **gas benchmark** for a full 100-recipient ERC20 page (~6.66M gas / 200 actions). Runs on `mainnetFork` / `baseFork` when `RPC_MAINNET` / `RPC_BASE` are set (gated via `onlyOn(...)`).
- Governance e2e: `test/e2e/CustomDaoBootstrap.fork.test.ts` — `setMaxRecipients` + `setMaxEntries` through a real TokenVoting create→vote→execute round-trip.
- Permission matrix: `test/plugins/PluginSetup.unit.test.ts` — asserts `prepareInstallation` returns the TRD §9 set verbatim.
