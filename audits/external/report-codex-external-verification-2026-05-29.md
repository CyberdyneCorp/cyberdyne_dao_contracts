# Cyberdyne DAO Plugins - External Verification Report

Date: 2026-05-29  
Verifier: Codex acting as an external smart-contract verification reviewer  
Repository path reviewed: `/Users/leonardoaraujo/work/cyberdyne_dao_contracts`  
Commit reviewed: `342a9cb8d9ed2b4555c7458bad5d7fcd754dc7d4`

## Executive Summary

This report covers the external-verifier pass requested for the Cyberdyne DAO custom Aragon OSx plugins. The review followed the scope in `audits/external/SCOPE.md`, including all five plugin families, setup contracts, adapters, condition contracts, and deployment-script wiring that is exercised by the test suite.

Overall, the codebase is mature for an internal pre-audit state: custody is consistently kept in the DAO, privileged operations are permission-gated, setup permission grants are tested, coverage is high, and invariant tests exercise the core no-custody model.

However, I do **not** issue a clean external approval for mainnet readiness. One Medium severity issue remains in the UniswapV4 plugin's allowance lifecycle. Four plugins had no new code findings in this pass.

## Scope

In scope:

- `src/plugins/payroll/**`
- `src/plugins/cost-registry/**`
- `src/plugins/aave/**`
- `src/plugins/uniswap-v3/**`
- `src/plugins/uniswap-v4/**`
- Relevant plugin setup contracts
- Relevant deployment and permission wiring as covered by tests and audit artifacts

Out of scope:

- Aragon OSx core
- OpenZeppelin libraries
- Uniswap, Permit2, and Aave protocol internals
- Frontend, subgraph, and generated ABI artifacts

## Methodology

The verification included:

- Manual review of all plugin implementation contracts for custody, authorization, external-call, allowance, reentrancy, and upgrade-safety risks.
- Review of setup-contract permission grants and uninstall/update behavior through tests and existing audit artifacts.
- Review of existing Slither, storage-layout, coverage, function/event, and test-quality artifacts in `audits/internal/`.
- Local build and test execution.
- Findings classification using Critical / High / Medium / Low / Informational.

## Tests Performed

Commands executed locally:

| Command | Result |
|---|---|
| `forge build` | Passed |
| `npx hardhat test --grep '^(?!.*\\[fork\\])'` | Passed, 225 tests |
| `FOUNDRY_PROFILE=ci forge test --match-path 'test/invariants/*.t.sol' -vv` | Passed, 25 invariant tests |
| `node scripts/check-coverage.js` | Passed, all enforced plugin paths >= 90% |

Notes:

- Hardhat warned that local Node.js `v23.11.0` is unsupported.
- Foundry compilation passed, but the sandbox prevented writing the Foundry signature cache outside the workspace.
- Fork tests were not rerun in this pass because configured fork RPCs were not available in the execution environment. Existing fork-test artifacts and documentation were reviewed, but final release verification should rerun fork tests against the frozen commit.

## Findings Summary

| ID | Severity | Title | Status |
|---|---|---|---|
| M-01 | Medium | UniswapV4 Permit2 allowances rely on full external consumption instead of explicit cleanup | Open |
| I-01 | Informational | UniswapV4 endpoint zero-address acceptance is inconsistent with checklist expectations | Open / policy decision |

No Critical or High severity findings were identified in this pass.

## Findings

### M-01: UniswapV4 Permit2 allowances rely on full external consumption instead of explicit cleanup

**Severity:** Medium  
**Affected component:** `UniswapV4Plugin`  
**Locations:**

- `src/plugins/uniswap-v4/UniswapV4Plugin.sol:155`
- `src/plugins/uniswap-v4/UniswapV4Plugin.sol:385`

#### Description

The V4 swap flow approves `amountIn` from the DAO to Permit2, grants Permit2 allowance to the Universal Router, and then executes opaque proposal-supplied router calldata. The LP flow similarly grants Permit2 allowance to the v4 PositionManager.

The current design relies on the external router or PositionManager consuming the full approved amount. Existing tests cover exact-consumption routes, but the plugin accepts opaque payloads and does not enforce full allowance consumption for every possible supported Uniswap command shape.

#### Impact

If a route consumes less than the approved amount, or a proposal uses a max-input payload where less than `amountIn` / `maxIn` is spent, residual approval can remain after the operation. The ERC20 allowance to Permit2 or the internal Permit2 allowance to the router / PositionManager may remain usable until expiration or explicit overwrite.

This creates unnecessary exposure for DAO treasury tokens and weakens the documented invariant that the V4 flow leaves no residual Permit2 allowance.

#### Recommendation

Add explicit cleanup to the V4 action batches:

