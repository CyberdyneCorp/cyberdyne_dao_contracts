# Cyberdyne DAO — Contracts

On-chain governance for the Cyberdyne DAO, built on top of the audited [Aragon OSx](https://github.com/aragon/osx) protocol with custom plugins for Uniswap V4 trading, AAVE lending, and automated monthly payroll.

> **Status:** Documentation / planning phase. Contracts not yet implemented. See [`docs/TRD.md`](docs/TRD.md) for the full Technical Requirements Document.

---

## TL;DR

- We **do not fork** Aragon OSx. We deploy a single DAO on top of the audited OSx v1.4.0 core (Halborn-audited) and install our own plugins.
- We build **three plugins**: `UniswapV4Plugin`, `AaveLendingPlugin`, `PayrollPlugin`.
- Token-weighted voting gates every privileged action (swaps, lending, payroll changes). The DAO itself holds all funds — plugins never custody.
- Payroll executes **automatically** on a fixed day of the month via a permissionless crank. Adding or removing payroll recipients requires a vote.
- Tooling: **Foundry** for build/deploy, **Hardhat + TypeScript** for tests with mainnet/Base fork mode.
- UX layer: **our own custom UI** (separate repo). The Aragon App is explicitly not a deployment target.

---

## High-level architecture

```mermaid
graph TB
    subgraph User["Token holders"]
        U[Voter / Proposer]
    end

    subgraph DAO["Cyberdyne DAO — OSx v1.4.0 (audited core)"]
        D[("DAO contract<br/>(treasury + executor)")]
        P[PermissionManager]
        D --- P
    end

    subgraph Plugins["Plugins"]
        TV["TokenVoting<br/>(reused from Aragon)"]
        UNI["UniswapV4Plugin<br/>(new)"]
        AAVE["AaveLendingPlugin<br/>(new)"]
        PAY["PayrollPlugin<br/>(new)"]
    end

    subgraph External["External protocols"]
        UR["Uniswap Universal Router<br/>(V4-capable)"]
        AP["AAVE v3 Pool<br/>(v4 via adapter swap)"]
        REC["Payroll recipients<br/>(EOAs / contracts)"]
    end

    U -->|create / vote proposal| TV
    TV -->|"dao.execute(Action[])"| D
    D -->|EXECUTE_PERMISSION| UNI
    D -->|EXECUTE_PERMISSION| AAVE
    D -->|EXECUTE_PERMISSION| PAY
    UNI -->|"dao.execute(approve+swap)"| UR
    AAVE -->|"dao.execute(approve+supply/borrow)"| AP
    PAY -->|"dao.execute(transfers)<br/>auto, monthly"| REC

    classDef audited fill:#d4edda,stroke:#155724,color:#155724
    classDef new fill:#fff3cd,stroke:#856404,color:#856404
    classDef reused fill:#cce5ff,stroke:#004085,color:#004085
    classDef external fill:#f8d7da,stroke:#721c24,color:#721c24
    class D,P audited
    class UNI,AAVE,PAY new
    class TV reused
    class UR,AP,REC external
```

| Color | Meaning |
|---|---|
| Green | Halborn-audited Aragon OSx v1.4.0 — we don't touch it |
| Blue | Existing audited Aragon plugin — we install but don't modify |
| Yellow | New code in this repo — we own and audit it |
| Red | Third-party protocols we integrate with via calldata |

---

## Why Aragon OSx?

Building a DAO from scratch means rebuilding (and re-auditing) treasury custody, permission management, proposal lifecycle, plugin distribution, and upgrade paths. Aragon OSx ships all of that, fully audited, and lets us add only what's unique to our use case.

| Concern | Provided by OSx | We build |
|---|---|---|
| Treasury custody (ETH + ERC20 + NFTs) | `DAO.sol` | — |
| Permission system (grant / revoke / conditions) | `PermissionManager.sol` | — |
| Proposal lifecycle + voting | `aragon/token-voting-plugin` | — |
| Plugin install / update / uninstall | `PluginSetupProcessor` + `PluginRepo` | — |
| Versioned plugin distribution | `PluginRepoFactory` | — |
| Action execution model | `Action{to, value, data}` + `execute(Action[])` | — |
| Uniswap V4 swap gating | — | `UniswapV4Plugin` |
| AAVE lending gating | — | `AaveLendingPlugin` + version adapter |
| Monthly payroll automation | — | `PayrollPlugin` |

**Version pinning:** OSx v1.4.0 audited core (`ProtocolVersion == [1, 4, 0]`). Working tree may be tag v1.5.0 because its core is byte-identical to 1.4.0. No forks, no patches, no custom flavors. See [TRD §3](docs/TRD.md#3-aragon-osx-version-policy).

---

## Plugin overview

### 1. Uniswap V4 Plugin

```mermaid
sequenceDiagram
    actor V as Voter
    participant TV as TokenVoting
    participant D as DAO
    participant UNI as UniswapV4Plugin
    participant UR as Universal Router

    V->>TV: createProposal({to: UNI, data: swap(...)})
    Note over TV: Voting period
    V->>TV: vote()
    V->>TV: execute(proposalId)
    TV->>D: execute([Action(UNI, swap)])
    D->>UNI: swap(commands, inputs, deadline, ...)
    UNI->>D: execute([approve, routerCall])
    D->>UR: approve + execute swap
    UR-->>D: tokenOut transferred to DAO
    UNI->>UNI: verify balanceAfter - balanceBefore ≥ minAmountOut
```

- Every swap requires a passed proposal.
- Plugin builds a 3-action atomic batch (approve → swap → revoke).
- Slippage enforced by post-swap balance delta check inside the plugin.
- Output tokens land directly in the DAO.

### 2. AAVE Lending Plugin

```mermaid
sequenceDiagram
    actor V as Voter
    participant TV as TokenVoting
    participant D as DAO
    participant AAVE as AaveLendingPlugin
    participant ADP as IAaveAdapter
    participant POOL as AAVE Pool

    V->>TV: proposal: supply(USDC, 100k)
    TV->>D: execute
    D->>AAVE: supply(USDC, 100k)
    AAVE->>ADP: poolAddress()
    AAVE->>D: execute([approve(POOL,100k), supply(USDC,100k,DAO)])
    D->>POOL: approve + supply (onBehalfOf=DAO)
    POOL-->>D: mint aUSDC to DAO
```

- v3 today via `AaveV3Adapter`; v4 later via vote to `setAdapter(newAdapter)`.
- `onBehalfOf = DAO` for every call — aTokens and debt tokens always issued to the DAO.
- Supply, withdraw, borrow, repay — each gated by vote.

### 3. Payroll Plugin (auto-execution)

```mermaid
sequenceDiagram
    actor V as Voter
    actor K as Keeper / anyone
    participant TV as TokenVoting
    participant D as DAO
    participant PAY as PayrollPlugin

    rect rgb(230, 240, 255)
        Note over V,PAY: Adding a recipient — VOTE REQUIRED
        V->>TV: proposal: addRecipient(alice, USDC, 5000e6)
        TV->>D: execute
        D->>PAY: addRecipient(...)
    end

    rect rgb(255, 245, 220)
        Note over K,PAY: Monthly payout — PERMISSIONLESS
        K->>PAY: executePayroll()
        PAY->>PAY: check day ≥ payDayOfMonth AND month not paid
        PAY->>D: execute(transfers, allowFailureMap=all)
        D-->>K: PayrollExecuted(period, count, failureMap)
    end
```

- **Vote required** for: adding / removing recipients, changing amounts, changing the pay day.
- **No vote required** for the monthly payout itself — anyone can call `executePayroll()` on or after `payDayOfMonth` once per month.
- Failed individual transfers don't block the rest (per-action `allowFailureMap`).
- `payDayOfMonth` constrained to 1–28 to avoid month-length edge cases.
- Calendar math via vendored BokkyPooBah DateTime library.

---

## Trust & audit boundary

```mermaid
flowchart LR
    subgraph A["Aragon-audited (Halborn 1.4.0)"]
        DAO[DAO.sol]
        PM[PermissionManager]
        DF[DAOFactory]
        PSP[PluginSetupProcessor]
        PR[PluginRepo*]
        TV[TokenVoting + GovernanceERC20]
    end

    subgraph B["Our scope (to be audited)"]
        U[UniswapV4Plugin + Setup]
        L[AaveLendingPlugin + Setup + Adapters]
        P[PayrollPlugin + Setup]
    end

    A -.->|consumed by| B

    style A fill:#d4edda,stroke:#155724
    style B fill:#fff3cd,stroke:#856404
```

Every line of new code in this repo lives in B (yellow). The green side is consumed as-is. Audit scope therefore = ~3 plugins + their setup contracts + the bootstrap script. Nothing more.

---

## Tooling stack

| Layer | Tool | Why |
|---|---|---|
| Solidity build | **Foundry** (`forge`) | Matches OSx upstream (`solc 0.8.17`, `optimizer-runs = 2000`). Fast compile + storage layout. |
| Tests | **Hardhat + TypeScript + ethers v5** | Native fork support (`hardhat_reset`, `hardhat_impersonateAccount`), time travel, mocha/chai matchers from `chai-setup.ts`. |
| Deployment scripts | **Foundry** (`forge script` via `just-foundry`) | Aligned with OSx `DEPLOYMENT.md` convention. |
| Fork engine | **Hardhat Network forking** | One config flips between Ethereum / Base / other supported networks. |
| Type bindings | `@typechain/hardhat` | Generated for both our plugins and Aragon / Uniswap / AAVE ABIs. |
| Coverage | `solidity-coverage` | CI gate ≥ 90 % on new code. |
| Lint / format | `solhint` + `prettier-plugin-solidity` | Same configs as OSx upstream. |

### Fork networks

```mermaid
graph LR
    H["hardhat.config.ts"] --> M["mainnetFork<br/>chainId 1"]
    H --> B["baseFork<br/>chainId 8453"]
    H --> S["sepoliaFork<br/>chainId 11155111"]
    H --> BS["baseSepoliaFork<br/>chainId 84532"]
    H --> POLY["polygonFork / arbitrumFork / optimismFork<br/>(opt-in via RPC env)"]
    H --> L["localFork<br/>persistent local node<br/>http://127.0.0.1:8545"]

    M -.fork.- E["Ethereum mainnet"]
    B -.fork.- BN["Base mainnet"]
    L -.fork.- ANY["Any RPC<br/>(npx hardhat node --fork ...)"]
```

`addresses.json` from `npm-artifacts/` is the source of truth for deployed OSx addresses per chainId. Tests read it at setup so they auto-target the right factories per fork.

---

## Bootstrap flow

The entire DAO + 4 plugins comes up in a **single transaction**:

```mermaid
sequenceDiagram
    participant Deployer
    participant PRF as PluginRepoFactory
    participant DF as DAOFactory
    participant DAO as New DAO
    participant PSP as PluginSetupProcessor

    Note over Deployer,PSP: Phase 1 — publish each new plugin (3 txs)
    Deployer->>PRF: createPluginRepoWithFirstVersion(uniswap)
    PRF-->>Deployer: UniswapPluginRepo addr
    Deployer->>PRF: createPluginRepoWithFirstVersion(aave)
    PRF-->>Deployer: AavePluginRepo addr
    Deployer->>PRF: createPluginRepoWithFirstVersion(payroll)
    PRF-->>Deployer: PayrollPluginRepo addr

    Note over Deployer,PSP: Phase 2 — one tx creates everything
    Deployer->>DF: createDao(daoSettings, [TokenVoting, Uni, Aave, Payroll])
    DF->>DAO: deploy proxy + init
    loop For each plugin
        DF->>PSP: prepareInstallation + applyInstallation
        PSP->>DAO: grant permissions per plugin
    end
    DF-->>Deployer: (DAO addr, installed plugin addrs)
```

---

## Repository layout (planned)

```
cyberdyne_dao_contracts/
├── README.md                      ← you are here
├── docs/
│   └── TRD.md                     ← full Technical Requirements Document
├── src/                           ← Solidity sources
│   └── plugins/
│       ├── uniswap-v4/
│       │   ├── UniswapV4Plugin.sol
│       │   └── UniswapV4PluginSetup.sol
│       ├── aave/
│       │   ├── AaveLendingPlugin.sol
│       │   ├── AaveLendingPluginSetup.sol
│       │   └── adapters/{IAaveAdapter, AaveV3Adapter, AaveV4Adapter}.sol
│       └── payroll/
│           ├── PayrollPlugin.sol
│           ├── PayrollPluginSetup.sol
│           └── lib/BokkyPooBahDateTime.sol
├── test/                          ← Hardhat + TypeScript
│   ├── helpers/{fork-guard,addresses,impersonate,time}.ts
│   ├── plugins/{uniswap-v4,aave,payroll}/*.{unit,fork}.test.ts
│   └── e2e/CustomDaoBootstrap.fork.test.ts
├── scripts/                       ← Foundry deploy scripts
│   ├── DeployUniswapV4Plugin.s.sol
│   ├── DeployAavePlugin.s.sol
│   ├── DeployPayrollPlugin.s.sol
│   └── DeployCyberdyneDao.s.sol
├── lib/                           ← Foundry deps (OSx submodule, OZ, forge-std)
├── foundry.toml
├── hardhat.config.ts
├── remappings.txt
├── package.json
└── tsconfig.json
```

---

## Getting started

> Once contracts are implemented. Currently this is a documentation-only repo.

```bash
# Clone with submodules (OSx is a submodule, pinned to v1.5.0)
git clone --recurse-submodules https://github.com/CyberdyneCorp/cyberdyne_dao_contracts.git
cd cyberdyne_dao_contracts

# Install deps
forge install
npm install

# Build
forge build              # Foundry build
npx hardhat compile      # Hardhat build (for tests + TypeChain)

# Test
npx hardhat test                                    # unit tests
npx hardhat test --network mainnetFork              # fork tests against Ethereum
npx hardhat test --network baseFork                 # fork tests against Base

# Local persistent fork (great for iteration)
npx hardhat node --fork $RPC_MAINNET                # terminal 1
npx hardhat test --network localFork                # terminal 2
```

Required env vars (see `.env.example` when scaffolded):

```
RPC_MAINNET=
RPC_BASE=
RPC_SEPOLIA=
RPC_BASE_SEPOLIA=
DEPLOYER_KEY=               # burner wallet — never a primary key
ETHERSCAN_API_KEY=
PIN_MAINNET=                # optional — block number to pin fork to (CI determinism)
PIN_BASE=
```

---

## Frontend

This DAO is operated through our **own custom UI**, tracked in a sibling repository. The Aragon App is explicitly **not** a deployment target. See [TRD §3a](docs/TRD.md#3a-frontend--ux-policy-custom-ui-only).

The contracts in this repo are responsible for:
- Emitting granular events (`SwapExecuted`, `Supplied`, `RecipientAdded`, `PayrollExecuted`, …) for the UI + subgraph.
- Stable external signatures for clean TypeChain bindings.
- Batch-friendly view functions (one RPC round-trip per UI screen where reasonable).
- Publishing a `frontend-abi/` artifact at release time for the UI repo to consume.

---

## Documentation index

| Doc | Purpose |
|---|---|
| [README.md](README.md) | This file — high-level overview, diagrams, getting started. |
| [docs/TRD.md](docs/TRD.md) | Full Technical Requirements Document. Source of truth for every design decision, permission grant, address, deployment phase, and open question. |

When the contracts land, additional docs will be added (per-plugin specs, deployment runbook, security model deep-dive, threat model).

---

## Roadmap

- [ ] Scaffolding: `foundry.toml`, `hardhat.config.ts`, OSx submodule, OZ imports, TypeChain wiring.
- [ ] `UniswapV4Plugin` + setup + unit tests + fork tests (mainnet + Base).
- [ ] `AaveLendingPlugin` + v3 adapter + setup + tests.
- [ ] `PayrollPlugin` + setup + tests with `time.setNextBlockTimestamp` multi-month scenarios.
- [ ] `DeployCyberdyneDao.s.sol` bootstrap script + e2e fork test on mainnet, Base, Sepolia.
- [ ] CI matrix: parallel fork test runs on Ethereum + Base.
- [ ] Internal security review.
- [ ] External audit (Halborn or equivalent).
- [ ] Mainnet deployment.
- [ ] Custom UI integration (separate repo).

Estimated engineering: ~3–4 weeks to a fork-tested, mainnet-deployable build, excluding audit. See [TRD §17](docs/TRD.md#17-estimated-effort).

---

## License

TBD — to be set before any code is committed.

## Security

This repo does not yet contain deployable code. When it does, vulnerability reports go to TBD.
