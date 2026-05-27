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
- Recipient management (`addRecipient` / `removeRecipient` / `setAmount` / `setPayDayOfMonth` / `setMaxRecipients`) is vote-gated through the DAO.
- `setMaxRecipients(newMax)` raises/lowers the recipient-slot cap (`MAX_RECIPIENTS()`, default 300), bounded above by the hard `MAX_RECIPIENTS_CEILING` (1000) and below by the live slot count — lets a DAO grow past 300 without a plugin upgrade.
- The monthly crank is **permissionless** — anyone can call it. Idempotent within a month.
  - `executePayroll()` — pays the whole period in one batch (for payrolls up to one page).
  - `executePayrollPage(maxCount)` — pays the period across multiple cursor-tracked pages for large payrolls (see §3a).
- `previewForcePayPeriodActions(period)` — vote-gated **recovery** for a month the crank skipped. A *view* returning the DAO→payee transfer batch for every active recipient; a proposal carries those actions and TokenVoting executes them top-level. `period` (`year*12+month`) must be strictly between `lastPayoutPeriod` and now and ≤ `MAX_FORCE_BACK_MONTHS` (12) back. See §2 for why this is a preview helper, not a wrapper.
- **Native ETH payees are supported** — pass `token = address(0)` to `addRecipient`. The crank builds a value-bearing `Action` (`to: payee, value: amount, data: ""`) which the DAO executes as a native transfer. Mixed ETH + ERC20 batches in the same period are routine; the unit test `pays mixed ETH + ERC20 recipients in one crank` covers the path.

## 2. Trust + custody model

- Plugin holds **no funds**. All ETH and ERC20 lives in the DAO.
- Plugin is granted `EXECUTE_PERMISSION` on the DAO so its monthly crank can issue `IExecutor.execute(callId, actions, allowFailureMap)` to move treasury funds to payees.
- The crank is the only `executePayroll` call site; the DAO is the only call site for management functions (gated by `MANAGE_PAYROLL_PERMISSION`).
- Plugin upgrades require `UPGRADE_PLUGIN_PERMISSION` on the plugin, granted only to the DAO. UUPS via `_authorizeUpgrade` inherited from `PluginUUPSUpgradeable`.

> **`preview…Actions` only for the recovery path.** Payroll's *recurring* fund-moving entry point (`executePayroll`) is **permissionless** (keeper-callable), not governance-routed — so it never participates in the nested-`dao.execute` reentrancy issue that motivated [TRD §9a](../TRD.md#9a-governance-path-action-builders-previewactions). Schedule mutators (`addRecipient`, `setMaxRecipients`, …) are single-action plugin calls and ride through TokenVoting as a one-action proposal directly. The **one** governance-routed fund move — the skipped-month recovery — is therefore exposed as `previewForcePayPeriodActions` (a view returning the transfer batch) rather than an `auth`-gated wrapper that calls `dao.execute` itself: such a wrapper would nest `dao.execute` inside the proposal's `dao.execute` and revert under OSx's `nonReentrant`, exactly like the swap/lending/LP fund ops.

### Upgrade migration (`initializeV2`)

`MAX_RECIPIENTS()` is a storage value (default 300) set in `initialize`. For an instance **upgraded** from a build where it was a `constant`, the new `_maxRecipients` slot reads 0 (it was `__gap`), which would make `addRecipient` revert `RecipientLimitExceeded(0)`. `initializeV2()` (`reinitializer(2)`) seeds the default once; run it atomically with the upgrade (`upgradeToAndCall(newImpl, abi.encodeCall(PayrollPlugin.initializeV2, ()))`). It is permissionless and idempotent (writes only when zero), so a forgotten call can still be repaired afterward. Fresh installs set the cap in `initialize` and never need it.

### Keeper bounty

`setKeeperBounty(token, perCrank, maxPerPeriod)` (gated by `UPDATE_BOUNTY_PERMISSION`) pays `msg.sender` a small bounty out of the DAO treasury on each successful crank, so Gelato / Chainlink Automation / random keepers have an economic incentive to call `executePayroll(Page)` on high-gas days.

- `token = address(0)` pays a native ETH bounty; an ERC20 address pays that token instead.
- `perCrank` is the amount paid per `_runPayroll` invocation (one for `executePayroll`, one per page for `executePayrollPage`).
- `maxPerPeriod` is a per-period rolling cap so paginated cranks within one month share one budget. The bounty for any single crank is clipped to the remaining cap (or 0 if exhausted).
- Bounty is set to 0 by default (disabled) — installs unchanged.
- The bounty is appended to the same `dao.execute` batch as the recipient transfers with `allowFailureMap` set, so if the bounty leg fails (e.g. DAO is out of the bounty token) the recipients are still paid.
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
- **Mid-period edits.** Recipients added after the cursor are picked up by later pages; recipients soft-deleted before the cursor reaches them are skipped. A tail of only-inactive slots completes the period without emitting a payment batch.
- **No back-pay still holds.** Only the current due period is ever processed; `executePayrollPage` reverts `AlreadyPaidThisPeriod` once the period is complete and `PageSizeZero` on `maxCount == 0`.

## 4. Per-recipient failure tolerance

- Each call to the crank builds an `Action[]` of length `count` = active recipients **in this batch/page**.
- `allowFailureMap = (1 << count) - 1` — every bit is set, so any single transfer may fail without aborting the others.
- The DAO returns a `failureMap` bitmap; bit `i` set means action `i` reverted. The plugin emits `PayrollExecuted(period, count, failureMap)` per batch — the bitmap is **page-local** (bit `i` = the `i`-th recipient of that page, not of the period).
- The cursor / `lastPayoutPeriod` are updated **before** the external `execute` (effects-before-interactions), so a recipient that reenters cannot re-pay the same page. A failed recipient waits until next month for another attempt (vs. immediate retry).

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
| `PayrollExecuted(period, count, failureMap)` | `executePayroll` / `executePayrollPage` (once per batch/page) | `period` |
| `PayrollPeriodCompleted(period)` | final page of a period (period locks) | `period` |

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
slot 312..351: __gap[40]
```

The two cursor words were appended in slots 305/306 (consuming two slots from the former `__gap[47]`, now `__gap[45]`) — append-only, so slots 301..304 are untouched. Upgrades may consume further slots from `__gap` (decreasing the gap size) but must **never** reorder or shrink anything in slots 301..306. The `forge inspect` snapshot is committed under `docs/storage-layouts/` per release tag so audit can diff layouts across versions.

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

CI gate: `slither --fail-high`. None of the above are high-severity; this list updates if the implementation changes.

## 10. Tests

- Unit: `test/plugins/payroll/PayrollPlugin.unit.test.ts` — incl. the `executePayrollPage` pagination suite, `setMaxRecipients`, `previewForcePayPeriodActions`, and the `initializeV2` upgrade-migration suite. ≥90% coverage on `src/plugins/payroll/**`.
- Fork: `test/plugins/payroll/PayrollPlugin.fork.test.ts` — real-USDC salary, 3-month skip scenario, per-recipient failure tolerance, and `previewForcePayPeriodActions` recovery. Runs on `mainnetFork` / `baseFork` when `RPC_MAINNET` / `RPC_BASE` are set (gated via `onlyOn(...)`).
- Governance e2e: `test/e2e/CustomDaoBootstrap.fork.test.ts` — `setMaxRecipients` + `setMaxEntries` through a real TokenVoting create→vote→execute round-trip.
- Permission matrix: `test/plugins/PluginSetup.unit.test.ts` — asserts `prepareInstallation` returns the TRD §9 set verbatim.