1. After swaps, reset DAO -> Permit2 ERC20 allowance for `tokenIn` to `0`.
2. After swaps, reset Permit2 internal allowance for `(tokenIn, universalRouter)` to `0`.
3. After LP operations, reset DAO -> Permit2 ERC20 allowance for each input currency to `0`.
4. After LP operations, reset Permit2 internal allowance for each `(currency, v4PositionManager)` pair to `0`.
5. Add tests where mocks deliberately consume only part of `amountIn` / `maxIn`, then assert both ERC20 and Permit2-layer allowances end at zero.

#### Suggested Remediation Plan

1. Extend `IPermit2` if needed so cleanup calls can encode `approve(token, spender, 0, expiration)`.
2. Modify `_buildSwapActions` from 3 actions to include post-router cleanup actions.
3. Modify `_buildLpActions` so every input currency has both Permit2-layer cleanup and ERC20 cleanup after `modifyLiquidities`.
4. Update `MockPermit2` so tests can query internal allowance state and verify cleanup.
5. Add regression tests for partial-consumption swap and partial-consumption LP paths.
6. Rerun unit tests, invariants, coverage gate, and fork tests.

### I-01: UniswapV4 endpoint zero-address acceptance is inconsistent with checklist expectations

**Severity:** Informational  
**Affected component:** `UniswapV4Plugin`  
**Locations:**

- `src/plugins/uniswap-v4/UniswapV4Plugin.sol:81`
- `src/plugins/uniswap-v4/UniswapV4Plugin.sol:192`
- `src/plugins/uniswap-v4/UniswapV4Plugin.sol:216`

#### Description

The V4 plugin allows zero addresses for some external endpoint configuration. This is partially documented as accepted behavior, especially for `v4PositionManager` at initialization when LP operations are intentionally deferred. However, the internal checklist expects zero-address validation, and the equivalent migration setters in other plugins generally reject zero operational endpoints.

#### Impact

This is primarily a configuration and operational-safety risk. A governance vote could accidentally set an endpoint to `address(0)`, bricking a V4 path until a later corrective vote.

#### Recommendation

- Continue allowing `v4PositionManager == address(0)` at initialization only if deferred LP activation is required.
- Reject `address(0)` in `setV4PositionManager`.
- Reject zero `universalRouter`, `permit2`, and `poolManager` at initialization unless explicitly accepted as a governance policy.
- Reject zero `newRouter` in `setUniversalRouter`.

## Plugin Assessments

### PayrollPlugin

No new code finding.

The plugin follows a no-custody model. Recipient management is vote-gated, payroll execution is permissionless but schedule-bound, and state is advanced before external DAO execution. Pagination and keeper-bounty limits are covered by unit and invariant tests.

### CostRegistryPlugin

No new code finding.

The plugin uses vote-gated registry management and permissionless processing for due entries. `lastPaidAt` is updated before external execution, preventing repeated payment of the same due entry through reentrancy. Missed periods do not stack.

### AaveLendingPlugin

No new code finding.

The plugin keeps Aave receipts and debts on the DAO via `onBehalfOf = dao()`. Repay includes allowance cleanup. The adapter model isolates Aave version changes, and `BorrowHealthCondition` adds a meaningful liquidation-risk guard for borrow operations.

### UniswapV3Plugin

No new code finding.

The V3 plugin forces NFT mint and fee-collection recipients to the DAO. Token-consuming operations include explicit approval reset actions. Position manager migration is vote-gated and zero-address checked.

### UniswapV4Plugin

One Medium and one Informational finding.

The plugin has useful controls: permission gates, allowlist enforcement, deadline checks, balance-delta slippage checks, and `MINT_POSITION` owner validation. The remaining concern is incomplete defensive allowance cleanup for opaque external Uniswap payloads.

## Trust Model Confirmation

The reviewed implementation is consistent with the stated trust model:

- The DAO is the treasury custodian.
- Plugins are orchestration layers and should not custody tokens, ETH, or NFTs.
- Privileged actions are intended to be governance-controlled through Aragon OSx permissions.
- Payroll and CostRegistry permissionless functions execute only previously configured schedules.
- Third-party protocol internals are outside this review, but integration correctness is in scope.

Accepted risks from `audits/external/SCOPE.md` were reviewed. I agree with most accepted-risk classifications, except that the UniswapV4 allowance-cleanup assumption should be remediated or more narrowly documented before mainnet readiness.

## Final Verdict

Status: **Not approved for mainnet release yet.**

The plugin suite is close, but the UniswapV4 allowance lifecycle issue should be fixed or explicitly accepted with route constraints and regression tests. After remediation, the project should rerun:

1. `forge build`
2. `npx hardhat test --grep '^(?!.*\\[fork\\])'`
3. `FOUNDRY_PROFILE=ci forge test --match-path 'test/invariants/*.t.sol' -vv`
4. `node scripts/check-coverage.js`
5. Fork tests on configured `mainnetFork` and `baseFork`

Final P9 closure should also wait for the required human sign-offs under `docs/reviews/`.
