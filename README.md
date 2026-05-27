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

| Color  | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| Green  | Halborn-audited Aragon OSx v1.4.0 — we don't touch it        |
| Blue   | Existing audited Aragon plugin — we install but don't modify |
| Yellow | New code in this repo — we own and audit it                  |
| Red    | Third-party protocols we integrate with via calldata         |

---

## Why Aragon OSx?

Building a DAO from scratch means rebuilding (and re-auditing) treasury custody, permission management, proposal lifecycle, plugin distribution, and upgrade paths. Aragon OSx ships all of that, fully audited, and lets us add only what's unique to our use case.

| Concern                                         | Provided by OSx                                 | We build                              |
| ----------------------------------------------- | ----------------------------------------------- | ------------------------------------- |
| Treasury custody (ETH + ERC20 + NFTs)           | `DAO.sol`                                       | —                                     |
| Permission system (grant / revoke / conditions) | `PermissionManager.sol`                         | —                                     |
| Proposal lifecycle + voting                     | `aragon/token-voting-plugin`                    | —                                     |
| Plugin install / update / uninstall             | `PluginSetupProcessor` + `PluginRepo`           | —                                     |
| Versioned plugin distribution                   | `PluginRepoFactory`                             | —                                     |
| Action execution model                          | `Action{to, value, data}` + `execute(Action[])` | —                                     |
| Uniswap V4 swap gating                          | —                                               | `UniswapV4Plugin`                     |
| AAVE lending gating                             | —                                               | `AaveLendingPlugin` + version adapter |
| Monthly payroll automation                      | —                                               | `PayrollPlugin`                       |

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

| Layer              | Tool                                            | Why                                                                                                                         |
| ------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Solidity build     | **Foundry** (`forge`)                           | Matches OSx upstream (`solc 0.8.17`, `optimizer-runs = 2000`). Fast compile + storage layout.                               |
| Tests              | **Hardhat + TypeScript + ethers v5**            | Native fork support (`hardhat_reset`, `hardhat_impersonateAccount`), time travel, mocha/chai matchers from `chai-setup.ts`. |
| Deployment scripts | **Foundry** (`forge script` via `just-foundry`) | Aligned with OSx `DEPLOYMENT.md` convention.                                                                                |
| Fork engine        | **Hardhat Network forking**                     | One config flips between Ethereum / Base / other supported networks.                                                        |
| Type bindings      | `@typechain/hardhat`                            | Generated for both our plugins and Aragon / Uniswap / AAVE ABIs.                                                            |
| Coverage           | `solidity-coverage`                             | CI gate ≥ 90 % on new code.                                                                                                 |
| Lint / format      | `solhint` + `prettier-plugin-solidity`          | Same configs as OSx upstream.                                                                                               |

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
    L -.fork.- ANY["Any RPC<br/>(anvil --fork-url ... / just fork-mainnet)"]
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
├── frontend/                      ← Toy frontend (Svelte + ethers.js + WalletConnect)
│   ├── src/
│   │   ├── routes/                (SvelteKit pages: dao, proposals, payroll, lending, swaps)
│   │   ├── lib/                   (wallet, contracts, abi loaders)
│   │   └── app.html
│   ├── static/
│   ├── package.json
│   ├── svelte.config.js
│   ├── vite.config.ts
│   └── README.md
├── lib/                           ← Foundry deps (OSx submodule, OZ, forge-std)
├── foundry.toml
├── hardhat.config.ts
├── remappings.txt
├── package.json
└── tsconfig.json
```

---

## Getting started

```bash
# Clone with submodules (OSx + osx-commons + OZ + forge-std)
git clone --recurse-submodules https://github.com/CyberdyneCorp/cyberdyne_dao_contracts.git
cd cyberdyne_dao_contracts

# Install Foundry if you don't have it
curl -L https://foundry.paradigm.xyz | bash && foundryup

# Install npm deps + build the package artifacts the frontend consumes
npm install --legacy-peer-deps
just build-package         # forge + hardhat compile + ABIs + addresses.json

# Test (every command below has a `just` recipe; see `just --list`)
just test                  # 84 unit tests (~6s)
just invariants            # 14 Foundry invariants, 50k sequences (CI profile)

