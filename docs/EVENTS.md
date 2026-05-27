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
| `V4PositionManagerUpdated` | `(address previous, address current)` | `previous`, `current` | `V4PositionManagerMigration` | Inspector: PM-history banner |
| `LiquidityModified` | `(uint256 opNonce)` | `opNonce` | `V4LpOp` (created) | Positions screen → V4 LP history |

**OSx-emitted siblings consumed alongside:**
- `IExecutor.Executed` — emitted by the DAO when the plugin runs an action batch. The UI links `Executed.callId` → the originating `SwapExecuted` (callId scheme `keccak256("UNI_V4_SWAP:" || swapNonce)`) or `LiquidityModified` (callId scheme `keccak256("UNI_V4_LP:" || lpNonce)`) — separate nonces keep swap and LP histories distinct.

**Read-side joins:** V4 LP `LiquidityModified` carries only `opNonce`; for the position NFTs themselves the UI reads `IV4PositionManager` directly (tokenId, owner, range, liquidity) — same pattern as the V3 surface.

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

## UniswapV3Plugin

| Event | Signature | Indexed | Subgraph entity | UI surface |
|---|---|---|---|---|
| `PositionMinted` | `(uint256 tokenId, address token0, address token1, uint24 fee, uint128 liquidity, uint256 amount0, uint256 amount1)` | `tokenId`, `token0`, `token1` | `V3Position` (created) | Positions screen |
| `LiquidityIncreased` | `(uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)` | `tokenId` | `V3Position` (liquidity++) | Positions screen |
| `LiquidityDecreased` | `(uint256 tokenId, uint128 liquidity)` | `tokenId` | `V3Position` (liquidity--) | Positions screen |
| `FeesCollected` | `(uint256 tokenId, uint256 amount0, uint256 amount1)` | `tokenId` | `V3Collect` | Positions screen — fee history |
| `PositionBurned` | `(uint256 tokenId)` | `tokenId` | `V3Position` (closed) | Positions screen |
| `PositionManagerUpdated` | `(address previous, address current)` | `previous`, `current` | `V3ManagerMigration` | Inspector |
| `AllowedTokenSet` | `(address token, bool allowed)` | `token` | `V3TokenAllowlistEntry` (mutable) | Admin/inspector |

**Read-side joins:** live position state (liquidity, ticks, tokensOwed) is read from `NonfungiblePositionManager.positions(tokenId)`; the DAO owns the NFTs.

**OSx-emitted siblings consumed alongside:** `IExecutor.Executed` is emitted by the DAO when the plugin runs an action batch. Call-id schemes are `keccak256("UNI_V3_MINT:" || lpNonce)`, `UNI_V3_INC:`, `UNI_V3_DEC:`, `UNI_V3_COLLECT:`, `UNI_V3_BURN:` — same per-op nonce family as V4 LP.

**Governance path:** every fund-moving op also ships a `previewXActions(...) view returns (Action[])` helper (see [TRD §9a](TRD.md#9a-governance-path-action-builders-previewactions)) so multi-action proposals can submit the raw batch directly without nested `dao.execute`.

---

## PayrollPlugin

| Event | Signature | Indexed | Subgraph entity | UI surface |
|---|---|---|---|---|
| `RecipientAdded` | `(address payee, address token, uint256 amount)` | `payee`, `token` | `PayrollRecipient` (created) | Payroll schedule screen |
| `RecipientRemoved` | `(address payee)` | `payee` | `PayrollRecipient` (active=false) | Payroll schedule screen |
| `RecipientAmountUpdated` | `(address payee, uint256 oldAmount, uint256 newAmount)` | `payee` | `PayrollRecipient` (amount updated) + `RecipientAmountChange` history | Payroll schedule screen + per-recipient history drawer |
| `PayDayUpdated` | `(uint8 oldDay, uint8 newDay)` | — | `PayrollConfig` (mutable singleton) | Payroll schedule screen — next-payout countdown |
| `MaxRecipientsUpdated` | `(uint256 oldMax, uint256 newMax)` | — | `PayrollConfig` (`maxRecipients` field) | Payroll admin: recipient-cap config |
| `PayrollExecuted` | `(uint256 period, uint256 recipientCount, uint256 failureMap)` | `period` | `PayrollPayout` (per batch) + N×`PayrollPayoutItem` (one per recipient, `failed` derived from `failureMap`) | Payroll schedule screen → per-month execution log |
| `PayrollPeriodCompleted` | `(uint256 period)` | `period` | marks the `period`'s payout as complete (final page) | Payroll execution log — "period closed" marker |
| `KeeperBountyConfigured` | `(address token, uint256 perCrank, uint256 maxPerPeriod)` | `token` | `PayrollConfig` (bounty fields) | Payroll admin: keeper-bounty config |
| `KeeperBountyPaid` | `(address keeper, address token, uint256 amount, uint256 period)` | `keeper`, `token`, `period` | `KeeperBountyPayment` | Payroll execution log — bounty line |

> **Pagination note:** a large payroll fires `PayrollExecuted` **once per page** (not once per period); `recipientCount` and `failureMap` are page-local — bit `i` of `failureMap` is the `i`-th recipient *of that page*. Aggregate batches by `period`, and treat `PayrollPeriodCompleted(period)` as the "period fully paid" signal. A payroll that fits one page fires a single `PayrollExecuted` followed by `PayrollPeriodCompleted`, identical to the v1 single-batch shape plus the completion marker.

**Read-side joins:** `PayrollPlugin.allActiveRecipients()` is the canonical single-RPC fetch for the schedule screen (TRD §3a calls this out — view sized for one round-trip per UI screen).

---

## CostRegistryPlugin

| Event | Signature | Indexed | Subgraph entity | UI surface |
|---|---|---|---|---|
| `EntryRegistered` | `(uint256 id, address payee, uint256 costUsdc, uint32 frequencyDays, string name)` | `id`, `payee` | `CostEntry` (created) | Operating-costs screen |
| `EntryUpdated` | `(uint256 id, address payee, uint256 costUsdc, uint32 frequencyDays)` | `id`, `payee` | `CostEntry` (fields updated) | Operating-costs screen |
| `EntryRemoved` | `(uint256 id)` | `id` | `CostEntry` (active=false) | Operating-costs screen |
| `CostPaid` | `(uint256 id, address payee, uint256 amount, uint64 paidAt)` | `id`, `payee` | `CostPayment` (one per paid entry) | Per-entry payment history |
| `CostsProcessed` | `(uint256 fromIndex, uint256 count, uint256 failureMap)` | — | `CostCrankRun` (per batch) | Crank log |
| `PaymentTokenUpdated` | `(address previous, address current)` | `previous`, `current` | `PaymentTokenMigration` + `CostRegistryPlugin.paymentToken` | Inspector: token-migration history |
| `MaxEntriesUpdated` | `(uint256 oldMax, uint256 newMax)` | — | `CostRegistryConfig` (`maxEntries` field) | Cost-registry admin: entry-cap config |

> **Pagination note:** `processDue(offset, limit)` (and the offset-free `processAllDue()` convenience wrapper) fire `CostPaid` per paid entry and one `CostsProcessed` per batch. `failureMap` is page-local — bit `i` = the `i`-th paid entry of that batch reverted. Entries are idempotent per their own `lastPaidAt`, so there is no period/cursor to aggregate (unlike Payroll).

**Read-side joins:** `CostRegistryPlugin.getEntries(offset, limit)` returns a page of entries plus the total count, sized for the operating-costs screen.

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
