# Threat Model — Cyberdyne DAO Contracts

| | |
|---|---|
| Audience | Internal review + external audit |
| Scope | `src/plugins/**` + `scripts/**` (this repo only) |
| Out of scope | Aragon OSx core (Halborn audit Jan 2025), Uniswap V4 / Universal Router / Permit2, AAVE v3 Pool |
| Last updated | 2026-05-26 |

Read this together with TRD §11 (Security considerations) — that section is the design intent; this document is the structured enumeration auditors should expect to see.

---

## 1. Assets

| Asset | Custody | Threat if lost |
|---|---|---|
| **ETH** in DAO treasury | DAO contract (OSx core, audited) | Direct theft from misrouted `Action.value` |
| **ERC20s** in DAO treasury (USDC, WETH, governance token, …) | DAO contract | Direct theft via malicious approval / transfer |
| **aTokens** (interest-bearing AAVE receipts) | DAO contract (`onBehalfOf = dao`) | Inability to redeem; opaque to non-AAVE-aware UIs |
| **Variable / stable debt tokens** (AAVE) | DAO contract | Liability — DAO owes; liquidation if collateral ratio collapses |
| **Governance token** voting power | Distributed across holders (issued by TokenVoting's GovernanceERC20) | Concentration / hostile takeover of governance |
| **Permission grants** (`PermissionManager` state on DAO) | DAO contract | Hijack of plugin authorization → arbitrary `dao.execute` |
| **Plugin storage** (recipient list, allowlists, adapter pointers) | Each plugin's UUPS proxy | Untargeted: would require an `UPGRADE_PLUGIN_PERMISSION` compromise to mutate maliciously |

**Custody invariant** (per TRD §6 spec, mechanically enforced by `test/invariants/*.t.sol`):
> Every plugin always satisfies `IERC20(anyToken).balanceOf(plugin) == 0 && address(plugin).balance == 0`. Funds flow DAO → external → DAO; the plugin only orchestrates `Action[]` batches.

---

## 2. Trust boundaries

```
                    EOAs (proposers, voters, keepers)
                                  │
                                  ▼
                       ┌────────────────────┐
                       │   TokenVoting       │  ◄── governance proposals
                       │   (existing OSx     │       (create / vote / execute)
                       │   plugin, audited)  │
                       └─────────┬──────────┘
                                 │ EXECUTE
                                 ▼
                       ┌────────────────────┐
                       │      DAO            │  ◄── PermissionManager
                       │    (OSx core,       │       sole custodian
                       │    Halborn audit)   │
                       └─────────┬──────────┘
                                 │ EXECUTE (granted to each plugin at install)
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
      ┌───────────────┐   ┌────────────┐   ┌────────────┐
      │ UniswapV4     │   │  AAVE       │   │ Payroll     │
      │ Plugin        │   │  Lending    │   │  Plugin     │
      │ (this repo)   │   │  Plugin     │   │ (this repo) │
      │               │   │ (this repo) │   │             │
      └───────┬───────┘   └──────┬─────┘   └──────┬──────┘
              │                  │ via adapter    │ permissionless
              │                  │                │ executePayroll
              ▼                  ▼                ▼
      Universal Router    AAVE v3 Pool      ERC20.transfer
        + Permit2          (external,        DAO → payee
      (external,           audited)          (DAO funds, plugin-built batch)
      audited)
```

**Vote-gated surfaces** (caller MUST come through DAO.execute, gated by a domain permission):
- `UniswapV4Plugin.swap`, `setUniversalRouter`, `setAllowedToken`
- `AaveLendingPlugin.{supply, withdraw, borrow, repay}`, `setAdapter`, `setAllowedAsset`
- `PayrollPlugin.{addRecipient, removeRecipient, setAmount, setPayDayOfMonth}`
- UUPS `_authorizeUpgrade` for all three (caller needs `UPGRADE_PLUGIN_PERMISSION`)

**Permissionless surfaces** (anyone can call):
- `PayrollPlugin.executePayroll()` — the monthly crank. Authorization comes from the schedule it executes (which was itself voted in), not from the caller.

**External calls** (plugins → these protocols; trust depends on the protocol):
- DAO → ERC20.approve / transfer (low risk — token standard)
- Plugin → DAO.execute (high trust, audited)
- DAO → Universal Router (Uniswap audited; commands/inputs are proposal-supplied)
- DAO → Permit2 (Uniswap audited)
- DAO → AAVE v3 Pool via adapter (AAVE audited; adapter is our code)

---

## 3. Per-attack-vector mitigations

The table extends TRD §11 with the concrete tests/invariants that catch each vector. "Caught by" columns mark mechanical enforcement; "Reviewed in" means human review per release.

| # | Vector | Mitigation | Caught by | Reviewed in |
|---|---|---|---|---|
| 1 | Plugin custody leak (ETH or ERC20) | Plugin has no `receive()`/`fallback()`; every flow routes through `DAO.execute`. | `invariant_pluginHoldsNoEth`, `invariant_pluginHoldsNoToken*` across all 5 plugins (50k sequences in CI) | Code review |
| 2 | Reentrancy via external protocol callback | OSx `DAO.execute` is `nonReentrant`. Plugins do not re-enter the DAO mid-execution. | Slither's `reentrancy-*` detectors triaged in `docs/plugins/*.md §9` | TRD §11 |
| 3 | Slippage on swaps | `UniswapV4Plugin.swap` requires `balanceAfter - balanceBefore >= minAmountOut`. Proposal payload is required to set `minAmountOut`. | `UniswapV4Plugin.unit.test.ts` "slippage" cases; fork test slippage breach | Per-proposal review (set `minAmountOut` ≥ realistic floor) |
| 4 | Stale allowance to Permit2 after swap | Approval is exact (`amountIn`, not `type(uint256).max`); Permit2 settles full amount in one call. | `invariant_zeroResidualPermit2Allowance` (Uniswap invariants) | TRD §11 |
| 5 | Stale allowance to AAVE pool after `repay` | `repay` batch has 3 actions: approve exact, repay, **approve 0** (defense for AAVE's cap-at-debt behavior). | `invariant_zeroResidualPoolAllowance` (AAVE invariants). **This invariant caught a real bug** during P8 — the original 2-action batch left residual when `amount > outstandingDebt`. | TRD §11 |
| 6 | Payroll double-pay in same month | `lastPayoutPeriod = currentPeriod` set BEFORE event emit; subsequent crank reverts `AlreadyPaidThisPeriod`. | `invariant_lastPayoutPeriodMonotonic`; unit test "AlreadyPaidThisPeriod on second crank" | TRD §6.3 |
| 7 | Payroll back-pay attack | Crank always pays current period only; no loop over missed months. Missed = skipped permanently. | Unit + fork test: "skips missed months — no back-pay" | TRD §6.3 |
| 8 | Payroll period marked paid while salaries silently fail (audit **H-01/H-02**) | Salary transfers are **mandatory**: batch runs with `allowFailureMap = 0`, so any failed/false-returning transfer reverts the whole crank and rolls back `lastPayoutPeriod` — a period is never settled unless every salary paid. ERC20 legs route through a SafeERC20 helper (**M-04**). Only the keeper-bounty leg is failable, with a success-aware event. Trade-off: a deliberately-reverting payee can block its own crank (a liveness, not accounting, issue) — governance removes/reactivates it; the period simply stays open to retry. | Unit + fork: "H-01: one failing salary reverts the whole crank", "M-04: false-returning ERC20 reverts the crank" | TRD §6.3 |
| 9 | Payroll runaway recipient list (gas-OOF on crank) | `MAX_RECIPIENTS = 300` total-slot cap (`addRecipient` reverts at the boundary); each crank pays at most `MAX_RECIPIENTS_PER_PAGE = 100` via `executePayrollPage` so a single tx stays within OSx's 256-action / 256-bit-failure-map limit. | `invariant_recipientCountBounded`; unit tests "MAX_RECIPIENTS reached" + pagination | TRD §11 |
| 10 | Payroll calendar miscalculation (Feb 29, 30/31, DST) | `payDayOfMonth` restricted to 1..28 at init and `setPayDayOfMonth`; year/month derived from `BokkyPooBahsDateTimeLibrary.timestampToDate` (Howard Hinnant's algorithm). | Unit test 3-month time travel; fork test 3-month time travel | Code review of vendored lib |
| 11 | AAVE over-borrow → liquidation | v1: documentation + proposal review. v1.1: `BorrowHealthCondition` attached via `grantWithCondition` enforces post-borrow health factor automatically. | Per-proposal review; planned `BorrowHealthCondition` (ROADMAP P13 #1) | TRD §6.2 |
| 12 | AAVE adapter swap to malicious adapter | `setAdapter` requires `UPDATE_ADAPTER_PERMISSION` (vote-gated). Adapter address is verified pre-vote. | Permission matrix asserted in `PluginSetup.unit.test.ts` + `CustomDaoBootstrap.fork.test.ts` | Per-migration review |
| 13 | Plugin upgrade hijack | `UPGRADE_PLUGIN_PERMISSION` granted only to DAO. UUPS `_authorizeUpgrade` inherited from `PluginUUPSUpgradeable` (OSx, audited). | Permission matrix tests; storage layout pinned in `docs/storage-layouts/*.md` per release | Per-upgrade review |
| 14 | Uniswap Universal Router redeploy / drift | `setUniversalRouter` is the vote-gated migration path. CI fork tests pin to a block + verified router address. | Fork test verifies real router address; `UniswapV4Plugin.unit.test.ts` exercises `UniversalRouterUpdated` | TRD §16 #2 |
| 15 | Subdomain collision on `PluginRepoRegistry` | Bootstrap script suffixes subdomains with `block.timestamp` so re-runs don't collide. Real deploys use deterministic subdomains chosen pre-ceremony. | `DeployCyberdyneDao.s.sol` `_uniqueSubdomain` helper | Per-deploy review |
| 16 | TRD §9 permission matrix drift between code and spec | Every `prepareInstallation` return is statically asserted against the §9 set in `PluginSetup.unit.test.ts` (one grant-set test per plugin + an uninstall-inverse test). E2E test re-checks the SAME matrix against the live `PermissionManager` post-bootstrap on the fork. | `PluginSetup.unit.test.ts`; `CustomDaoBootstrap.fork.test.ts` `invariant_permissionMatrix` | TRD §9 itself |
| 17 | OSx `ProtocolVersion` drift (audit boundary moves under us) | Bootstrap test asserts `DAOFactory.protocolVersion() == [1, 4, 0]` before continuing. Fails fast on a new OSx release. | `CustomDaoBootstrap.fork.test.ts` first assertion | Per-OSx-bump review |
| 18 | Vendored date library tampering | `lib/BokkyPooBahsDateTimeLibrary.sol` is minimal (~30 LOC), inline, attributed (MIT). Excluded from coverage gate (3rd-party). | Excluded from `.solcover.js`; reviewed once at vendoring; never re-vendored without an audit notes update | Initial vendor + future updates |
| 19 | Deploy script ENV var injection (e.g., malicious `TOKEN_VOTING_DATA`) | Deploy operator is trusted (burner deployer wallet, drained post-ceremony per TRD §15). Inputs validated by OSx PluginSetupProcessor at install time. | OSx framework checks; deploy ceremony review | Per-deploy review |
| 20 | Static analysis regressions | CI runs `slither --fail-high` on every PR. Existing info/low findings triaged in `docs/plugins/*.md §9`. | CI `slither` job | Audit |
| 21 | V4 LP position minted to a non-DAO owner | `UniswapV4Plugin` decodes the v4 action stream and reverts `MintRecipientMustBeDao(owner, dao)` if any `MINT_POSITION` carries `owner != dao()`. Enforced in both `modifyLiquidities` and the governance preview path; empty payloads revert `UnlockDataTooShort`. | `UniswapV4Plugin.unit.test.ts` (good/bad owner, empty payload, preview path) + live-fork mint + owner-revert tests | Code review (closes the prior proposal-review-only gap) |
| 22 | V3 LP position / fees routed away from the DAO | `mint` forces `recipient = dao()`; `collect` forces `recipient = dao()`. The DAO owns the NFT so decrease/collect/burn need no extra approval. | `UniswapV3Plugin.unit.test.ts` custody cases + 6 live-fork lifecycle tests | TRD §6 |
| 23 | CostRegistry treasury-drain via typo'd cost | `costUsdc` capped at `MAX_COST_USDC = 1e15` (= $1B at 6dp) — an unintended extra zero trips `CostTooLarge` rather than pre-staging a drain behind a passed proposal. | `CostRegistryPlugin.unit.test.ts` "MAX_COST_USDC at MAX + 1" | Defense-in-depth (vote-gated regardless) |
| 24 | CostRegistry payment-token migration silently re-prices entries (audit **CR-M-02**) | `costUsdc` is raw token units, so a decimals change would re-price every entry. `setPaymentToken` now **reverts `PaymentTokenDecimalsMismatch`** unless the new token's `decimals()` matches the current one — a same-decimals swap is allowed; cross-decimals requires a plugin upgrade that rescales atomically. Still vote-gated (`UPDATE_PAYMENT_TOKEN_PERMISSION`). | `CostRegistryPlugin.unit.test.ts` "CR-M-02/M-07: setPaymentToken rejects a token with different decimals" | TRD §6 |
| 25 | CostRegistry entry marked paid while transfer silently fails (audit **CR-H-01/CR-M-01**) | Crank runs with `allowFailureMap = 0` and writes `lastPaidAt` before the call, so any failed/false-returning transfer reverts the batch and rolls back the clock — no entry is marked paid for a payment that didn't happen, and `CostPaid` fires only on full success. ERC20 routes through the SafeERC20 helper. | `CostRegistryPlugin.unit.test.ts` "H-03: an underfunded batch reverts entirely", "CR-M-01/M-06: a false-returning token reverts" | TRD §6 |
| 25 | Keeper-bounty budget drain | `setKeeperBounty` is vote-gated; per-crank bounty is clipped to a per-period rolling cap (`maxPerPeriod`) reserved BEFORE the external call, so spamming paginated cranks can't exceed the cap. Default disabled. | `PayrollPlugin.unit.test.ts` bounty cases (rolling cap clip, cap resets) | TRD §16 #3 |

---

## 4. Invariants summary (mechanically enforced)

Run with `forge test --match-test invariant`. CI runs 1000 × 50 = 50,000 sequences per the ROADMAP P8 exit criterion. **25 invariants across 5 plugins.**

| Plugin | Invariant | Asserts |
|---|---|---|
| Payroll | `invariant_pluginHoldsNoToken` | `IERC20(token).balanceOf(plugin) == 0` |
| Payroll | `invariant_pluginHoldsNoEth` | `plugin.balance == 0` |
| Payroll | `invariant_lastPayoutPeriodMonotonic` | `plugin.lastPayoutPeriod >= ghostPrev` |
| Payroll | `invariant_recipientCountBounded` | `recipientCount <= MAX_RECIPIENTS` |
| UniswapV4 | `invariant_pluginHoldsNoTokenIn` / `NoTokenOut` / `NoEth` | Plugin holds no input, output, or ETH (across swap + LP paths) |
| UniswapV4 | `invariant_zeroResidualPermit2Allowance` | `tokenIn.allowance(dao, permit2) == 0` |
| UniswapV4 | `invariant_swapNonceMonotonic` | `swapNonce >= ghostPrev` |
| UniswapV4 | `invariant_lpNonceMonotonic` | `lpNonce >= ghostPrev` (independent of `swapNonce`) |
| UniswapV3 | `invariant_pluginHoldsNoToken*` / `NoEth` | Plugin holds no token0/token1/ETH/NFTs |
| UniswapV3 | `invariant_zeroResidualAllowance` | no residual DAO→NPM allowance |
| UniswapV3 | `invariant_opNonceMonotonic` | `_opNonce >= ghostPrev` |
| AAVE | `invariant_pluginHoldsNoAsset` / `NoEth` | Plugin holds no asset or ETH |
| AAVE | `invariant_zeroResidualPoolAllowance` | `asset.allowance(dao, pool) == 0` |
| AAVE | `invariant_opNonceMonotonic` | `opNonce >= ghostPrev` |
| CostRegistry | `invariant_pluginHoldsNoToken` / `NoEth` | Plugin holds no payment token or ETH |
| CostRegistry | `invariant_entryCountBounded` | `entryCount <= MAX_ENTRIES` |
| CostRegistry | `invariant_lastPaidNeverInFuture` | no entry's `lastPaidAt` is in the future |

---

## 5. Open issues / planned hardening

**Shipped in the v1.1 hardening pass** (ROADMAP P13 — see that doc for the full ticked list): keeper bounty on the payroll crank (capped, vote-gated); paginated payroll (`executePayrollPage`, `MAX_RECIPIENTS_PER_PAGE = 100`); on-chain V4 `MINT_POSITION` recipient enforcement; CostRegistry `MAX_COST_USDC` cap + vote-gated `setPaymentToken`; live V4-LP + expanded V3 fork tests; full subgraph indexing.

| Item | Phase | Notes |
|---|---|---|
| `BorrowHealthCondition` enforcing post-borrow health factor | v1.1+ (ROADMAP P13 🔒) | Removes reliance on proposal review for over-borrow protection. Still planned. |
| AAVE v4 adapter (live `AaveV4Adapter` replacing P4-stub) | v1.1+ (ROADMAP P13 🔒) | Vote `setAdapter(newAddress)` migration; storage layout already supports it. Blocked on AAVE v4 mainnet launch. |
| DAO sub-treasuries (child DAOs with capped budgets) | v1.1+ (ROADMAP P13 🔒) | Multi-PR; own sub-roadmap. |
| Mythril sweep + Echidna properties | Optional addition to P8 | Foundry invariants give overlapping coverage; can defer to external audit |
| Real TokenVoting integration in e2e | P11 (testnet) | Currently DAO ROOT-impersonated for the proposal-execution surface; full vote→execute lands when per-chain TokenVoting repo address is verified live |

---

## 6. Out-of-scope acceptances

We rely on these dependencies being secure; their compromise is out of scope for this repo's review.

- **Aragon OSx 1.4.0 core** (Halborn audit, `audits/Halborn_AragonOSx_v1_4_Smart_Contract_Security_Assessment_Report_2025_01_03.pdf`).
- **OpenZeppelin contracts** at the v4.9.6 commit pinned in `lib/openzeppelin-contracts*`.
- **Uniswap V4 PoolManager**, **Universal Router**, **Permit2** (Uniswap Labs audits).
- **AAVE v3 Pool** (BGD Labs + multiple audits).
- **BokkyPooBahsDateTimeLibrary** (Howard Hinnant's algorithm; minimal vendored subset).

A compromise of any of these would propagate; mitigation in those cases is patching upstream, not this repo.