# Fork tests: start a fork in one terminal, run the *.fork suites in another.
# RPC_MAINNET is read from .env.
just fork-mainnet          # Terminal 1 — anvil fork on :8545
just test-fork mainnetFork # Terminal 2 — runs the *.fork + e2e suites
```

Required env vars (see `.env.example`):

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

## Run the full local stack

**→ See [`docs/LOCAL_STACK.md`](docs/LOCAL_STACK.md)** for the complete walkthrough — clone → install → local fork → deploy DAO → frontend → MetaMask → executed payroll, in one self-contained document with troubleshooting. ~5 minutes once you have the prereqs.

Skipped below: the long-form recipe. Kept inline only as a TL;DR for skim-readers.

<details>
<summary>TL;DR (5 commands)</summary>

```bash
# 1. Clone + install (Terminal 0).
git clone --recurse-submodules https://github.com/CyberdyneCorp/cyberdyne_dao_contracts.git
cd cyberdyne_dao_contracts && npm install --legacy-peer-deps && npm run build:package

# 2. Local mainnet fork (Terminal 1). RPC_MAINNET is read from .env.
#    Uses anvil (not `hardhat node`, which can't set --chain-id). Append a
#    block number to pin: `just fork-mainnet 21500000`.
just fork-mainnet

# 3. Deploy the DAO (Terminal 2). Broadcasts with anvil's well-known account #0.
just deploy-local

# 4. Toy frontend (Terminal 3).
just frontend-install && cp frontend/.env.example frontend/.env.local
# edit .env.local: PUBLIC_RPC_MAINNET=http://127.0.0.1:8545, PUBLIC_DAO_MAINNET=<dao>,<payroll>,<uniswap>,<aave>
just frontend-dev

# 5. In MetaMask: add custom net at 127.0.0.1:8545 / chainId 1, import deployer key, Connect injected on the UI.
```

</details>

---

## Frontend

Two UIs, two scopes:

|         | Production UI                              | Toy frontend (in this repo)                       |
| ------- | ------------------------------------------ | ------------------------------------------------- |
| Where   | Sibling repository                         | `frontend/` directory here                        |
| Stack   | Project-chosen (e.g. React + wagmi + viem) | Svelte + ethers.js v5 + WalletConnect v2          |
| Purpose | End-user DAO operation                     | Dev / audit / testnet inspection + manual testing |
| Polish  | Full design system                         | None — default Svelte components only             |
| Spec    | TRD §3a                                    | TRD §3b                                           |

The toy frontend exists so developers, auditors, and testnet bug-bounty participants can interact with every plugin action end-to-end without depending on the production UI being ready. It connects to `localFork`, `mainnetFork`, `baseFork`, `sepoliaFork`, `baseSepoliaFork`, and live networks via a chain switcher driven by `addresses.json`. See [TRD §3b](docs/TRD.md#3b-toy-frontend-in-repo-devtest-tool) for full scope; built in roadmap [P6](docs/ROADMAP.md#phase-6--toy-frontend-in-repo-devtest-tool).

The Aragon App is explicitly **not** a deployment target for either UI.

The contracts in this repo are responsible for:

- Emitting granular events (`SwapExecuted`, `Supplied`, `RecipientAdded`, `PayrollExecuted`, …) for both UIs + subgraph.
- Stable external signatures for clean TypeChain bindings.
- Batch-friendly view functions (one RPC round-trip per UI screen where reasonable).
- Publishing a `frontend-abi/` artifact at release time — must include plain JSON ABIs (consumable by the Svelte toy frontend) **and** TypeChain types (consumable by the production UI).

---

## Documentation index

| Doc                                                                    | Purpose                                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [README.md](README.md)                                                 | This file — overview, architecture, getting started TL;DR.                                                                                       |
| [docs/LOCAL_STACK.md](docs/LOCAL_STACK.md)                             | Self-contained local dev runbook: clone → fork → deploy → frontend → MetaMask → executed payroll.                                                |
| [docs/FRONTEND_INTEGRATION.md](docs/FRONTEND_INTEGRATION.md)           | How any custom UI (production app, third-party) consumes the contracts — npm pkg, subgraph, IPFS, read/write patterns.                           |
| [docs/EVENTS.md](docs/EVENTS.md)                                       | Every event → UI surface → subgraph entity mapping.                                                                                              |
| [docs/PROPOSAL_METADATA.md](docs/PROPOSAL_METADATA.md)                 | IPFS proposal-metadata schema + pinning recipe.                                                                                                  |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)                           | Asset enumeration, trust boundaries, 20-vector mitigation table.                                                                                 |
| [docs/INTERNAL_REVIEW_CHECKLIST.md](docs/INTERNAL_REVIEW_CHECKLIST.md) | Per-plugin signoff template (≥2 contributors per plugin before external audit).                                                                  |
| [docs/plugins/PAYROLL.md](docs/plugins/PAYROLL.md)                     | PayrollPlugin spec + slither waivers + storage layout.                                                                                           |
| [docs/plugins/UNISWAP_V4.md](docs/plugins/UNISWAP_V4.md)               | UniswapV4Plugin spec + slither waivers + storage layout.                                                                                         |
| [docs/plugins/AAVE.md](docs/plugins/AAVE.md)                           | AaveLendingPlugin spec + slither waivers + storage layout.                                                                                       |
| [docs/storage-layouts/](docs/storage-layouts/)                         | `forge inspect` storage-layout snapshots per release for upgrade-safety diffing.                                                                 |
| [docs/TRD.md](docs/TRD.md)                                             | Full Technical Requirements Document. Source of truth for every design decision, permission grant, address, deployment phase, and open question. |
| [docs/ROADMAP.md](docs/ROADMAP.md)                                     | End-to-end project roadmap: 13 phases with deliverables, exit criteria, and the project-wide quality bars.                                       |
| [subgraph/README.md](subgraph/README.md)                               | Per-DAO subgraph deploy recipe (Goldsky / hosted Graph / Studio).                                                                                |
| [frontend/README.md](frontend/README.md)                               | Toy frontend quickstart + the in-repo views/actions inventory.                                                                                   |

---

## Roadmap

Full phase-by-phase plan with deliverables and exit criteria: **[`docs/ROADMAP.md`](docs/ROADMAP.md)**.

```mermaid
flowchart LR
    P0[P0 Foundation] --> P1[P1 Interfaces]
    P1 --> P2[P2 Payroll]
    P1 --> P3[P3 Uniswap V4]
    P1 --> P4[P4 AAVE]
    P2 --> P5[P5 Bootstrap + E2E]
    P3 --> P5
    P4 --> P5
    P5 --> P6["P6 Toy frontend<br/>(Svelte + ethers + WC)"]
    P5 --> P7[P7 Frontend artifacts]
    P5 --> P8[P8 Internal review]
    P8 --> P9[P9 External audit]
    P9 --> P10[P10 Remediation]
    P10 --> P11[P11 Testnet + bounty]
    P6 --> P11
    P11 --> P12[P12 Mainnet]
    P12 --> P13[P13 V1.1 hardening]

    style P0 fill:#e8eaf6
    style P1 fill:#e8eaf6
    style P2 fill:#fff3cd
    style P3 fill:#fff3cd
    style P4 fill:#fff3cd
    style P5 fill:#d1ecf1
    style P6 fill:#ffe4b5
    style P7 fill:#d1ecf1
    style P8 fill:#f8d7da
    style P9 fill:#f8d7da
    style P10 fill:#f8d7da
    style P11 fill:#d4edda
    style P12 fill:#d4edda
    style P13 fill:#e2e3e5
