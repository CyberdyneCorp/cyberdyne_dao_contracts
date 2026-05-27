# Event reference

Source of truth for every event the three plugins emit, plus the UI surface (custom UI per [TRD §3a](TRD.md#3a-frontend--ux-policy-custom-ui-only), toy frontend per [TRD §3b](TRD.md#3b-toy-frontend-in-repo-devtest-tool)) and subgraph entity it feeds.

Signatures freeze at **P1**. Any change after P5 (bootstrap) is breaking for the UI and subgraph and requires a coordinated bump.

---

## Convention

- `indexed` parameters are filterable in the subgraph and via `eth_getLogs` topic queries.
- `period` in payroll events is the packed integer `year * 12 + month` (so May 2026 = `24317`).
- `failureMap` is a bit-set: bit `i` = action `i` reverted (allowed via `allowFailureMap`).

---

## UniswapV4Plugin

| Event | Signature | Indexed | Subgraph entity | UI surface |
|---|---|---|---|---|
| `SwapExecuted` | `(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOutActual)` | `tokenIn`, `tokenOut` | `Swap` | DAO overview → Swap history; Proposal detail (post-execute audit) |
| `AllowedTokenSet` | `(address token, bool allowed)` | `token` | `TokenAllowlistEntry` (mutable) | Admin/inspector: trade allowlist |
| `UniversalRouterUpdated` | `(address previous, address current)` | `previous`, `current` | `RouterMigration` | Inspector: router-history banner |

**OSx-emitted siblings consumed alongside:**
- `IExecutor.Executed` — emitted by the DAO when the plugin runs the 3-action approve/route/revoke batch. The UI links `Executed.callId` → the originating `SwapExecuted` via the deterministic call-id scheme defined in TRD §6.1.

---

## AaveLendingPlugin

| Event | Signature | Indexed | Subgraph entity | UI surface |
|---|---|---|---|---|
| `Supplied` | `(address asset, uint256 amount)` | `asset` | `LendingAction(kind=SUPPLY)` | Lending positions screen |
| `Withdrawn` | `(address asset, uint256 amount, uint256 received)` | `asset` | `LendingAction(kind=WITHDRAW)` | Lending positions screen |
| `Borrowed` | `(address asset, uint256 amount, uint256 interestRateMode)` | `asset` | `LendingAction(kind=BORROW)` | Lending positions screen + health-factor banner |
| `Repaid` | `(address asset, uint256 amount, uint256 interestRateMode, uint256 paid)` | `asset` | `LendingAction(kind=REPAY)` | Lending positions screen |
| `AdapterUpdated` | `(address previous, address current)` | `previous`, `current` | `AdapterMigration` | Inspector: v3↔v4 migration history |
| `AllowedAssetSet` | `(address asset, bool allowed)` | `asset` | `AssetAllowlistEntry` (mutable) | Admin/inspector: asset allowlist |

**Read-side joins:** the UI fetches `aToken` + variable-/stable-debt balances directly from the AAVE protocol contracts on each refresh (they're held by the DAO, not derivable from events alone). Health factor is read via `Pool.getUserAccountData(dao)`.

---

## PayrollPlugin

| Event | Signature | Indexed | Subgraph entity | UI surface |
|---|---|---|---|---|
| `RecipientAdded` | `(address payee, address token, uint256 amount)` | `payee`, `token` | `PayrollRecipient` (created) | Payroll schedule screen |
| `RecipientRemoved` | `(address payee)` | `payee` | `PayrollRecipient` (active=false) | Payroll schedule screen |
| `RecipientAmountUpdated` | `(address payee, uint256 oldAmount, uint256 newAmount)` | `payee` | `PayrollRecipient` (amount updated) + `RecipientAmountChange` history | Payroll schedule screen + per-recipient history drawer |
| `PayDayUpdated` | `(uint8 oldDay, uint8 newDay)` | — | `PayrollConfig` (mutable singleton) | Payroll schedule screen — next-payout countdown |
| `PayrollExecuted` | `(uint256 period, uint256 recipientCount, uint256 failureMap)` | `period` | `PayrollPayout` (per batch) + N×`PayrollPayoutItem` (one per recipient, `failed` derived from `failureMap`) | Payroll schedule screen → per-month execution log |
| `PayrollPeriodCompleted` | `(uint256 period)` | `period` | marks the `period`'s payout as complete (final page) | Payroll execution log — "period closed" marker |

> **Pagination note:** a large payroll fires `PayrollExecuted` **once per page** (not once per period); `recipientCount` and `failureMap` are page-local — bit `i` of `failureMap` is the `i`-th recipient *of that page*. Aggregate batches by `period`, and treat `PayrollPeriodCompleted(period)` as the "period fully paid" signal. A payroll that fits one page fires a single `PayrollExecuted` followed by `PayrollPeriodCompleted`, identical to the v1 single-batch shape plus the completion marker.

**Read-side joins:** `PayrollPlugin.allActiveRecipients()` is the canonical single-RPC fetch for the schedule screen (TRD §3a calls this out — view sized for one round-trip per UI screen).

---

## OSx framework events the UI also consumes

These are emitted by OSx core, not our plugins, but every screen depends on them and the subgraph must index them. Listed here to keep the contract surface complete in one place.

| Source | Event | UI surface |
|---|---|---|
| `DAO` (OSx core) | `Executed` | Proposal detail — links proposal → resulting on-chain actions |
| `DAO` (OSx core) | `Deposited`, `NativeTokenDeposited` | DAO overview — treasury inflows |
| `TokenVoting` (existing plugin, see TRD §6.4) | `ProposalCreated`, `VoteCast`, `ProposalExecuted` | Proposal list + detail |
| `PluginRepoRegistry` (OSx framework) | `PluginRepoRegistered` | Inspector — plugin versioning |

---

## Open items (lock before P5)

- [ ] **Call-id scheme** for `IExecutor.Executed`: pluggable per plugin. Uniswap uses `keccak256("UNI_V4_SWAP:" || hint)`, Payroll uses `keccak256("PAYROLL:" || period || ":" || pageStart)` (the page-start index keeps each page's call-id distinct within a period). Confirm final canonical hashes with the UI team before P5 freezes them in event traces.
- [ ] **Subgraph schema review** with UI team — every entity name + field name in the "Subgraph entity" column above is provisional until reviewed against P7 mocks.
- [ ] **Health-factor read pattern** — confirm whether we surface health factor only on Borrow events or on every refresh; affects subgraph denormalization vs. UI RPC load.
