# Cyberdyne DAO — External Audit Scope

> Scope-of-work letter for the external security audit (ROADMAP **Phase 9**). Hand this to the audit firm (Halborn / Trail of Bits) together with read access to the repository at the frozen tag below.

| | |
|---|---|
| Project | Cyberdyne DAO — custom Aragon OSx plugins |
| Repository | `CyberdyneCorp/cyberdyne_dao_contracts` |
| Audited tag | **`v0.9.0-rc1`** _(frozen; record exact SHA on engagement start)_ |
| Compiler | `solc 0.8.17`, `optimizer = true`, `optimizer_runs = 2000` (identical to Aragon OSx 1.4.0 audited bytecode) |
| Frameworks | Foundry (build / invariants) + Hardhat (fork tests, TypeScript) |
| Source-of-truth design doc | [`docs/TRD.md`](../../docs/TRD.md) |
| Threat model | [`docs/THREAT_MODEL.md`](../../docs/THREAT_MODEL.md) |
| Prior internal review | [`audits/internal/`](../internal/) + [`docs/reviews/`](../../docs/reviews/) |

---

## 1. Overview

Cyberdyne DAO is a single DAO deployed on the **audited Aragon OSx 1.4.0 core** (no fork, no patches) with **five custom plugins**. Token-weighted voting gates every privileged action; the DAO itself custodies all funds and all LP NFTs — **plugins never custody assets**. Two plugins (Payroll, Cost Registry) additionally expose **permissionless keeper cranks** that only release funds already approved by a prior vote.

The audit scope is **exactly the five plugins + their setup contracts + the deployment scripts**. Nothing in the Aragon OSx core, OpenZeppelin, or third-party protocol code is in scope.

## 2. In-scope contracts

All paths under `src/plugins/**` and `scripts/**`. Line counts are indicative.

### PayrollPlugin — monthly payroll, permissionless crank
| File | LOC |
|------|----:|
| `src/plugins/payroll/PayrollPlugin.sol` | 490 |
| `src/plugins/payroll/IPayrollPlugin.sol` | 238 |
| `src/plugins/payroll/PayrollPluginSetup.sol` | 123 |
| `src/plugins/payroll/lib/BokkyPooBahsDateTimeLibrary.sol` | 51 (vendored MIT — verify byte-parity w/ upstream) |

### UniswapV4Plugin — vote-gated swaps + V4 LP lifecycle
| File | LOC |
|------|----:|
| `src/plugins/uniswap-v4/UniswapV4Plugin.sol` | 415 |
| `src/plugins/uniswap-v4/UniswapV4PluginSetup.sol` | 166 |
| `src/plugins/uniswap-v4/IUniswapV4Plugin.sol` | 163 |
| `src/plugins/uniswap-v4/{IPermit2,IUniversalRouter,IV4PositionManager}.sol` | 9 / 14 / 51 (external ABI shims) |

### UniswapV3Plugin — V3 LP lifecycle via NonfungiblePositionManager
| File | LOC |
|------|----:|
| `src/plugins/uniswap-v3/UniswapV3Plugin.sol` | 373 |
| `src/plugins/uniswap-v3/UniswapV3PluginSetup.sol` | 143 |
| `src/plugins/uniswap-v3/IUniswapV3Plugin.sol` | 137 |
| `src/plugins/uniswap-v3/INonfungiblePositionManager.sol` | 94 (external ABI shim) |

### AaveLendingPlugin — supply/withdraw/borrow/repay via pluggable adapter
| File | LOC |
|------|----:|
| `src/plugins/aave/AaveLendingPlugin.sol` | 253 |
| `src/plugins/aave/AaveLendingPluginSetup.sol` | 137 |
| `src/plugins/aave/conditions/BorrowHealthCondition.sol` | 192 |
| `src/plugins/aave/adapters/AaveV3Adapter.sol` | 92 |
| `src/plugins/aave/adapters/AaveV4Adapter.sol` | 57 (stub — reverts `NotImplemented`) |
| `src/plugins/aave/{IAaveLendingPlugin,adapters/IAaveAdapter,adapters/IAavePool}.sol` | 78 / 61 / 70 |

### CostRegistryPlugin — recurring USDC operating costs, permissionless crank
| File | LOC |
|------|----:|
| `src/plugins/cost-registry/CostRegistryPlugin.sol` | 335 |
| `src/plugins/cost-registry/CostRegistryPluginSetup.sol` | 126 |
| `src/plugins/cost-registry/ICostRegistryPlugin.sol` | 165 |

### Deployment scripts (review for correct permission grants + init params)
`scripts/Deploy{Payroll,UniswapV3,UniswapV4,Aave,CostRegistry,BorrowHealthCondition}Plugin.s.sol`, `scripts/DeployCyberdyneDao.s.sol`.