```

**Project-wide quality bars** (enforced in CI on every PR — see [ROADMAP §"Project-wide quality bars"](docs/ROADMAP.md#project-wide-quality-bars-non-negotiable)):

- **≥ 90 % unit-test coverage** on lines AND branches for all files under `src/plugins/**`, enforced by `solidity-coverage`.
- **Integration tests are Hardhat fork tests** against real deployed networks. Every plugin has `*.fork.test.ts` running on `mainnetFork` and `baseFork` minimum.
- **Local dev = persistent fork of live network** via `just fork-mainnet` (`anvil --fork-url $RPC_MAINNET --chain-id 1`) — gives sub-second feedback against mainnet state with `anvil_impersonateAccount` / `hardhat_impersonateAccount` for spoofing whales / DAO.
- **CI matrix runs fork tests in parallel** on Ethereum + Base; other Aragon-supported chains opt-in via `RPC_<NAME>` secrets.
- **Block pinning in CI** (`PIN_MAINNET`, `PIN_BASE`) for deterministic runs; local dev runs unpinned for freshness.
- **`solc 0.8.17` + `optimizer-runs = 2000`** identical to Aragon OSx v1.4.0 audited bytecode.

Engineering estimate: ~3–4 weeks of dev work to mainnet-ready code (P0–P5), then ~5–8 weeks of calendar time for review, audit, remediation, testnet bounty period, mainnet ceremony (P6–P11). See [ROADMAP](docs/ROADMAP.md) for per-phase day estimates.

---

## License

TBD — to be set before any code is committed.

## Security

This repo does not yet contain deployable code. When it does, vulnerability reports go to TBD.
