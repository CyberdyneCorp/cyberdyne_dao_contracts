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
| 1 | Plugin custody leak (ETH or ERC20) | Plugin has no `receive()`/`fallback()`; every flow routes through `DAO.execute`. | `invariant_pluginHoldsNoEth`, `invariant_pluginHoldsNoToken*` across all 3 plugins (50k sequences in CI) | Code review |
| 2 | Reentrancy via external protocol callback | OSx `DAO.execute` is `nonReentrant`. Plugins do not re-enter the DAO mid-execution. | Slither's `reentrancy-*` detectors triaged in `docs/plugins/*.md §9` | TRD §11 |
| 3 | Slippage on swaps | `UniswapV4Plugin.swap` requires `balanceAfter - balanceBefore >= minAmountOut`. Proposal payload is required to set `minAmountOut`. | `UniswapV4Plugin.unit.test.ts` "slippage" cases; fork test slippage breach | Per-proposal review (set `minAmountOut` ≥ realistic floor) |
| 4 | Stale allowance to Permit2 after swap | Approval is exact (`amountIn`, not `type(uint256).max`); Permit2 settles full amount in one call. | `invariant_zeroResidualPermit2Allowance` (Uniswap invariants) | TRD §11 |
| 5 | Stale allowance to AAVE pool after `repay` | `repay` batch has 3 actions: approve exact, repay, **approve 0** (defense for AAVE's cap-at-debt behavior). | `invariant_zeroResidualPoolAllowance` (AAVE invariants). **This invariant caught a real bug** during P8 — the original 2-action batch left residual when `amount > outstandingDebt`. | TRD §11 |
| 6 | Payroll double-pay in same month | `lastPayoutPeriod = currentPeriod` set BEFORE event emit; subsequent crank reverts `AlreadyPaidThisPeriod`. | `invariant_lastPayoutPeriodMonotonic`; unit test "AlreadyPaidThisPeriod on second crank" | TRD §6.3 |
| 7 | Payroll back-pay attack | Crank always pays current period only; no loop over missed months. Missed = skipped permanently. | Unit + fork test: "skips missed months — no back-pay" | TRD §6.3 |
| 8 | Payroll recipient gas griefing (one bad payee blocks all) | `allowFailureMap = (1 << n) - 1`; per-action failures recorded in `failureMap`, others still get paid. | Unit + fork test: "per-recipient failure tolerance" with reverting recipient contract | TRD §6.3 |
| 9 | Payroll runaway recipient list (gas-OOF on crank) | `MAX_RECIPIENTS = 100` cap; `addRecipient` reverts at the boundary. | `invariant_recipientCountBounded`; unit test "MAX_RECIPIENTS reached" | TRD §11 |
| 10 | Payroll calendar miscalculation (Feb 29, 30/31, DST) | `payDayOfMonth` restricted to 1..28 at init and `setPayDayOfMonth`; year/month derived from `BokkyPooBahsDateTimeLibrary.timestampToDate` (Howard Hinnant's algorithm). | Unit test 3-month time travel; fork test 3-month time travel | Code review of vendored lib |
| 11 | AAVE over-borrow → liquidation | v1: documentation + proposal review. v1.1: `BorrowHealthCondition` attached via `grantWithCondition` enforces post-borrow health factor automatically. | Per-proposal review; planned `BorrowHealthCondition` (ROADMAP P13 #1) | TRD §6.2 |
| 12 | AAVE adapter swap to malicious adapter | `setAdapter` requires `UPDATE_ADAPTER_PERMISSION` (vote-gated). Adapter address is verified pre-vote. | Permission matrix asserted in `PluginSetup.unit.test.ts` + `CustomDaoBootstrap.fork.test.ts` | Per-migration review |
| 13 | Plugin upgrade hijack | `UPGRADE_PLUGIN_PERMISSION` granted only to DAO. UUPS `_authorizeUpgrade` inherited from `PluginUUPSUpgradeable` (OSx, audited). | Permission matrix tests; storage layout pinned in `docs/storage-layouts/*.md` per release | Per-upgrade review |
| 14 | Uniswap Universal Router redeploy / drift | `setUniversalRouter` is the vote-gated migration path. CI fork tests pin to a block + verified router address. | Fork test verifies real router address; `UniswapV4Plugin.unit.test.ts` exercises `UniversalRouterUpdated` | TRD §16 #2 |
| 15 | Subdomain collision on `PluginRepoRegistry` | Bootstrap script suffixes subdomains with `block.timestamp` so re-runs don't collide. Real deploys use deterministic subdomains chosen pre-ceremony. | `DeployCyberdyneDao.s.sol` `_uniqueSubdomain` helper | Per-deploy review |
| 16 | TRD §9 permission matrix drift between code and spec | Every `prepareInstallation` return is statically asserted against the §9 set in `PluginSetup.unit.test.ts` (4 tests). E2E test re-checks the SAME matrix against the live `PermissionManager` post-bootstrap on the fork. | `PluginSetup.unit.test.ts`; `CustomDaoBootstrap.fork.test.ts` `invariant_permissionMatrix` | TRD §9 itself |
| 17 | OSx `ProtocolVersion` drift (audit boundary moves under us) | Bootstrap test asserts `DAOFactory.protocolVersion() == [1, 4, 0]` before continuing. Fails fast on a new OSx release. | `CustomDaoBootstrap.fork.test.ts` first assertion | Per-OSx-bump review |
| 18 | Vendored date library tampering | `lib/BokkyPooBahsDateTimeLibrary.sol` is minimal (~30 LOC), inline, attributed (MIT). Excluded from coverage gate (3rd-party). | Excluded from `.solcover.js`; reviewed once at vendoring; never re-vendored without an audit notes update | Initial vendor + future updates |
| 19 | Deploy script ENV var injection (e.g., malicious `TOKEN_VOTING_DATA`) | Deploy operator is trusted (burner deployer wallet, drained post-ceremony per TRD §15). Inputs validated by OSx PluginSetupProcessor at install time. | OSx framework checks; deploy ceremony review | Per-deploy review |
| 20 | Static analysis regressions | CI runs `slither --fail-high` on every PR. Existing info/low findings triaged in `docs/plugins/*.md §9`. | CI `slither` job | Audit |

---

## 4. Invariants summary (mechanically enforced)

Run with `forge test --match-test invariant`. CI runs 1000 × 50 = 50,000 sequences per the ROADMAP P8 exit criterion.

| Plugin | Invariant | Asserts |
|---|---|---|
| Payroll | `invariant_pluginHoldsNoToken` | `IERC20(token).balanceOf(plugin) == 0` |
| Payroll | `invariant_pluginHoldsNoEth` | `plugin.balance == 0` |
| Payroll | `invariant_lastPayoutPeriodMonotonic` | `plugin.lastPayoutPeriod >= ghostPrev` |
| Payroll | `invariant_recipientCountBounded` | `recipientCount <= MAX_RECIPIENTS` |
| UniswapV4 | `invariant_pluginHoldsNoTokenIn` / `NoTokenOut` / `NoEth` | Plugin holds no input, output, or ETH |
| UniswapV4 | `invariant_zeroResidualPermit2Allowance` | `tokenIn.allowance(dao, permit2) == 0` |
| UniswapV4 | `invariant_swapNonceMonotonic` | `swapNonce >= ghostPrev` |
| AAVE | `invariant_pluginHoldsNoAsset` / `NoEth` | Plugin holds no asset or ETH |
| AAVE | `invariant_zeroResidualPoolAllowance` | `asset.allowance(dao, pool) == 0` |
| AAVE | `invariant_opNonceMonotonic` | `opNonce >= ghostPrev` |

---

## 5. Open issues / planned hardening

| Item | Phase | Notes |
|---|---|---|
| `BorrowHealthCondition` enforcing post-borrow health factor | v1.1 (ROADMAP P13 #1) | Removes reliance on proposal review for over-borrow protection |
| Keeper bounty on `executePayroll` | v1.1 (ROADMAP P13 #2) | Economic incentive so Gelato/Chainlink/anyone runs the crank on time |
| Paginated payroll for >100 recipients | v1.1 (ROADMAP P13 #3) | `executePayroll(start, count)` with per-page idempotency |
| AAVE v4 adapter (live `AaveV4Adapter` replacing P4-stub) | v1.1 (ROADMAP P13 #4) | Vote `setAdapter(newAddress)` migration; storage layout already supports it |
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