**Total in-scope: ~4,033 SLOC** (Solidity), of which ~2,058 is plugin implementation logic; the remainder is interfaces and thin external-ABI shims.

## 3. Out of scope

- **Aragon OSx 1.4.0 core** — `DAO`, `PermissionManager`, `DAOFactory`, `PluginSetupProcessor`, `PluginRepo*` (Halborn-audited; consumed as-is, `ProtocolVersion == [1,4,0]`).
- **Aragon TokenVoting + GovernanceERC20** (existing audited plugin, installed unmodified).
- **OpenZeppelin** (`-upgradeable`) and **forge-std** dependencies.
- **Third-party protocol code**: Uniswap Universal Router / V4 PositionManager / V3 NonfungiblePositionManager / Permit2, AAVE v3 Pool. Integration *correctness* is in scope; their internals are not.
- The toy SvelteKit frontend, subgraph, and `frontend-abi/` artifacts (no on-chain trust surface).

## 4. Trust model & privileged roles

- **Token holders** (via TokenVoting → `dao.execute`): the only authority for all config + fund-moving plugin actions. Fund-moving ops use the **`preview…Actions` multi-action pattern** to avoid nested `dao.execute` under OSx's `nonReentrant` guard (see [TRD §9a](../../docs/TRD.md#9a-governance-path-action-builders-previewactions)).
- **Keepers (anyone)**: may call `PayrollPlugin.executePayroll[Page]` and `CostRegistryPlugin.processDue/processAllDue` — these release only funds whose schedule + amount were vote-approved earlier.
- **Governor (the DAO)**: sets `BorrowHealthCondition.minHealthFactor`.
- Permission IDs per plugin are enumerated in [TRD §9](../../docs/TRD.md) and asserted by the E2E permission-matrix test.

## 5. Known issues / accepted risks (please confirm, don't re-report as new)

- `AaveV4Adapter` is an intentional **stub** (`NotImplemented`) — AAVE v4 is not live; the live path is `AaveV3Adapter`, swappable via vote-gated `setAdapter`.
- **Allowlist enforcement is one-way**: the first `setAllowed*(token, true)` flips enforcement on permanently (auditor-requested, to avoid silent un-enforcement). Removing all entries does not disable it.
- `interestRateMode` on borrow/repay is passed through to AAVE unchecked (AAVE validates it).
- `CostRegistryPlugin.setPaymentToken` stores `costUsdc` as raw units — a decimals change must be paired with `updateEntry` calls in the same proposal (documented).
- `block.timestamp` is used for crank scheduling (day-granularity); validator drift is acceptable at this granularity.
- Per-plugin Slither findings are individually waived with justification in [`audits/internal/02-slither.md`](../internal/02-slither.md) — please review the waivers rather than re-filing.

## 6. Test & coverage baseline

- **222 unit specs + ~40 fork specs** (Hardhat, `mainnetFork` + `baseFork`) + **25 Foundry invariants** over 50,000 sequences (`fuzz.runs=1000 × invariant.depth=50`).
- Coverage (CI-gated ≥ 90% lines + branches per plugin; latest in [`audits/internal/03-coverage.md`](../internal/03-coverage.md)):

| Plugin | Lines | Branches |
|--------|------:|---------:|
| PayrollPlugin | 99.38% | 93.97% |
| UniswapV4Plugin | 98.25% | 91.67% |
| UniswapV3Plugin | 95.40% | 90.63% |
| AaveLendingPlugin | 100.00% | 100.00% |
| CostRegistryPlugin | 100.00% | 94.12% |

- Invariant fuzzing already caught and fixed one real allowance bug (AAVE repay dust allowance).

## 7. Build & run

```bash
git clone --recurse-submodules <repo> && cd cyberdyne_dao_contracts
git checkout v0.9.0-rc1
curl -L https://foundry.paradigm.xyz | bash && foundryup
npm install --legacy-peer-deps && just build-package
just test          # unit + fork specs (set RPC_MAINNET/RPC_BASE in .env)
just invariants    # 25 Foundry invariants, 50k sequences
forge build        # solc 0.8.17, optimizer 2000
```

## 8. Requested deliverables

1. Severity-classified findings report (Critical / High / Medium / Low / Informational).
2. Per-finding: location, impact, PoC where applicable, recommended fix.
3. A remediation re-review pass after fixes (ROADMAP P10).
4. Confirmation of the trust model in §4 and the accepted risks in §5.

## 9. Logistics

| | |
|---|---|
| Audit liaison | _TBD_ |
| Comms channel | _TBD (shared Slack / email)_ |
| Target window | ~5 weeks (per ROADMAP P9) |
| Disclosure | Coordinated; report published after P10 remediation + before mainnet (P12) |

_Out-of-scope and accepted-risk sections are provided to focus the engagement; auditors should still flag anything they believe is mis-classified._
