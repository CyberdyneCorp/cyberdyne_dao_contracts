# External Audit — Remediation Summary

Remediates every finding tracked in
[issue #3](https://github.com/CyberdyneCorp/cyberdyne_dao_contracts/issues/3)
(external verification pass `report-codex-external-verification-2026-05-29.md`,
pinned to `v0.9.0-rc1` / `342a9cb`), **including the `CostRegistryPlugin`
findings the auditor's report missed** (CR-\*).

Every fix ships with a regression test that fails if the vulnerable behaviour is
reintroduced. Tests are tagged by finding ID in their title (e.g. `H-01:`,
`M-01:`, `CR-M-02:`).

## Cross-cutting change — `SafeTransferHelper`

`src/common/SafeTransferHelper.sol` is a new stateless, custody-free shim. The
low-level OSx executor ignores a call's return data, so a token that returns
`false` without reverting was booked as a *successful* payment. Plugins now route
every ERC20 payout as a two-action pair executed **as the DAO**:
`token.approve(helper, amount)` then `helper.safeTransfer(token, payee, amount)`,
which uses `SafeERC20.safeTransferFrom` and reverts on a false/again-compliant
return. The helper never holds funds (it pulls caller→payee in one
`transferFrom`) and grants no authority (it can only move tokens the caller
already approved). Each plugin instance deploys its own helper in `initialize`
(and via a new `initializeV3` reinitializer for upgrades). This resolves **M-04**
and **CR-M-01 / M-06**.

## PayrollPlugin

| ID | Fix | Location | Regression test |
|---|---|---|---|
| H-01 | Salary actions are mandatory: their `allowFailureMap` bits are cleared, so any failed transfer reverts the whole batch and rolls back the period/cursor state. | `_runPayroll` / `_settlePage` | `H-01: one failing salary reverts the whole crank` |
| H-02 | Bounty is the only failable action; `KeeperBountyPaid` is emitted **only** when the bounty action's bit is clear in the returned `failureMap`. | `_settlePage` | covered by H-01 + L-01 bounty tests |
| M-02 | New stateful `executeForcePayPeriod` records `forcePaidPeriod[period]` atomically with the transfer batch; the preview view also reverts once a period is force-paid. | `executeForcePayPeriod`, `_buildForcePayActions` | `M-02: executeForcePayPeriod settles a skipped month exactly once` |
| M-03 | Recipient-set / amount mutations revert `PayrollMidPagination` while a paginated period is mid-flight. | `_requireNotMidPagination` | `M-03: recipient mutations are frozen mid-pagination` |
| M-04 | ERC20 payouts routed through `SafeTransferHelper`. | `_appendTransfer` | `M-04: a false-returning ERC20 reverts the crank` |
| L-01 | Bounty is awarded only on a full page or the period's final page, so tiny-page bounty farming is impossible. | `_settlePage` | `L-01: a small page earns no bounty; the final page pays` |
| L-02 | New `reactivateRecipient` reuses a soft-deleted slot. | `reactivateRecipient` | `L-02: a removed recipient can be reactivated` |
| L-03 | Single-pass crank scans the tail for active recipients; a page whose remaining tail is all soft-deleted completes the period instead of reverting. | `_hasActiveFrom` | `L-03: a single page whose tail is all soft-deleted completes` |
| L-04 | `setKeeperBounty` rejects an enabled config whose cap can't fund one crank; bounty events are success-aware (H-02). | `setKeeperBounty` | `L-04: setKeeperBounty rejects an enabled config the cap can't fund` |

## CostRegistryPlugin (report-missed CR-\*)

| ID | Fix | Location | Regression test |
|---|---|---|---|
| CR-H-01 / H-03 | `_processDue` runs with `allowFailureMap = 0`; `lastPaidAt` is written before the call so a failed transfer reverts the batch and rolls every clock back — no entry is marked paid for a payment that didn't happen. | `_processDue` | `H-03: an underfunded batch reverts entirely` |
| CR-M-01 / M-06 | Payments routed through `SafeTransferHelper`. | `_processDue` | `CR-M-01/M-06: a false-returning token reverts the batch` |
| CR-M-02 / M-07 | `setPaymentToken` rejects a token whose `decimals()` differs from the current one, preventing silent re-pricing of stored raw amounts. | `setPaymentToken` | `CR-M-02/M-07: setPaymentToken rejects a token with different decimals` |
| CR-L-01 / M-05 | `CostPaid` is emitted after a successful batch only (resolved by the `allowFailureMap = 0` model). | `_processDue` | covered by `H-03` |
| CR-L-02 / L-05 | `processAllDue` reverts `RegistryExceedsSinglePage` when the registry has more than one page of slots, so a partial run can't pass for a full sweep. | `processAllDue` | `CR-L-02/L-05: processAllDue reverts when the registry exceeds one page` |
| CR-L-03 / L-06 | New `processDueFromCursor` round-robins a persistent page cursor, giving keepers reliable coverage of large registries. | `processDueFromCursor`, `_dueCursor` | `CR-L-03/L-06: processDueFromCursor round-robins across pages` |
| CR-I-01 | `initializeV2` / `initializeV3` documented as intentionally permissionless-but-idempotent (seed fixed defaults only). | `initializeV2`, `initializeV3` | `CR-I-01: initializeV3 is permissionless but idempotent` |
| CR-I-02 | Duplicate `(payee, name)` entries documented as intentionally allowed (vendors bill multiple recurring lines). | `registerEntry` natspec | `CR-I-02: duplicate (payee, name) entries are intentionally allowed` |

## UniswapV4Plugin

| ID | Fix | Location | Regression test |
|---|---|---|---|
| M-01 | Swap batch grows 3→5 actions and the LP batch 3n+1→4n+1: both the DAO→Permit2 ERC20 allowance and the Permit2-internal allowance are reset to zero after the external call, even on partial consumption. | `_buildSwapActions`, `_buildLpActions` | `M-01: PARTIAL-consumption swap still cleans up both allowance layers`; `M-01` LP layer assertions; invariant `invariant_zeroResidualPermit2Allowance` |
| I-01 | Zero `universalRouter` / `permit2` / `poolManager` rejected at init; zero `newRouter` / `newPositionManager` rejected in setters. Zero `v4PositionManager` still allowed at init only. | `initialize`, `setUniversalRouter`, `setV4PositionManager` | `I-01:` init + setter tests |

## Verification

| Command | Result |
|---|---|
| `forge build` | ✅ |
| `npx hardhat test --grep '^(?!.*\[fork\])'` | ✅ 245 passing |
| `FOUNDRY_PROFILE=ci forge test --match-path 'test/invariants/*.t.sol'` | ✅ 25 invariants, 50k sequences |
| `node scripts/check-coverage.js` | ✅ all enforced plugin paths ≥ 90% on every metric |
| `hardhat test *.fork.test.ts --network mainnetFork` | ✅ 35 passing, 0 failing (fresh anvil fork) |

The mainnet fork run exercises the fixes against live protocol contracts —
notably M-01 against the real Universal Router + Permit2 ("leaves zero leftover
allowance … after a successful swap"), and H-01 / H-03 against real ETH / USDC.
`baseFork` was not re-run here (its suites self-gate to that network and the
report already notes a stale Base USDC whale); it should be refreshed and run
before the final RC tag, per the report's Final Verdict.
