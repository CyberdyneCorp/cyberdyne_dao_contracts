# Custom DAO with Uniswap V4, AAVE, and Payroll Plugins — Technical Requirements Document

| | |
|---|---|
| Status | Draft for review |
| Author | Leo |
| Date | 2026-05-26 |
| Target network | Ethereum mainnet |
| Base protocol | Aragon OSx (already deployed) |

---

## 1. Overview

Deploy a single new DAO on Ethereum mainnet, governed by token-weighted voting, that can:

1. Trade ERC20s on **Uniswap V4** via DAO-approved proposals.
2. **Provide and manage liquidity on both Uniswap V3 and V4** (mint / increase / decrease / collect / burn), with position NFTs owned by the DAO.
3. Supply, withdraw, borrow, and repay on **AAVE** (v3 today, v4-ready via adapter) via DAO-approved proposals.
4. Pay a fixed list of payroll recipients **automatically on a fixed day each month**, where only adding/removing recipients (or changing amounts) requires a vote — the monthly execution itself is permissionless.
5. Track the DAO's recurring operating costs (AI tokens, cloud bills, services) on-chain and disburse them in USDC via a permissionless crank.

The design **reuses Aragon OSx as much as possible**. We do not fork OSx, we do not reimplement the DAO, the permission manager, the factory, the plugin lifecycle, or the voting plugin. We write **five** new plugins (UniswapV4Plugin — swaps + V4 LP, UniswapV3Plugin, AaveLendingPlugin, PayrollPlugin, CostRegistryPlugin) and deploy them on top of the existing OSx infrastructure.

## 2. Goals & non-goals

**Goals**
- Maximum reuse of audited OSx contracts.
- Treasury custody stays in the DAO contract; plugins are pure execution gates.
- Every privileged action is gated by the same governance path (TokenVoting → DAO.execute → Plugin).
- Single transaction to bootstrap the entire DAO with all five Cyberdyne plugins installed (+ TokenVoting when configured).
- Each new plugin is independently versioned via its own `PluginRepo` so it can be upgraded or replaced.
- All tests run under **Hardhat** with **fork-mode** against Ethereum, Base, and other Aragon-supported networks, so we exercise the real deployed OSx + Uniswap + AAVE bytecode rather than mocks.
- **Fund-moving plugin ops are reachable via TokenVoting proposals** through the `preview…Actions` multi-action pattern — see §9a — so the same on-chain action sequence can be invoked by an admin direct-call or by a passed vote.

**Non-goals**
- Building a new DAO framework or forking OSx.
- Building cross-chain support (Ethereum mainnet only for v1).
- Reimplementing TokenVoting, governance token, multisig, or proposal lifecycle.
- Yield strategies / vault automation beyond a manual AAVE supply/borrow.
- **Using the Aragon App / Aragon's hosted frontend.** This DAO will be operated through our **own custom UI** (separate codebase, tracked in a sibling repo). The Aragon App is explicitly *not* a deployment target — our plugins do not need to publish Aragon-App-compatible metadata schemas, and we do not depend on Aragon's hosted services for governance UX, proposal authoring, or treasury views. See §3a.

## 3. Aragon OSx version policy

**This project pins to the latest stable, externally-audited version of Aragon OSx and does not deviate from it.** No fork, no patches, no custom build of the OSx core. Our plugins consume OSx through its published interfaces and deployed addresses only.

### Pinned version

| Field | Value |
|---|---|
| Audited protocol version | **OSx 1.4.0** (reported by `IProtocolVersion.protocolVersion() == [1, 4, 0]`) |
| Audit | Halborn, *Aragon OSx v1.4.0 Smart Contract Security Assessment Report*, 2025-01-03 — see `audits/Halborn_AragonOSx_v1_4_Smart_Contract_Security_Assessment_Report_2025_01_03.pdf` |
| Audited commit | `e0ba7b60b08fa1665ecac92dc12ea89e4245e7dc` (started 2024-11-18, finished 2025-02-13) |
| Source / repo | https://github.com/aragon/osx |
| Acceptable working tree | **v1.4.0 _or_ v1.5.0** of the `aragon/osx` repo |
| Solidity | `solc 0.8.17`, `optimizer-runs = 2000` (matches the audited build verbatim) |

### Why v1.5.0 is also acceptable

The repository at HEAD is tagged `v1.5.0` (`npm-artifacts/package.json#version`). The CHANGELOG explicitly states:

> *"Existing OSx core contracts (`DAO`, `DAORegistry`, `PluginRepoRegistry`, `DAOFactory`, `PluginRepoFactory`, `PluginSetupProcessor`, `ENSSubdomainRegistrar`, etc.) are byte-identical to v1.4.0 — same compiler (`solc 0.8.17`), same `optimizer-runs = 2000`. No behavior change for any deployed contract. `ProtocolVersion` stays at `[1, 4, 0]`."* — `CHANGELOG.md`

In other words, v1.5.0 adds new **sibling** components (notably `MemberRegistry`) but ships the audited v1.4.0 core unchanged. Building against v1.5.0 therefore satisfies the "latest stable audited core" requirement. The only new code in v1.5.0 that we'd touch — if we touch it at all — is `MemberRegistry`, which is out of scope for this DAO.

### What "pinned" means in practice

| Where | How we pin |
|---|---|
| Solidity sources | Git submodule reference to `aragon/osx` at tag `v1.5.0` (commit verified to satisfy `ProtocolVersion == [1, 4, 0]`). No local edits permitted under `src/core/`, `src/framework/`, or `src/common/`. |
| Deployed addresses | Read from `npm-artifacts/src/addresses.json` (the OSx team's source of truth, per chainId). Never hardcode addresses elsewhere. |
| Compile target | `foundry.toml` and `hardhat.config.ts` both fix `solc 0.8.17` + `optimizer-runs = 2000` to match the audited bytecode. |
| Runtime check | Bootstrap test asserts `IProtocolVersion(daoFactory).protocolVersion() == [1, 4, 0]` before continuing — fails fast if the deploy target ever moves. |
| Upgrade policy | A future OSx audited release (e.g. v1.5.0 with a fresh audit, or v1.6.0) is adopted **only after** (a) the audit report is published, (b) we re-run our full fork suite against the new commit, and (c) we open a TRD amendment with the diff. Until then we stay on v1.4.0/v1.5.0. |

### What we explicitly do NOT do

- **No fork** of OSx core. If a bug needs fixing in OSx itself, we raise it upstream (`aragon/osx` issues) and wait for the audited fix.
- **No bypass** of OSx mechanisms (no direct treasury access, no permission-system shortcuts).
- **No use of unreleased OSx branches** in production. `develop` / feature branches are off-limits for mainnet.
- **No custom OSx flavors** for other chains. If Aragon's deployment on a target chain is missing or out-of-date, we wait — we don't ship our own copy.

This policy keeps the entire trust-critical surface (DAO, PermissionManager, Factories, PluginRepo system, PluginSetupProcessor) inside the Halborn-audited 1.4.0 boundary. Every line of new code in this project lives in our plugins — which we own, test, and audit separately.

## 3a. Frontend / UX policy: custom UI only

**Confirmed decision: this DAO will be operated through a custom-built frontend, not the Aragon App.**

| Aspect | Decision |
|---|---|
| User-facing app | Our own UI (separate repo, not part of this contracts TRD). |
| Aragon App (`app.aragon.org`) | **Not** a target. We do not list the DAO there and do not certify plugin metadata against Aragon's UI schemas. |
| Aragon SDK | Optional — we may use parts of `@aragon/sdk-client` as a TypeScript convenience for proposal encoding / DAO reads in our frontend, but the UI itself is bespoke. |
| Wallet stack | Project-chosen (e.g. wagmi + viem + RainbowKit / ConnectKit). Not constrained by Aragon. |
| Reads | Direct RPC + The Graph subgraph that we deploy for our DAO + plugins. |
| Writes | Direct contract calls from the custom UI to the on-chain DAO + plugins (no Aragon backend in the loop). |

### Implications for the contracts in this TRD

Because we are not shipping into the Aragon App, the plugins in §6 have **no obligation** to:

- Publish JSON metadata in Aragon's plugin-UI schema (decoders, action mappers, form definitions).
- Register a "build metadata URI" in their `PluginRepo` beyond a minimal description for on-chain provenance. (`prepareInstallation` still uses `IPluginSetup` — that requirement is from OSx itself, not the Aragon App.)
- Implement any Aragon-frontend hooks (e.g. action-decoder ABIs, label conventions).

What we **do** still need from the contracts side to make the custom UI nice:

- Emit clear, granular events for every state-changing call (`ProposalCreated`, `SwapExecuted`, `Supplied`, `RecipientAdded`, `PayrollExecuted`, etc.). The custom UI + subgraph consume these.
- Stable, well-typed external function signatures (no overloaded names) so TypeChain generates clean bindings.
- View functions sized for one RPC round-trip per screen (e.g. `PayrollPlugin.allActiveRecipients()` returning the full list, not a paginated iterator) — UI ergonomics.
- A small `frontend-abi/` export in this repo's build output (`hardhat compile --abi-only` or post-processed Foundry artifacts) that the UI repo can consume as an npm package or git submodule.

### What lives outside this TRD

The frontend repo, its component library, design, hosting, analytics, off-chain proposal pre-staging, draft storage, etc. — all out of scope here. This TRD ends at "the plugins expose the events, views, and external functions the UI needs."

## 3b. Toy frontend (in-repo dev/test tool)

To support development, manual testing, audit walkthroughs, and the testnet bug-bounty period, this repository ships a **minimal Svelte frontend** alongside the contracts. It is explicitly **not** the production UI (§3a) — it is a developer/inspector tool with the smallest possible surface area, optimized for "see the state, push the buttons" rather than end-user UX.

### Stack

| Layer | Tool |
|---|---|
| UI framework | **Svelte** (via SvelteKit for routing + dev tooling) |
| Ethereum client | **ethers.js v5** (matches the test stack and TypeChain output) |
| Wallet connectivity | **WalletConnect v2** (`@walletconnect/ethereum-provider`) + injected wallet (MetaMask) fallback |
| Build / dev server | Vite (built into SvelteKit) |
| Styling | Default Svelte components only — no design system, no Tailwind, no marketing copy |
| Data sources | Direct RPC reads via ethers + JSON ABIs from the `frontend-abi/` artifact. Subgraph optional. |

### Location

`frontend/` at the root of this repo. Target size ≤ ~1k LOC. Build artifact is a static SPA.

### Scope — what it must do

**Read views:**
- DAO overview: treasury balances (ETH + tracked ERC20s), installed plugin addresses, total voting power, `ProtocolVersion`.
- Proposal list + proposal detail (title + description fetched from IPFS metadata, decoded `Action[]`, vote tallies, status).
- Payroll schedule: active recipients, amounts, pay day, next payout countdown, last-paid period.
- Lending positions: AAVE supplies (aToken balances), debts (variable + stable), health factor.
- Swap history: recent `SwapExecuted` events with token in/out + amount.

**Write actions** (one minimal form per action):
- Create proposal (build `Action[]` via plugin-specific helper forms or paste raw).
- Vote on a proposal / execute a passed proposal.
- Add / remove / update payroll recipient (vote-gated → submits as a proposal).
- Trigger `executePayroll()` (permissionless crank — just a button).
- Update Uniswap router / AAVE adapter / allowlists (vote-gated admin actions).

**Network handling:**
- Chain switcher driven by the contracts artifact's `addresses.json`.
- Works against `localFork`, `mainnetFork`, `baseFork`, `sepoliaFork`, `baseSepoliaFork`, and live networks without code changes.
- Prominent banner: "Dev / inspector tool — not the production UI" on every screen.

### Scope — what it must NOT do

- No design polish. No animations. No theming. No light/dark mode.
- No off-chain backend or proxy.
- No analytics, telemetry, or user accounts.
- No proposal drafts / pre-staging — straight to on-chain create.
- No authentication beyond the on-chain wallet signature.
- No mobile-first responsive work.

### Why in-repo (not a sibling repo)

- ABI/address drift surfaces immediately on every contracts PR.
- Auditors and reviewers can run it locally against `localFork` without cloning another repo.
- The testnet bug bounty (roadmap P11) needs a working UI — the toy frontend is the cheapest path to one.
- Small enough not to bloat the repo or its CI surface.

### Implications for the contracts in this TRD

Same as §3a for the production UI, plus:
- The `frontend-abi/` artifact must include **plain JSON ABIs** alongside TypeChain types so a vanilla Svelte project can consume them without TypeScript-only tooling.
- The artifact must be importable from a Svelte component with no extra build steps (`addresses.json` is plain JSON, not a `.ts` file).

### Lifetime

Maintained through roadmap P11 (mainnet deployment). After production-UI rollout (sibling repo), the toy frontend stays as a permanent admin/inspector tool — no deprecation planned.

## 4. What we reuse from Aragon OSx

| Component | OSx contract | Why we don't rebuild it |
|---|---|---|
| DAO core (treasury + execute) | `src/core/dao/DAO.sol` | Audited UUPS-upgradeable DAO holds funds, runs `execute(Action[])`, manages reentrancy and gas safety. |
| Permission system | `src/core/permission/PermissionManager.sol` | Battle-tested grant/revoke/condition model with `ROOT_PERMISSION_ID` and `ANY_ADDR`. |
| DAO deployment | `src/framework/dao/DAOFactory.sol` | One-shot DAO + plugin install in a single call. Already deployed on mainnet. |
| Plugin lifecycle | `src/framework/plugin/setup/PluginSetupProcessor.sol` | Handles prepare/apply for install, update, uninstall. |
| Plugin distribution | `src/framework/plugin/repo/PluginRepo*.sol` | Semantic-versioned plugin registry. Each new plugin gets its own repo. |
| Plugin base classes | `src/common/plugin/Plugin.sol`, `PluginUUPSUpgradeable.sol`, `PluginCloneable.sol` | All five plugins inherit from these — no need to reimplement `DaoAuthorizable` or `auth()` modifier. |
| Action / execution model | `src/common/executors/IExecutor.sol` (Action struct) | Our plugins build `Action[]` and call `dao.execute(...)`. |
| Voting | External repo `aragon/token-voting-plugin` (already on mainnet PluginRepo) | We install the existing TokenVoting plugin v1.x. We do **not** fork it. |
| Governance token | `GovernanceERC20` in the token-voting-plugin repo | TokenVoting's `prepareInstallation` deploys one for us. |

## 5. High-level architecture

```
                    ┌─────────────────────────────────────┐
                    │           DAO (OSx core)            │
                    │  - holds ETH, ERC20, aTokens, etc.  │
                    │  - PermissionManager governs all    │
                    │  - execute(Action[]) is the only    │
                    │    way to move funds                │
                    └──────────────┬──────────────────────┘
                                   │
       EXECUTE_PERMISSION_ID granted to each plugin below
                                   │
   ┌───────────────┬───────────────┼───────────────┬───────────────┐
   ▼               ▼               ▼               ▼               ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Token    │  │UniswapV4 │  │  Aave    │  │ Payroll  │  │  (room   │
│ Voting   │  │ Plugin   │  │  Plugin  │  │ Plugin   │  │  for     │
│ (reuse)  │  │  (new)   │  │  (new)   │  │  (new)   │  │  more)   │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┘
     │             │             │             │
     │  proposals  │  swap()     │ supply()/   │ executePayroll()
     │  ↓          │  ↓          │ borrow()/   │   (permissionless,
     │  Action[]   │  ↓          │ repay() ↓   │    monthly)
     │  targets    │             │             │
     │  plugins    ▼             ▼             ▼
     │       Universal       AAVE Pool     ERC20.transfer
     │        Router         (v3 today)    via DAO.execute
     │       (V4 swaps)
     │
     └─→ DAO.execute(Action[]) is the only path to plugin actions
```

**Flow of a Uniswap swap proposal:**
1. A token holder calls `TokenVoting.createProposal(actions, …)` where `actions = [Action(to=UniswapV4Plugin, data=encodeCall(swap, params))]`.
2. Voting period elapses, threshold met.
3. Anyone calls `TokenVoting.execute(proposalId)` → DAO `execute()` → calls `UniswapV4Plugin.swap(params)`.
4. `UniswapV4Plugin.swap` builds a 3-action batch (approve / call Universal Router / revoke approval) and calls `dao.execute(batch, 0)`.
5. DAO transfers tokens from its own balance through the Universal Router. Output tokens land back in the DAO.

The same flow applies to AAVE (`supply`, `withdraw`, `borrow`, `repay`) and to payroll **management** (`addRecipient`, `removeRecipient`, `setAmount`, `setPayDay`).

The **only** function that bypasses voting is `PayrollPlugin.executePayroll()` — permissionless, but the schedule it executes was itself voted in.

## 6. New components — detailed specs

### 6.1 UniswapV4 Swap Plugin

**Base class:** `PluginUUPSUpgradeable` (upgradeable — Uniswap router addresses or pool params may need migration).

**Why upgradeable:** Universal Router has historically been redeployed (v1.2 → v2 etc.). We want to swap the target without redeploying the plugin.

**State**
- `address universalRouter` — Uniswap Universal Router on Ethereum mainnet.
- `address permit2` — Permit2 contract (`0x000000000022D473030F116dDEE9F6B43aC78BA3`).
- `address poolManager` — Uniswap V4 PoolManager singleton (`0x000000000004444c5dc75cB358380D2e3dE08A90` on mainnet).
- `mapping(address => bool) allowedToken` — optional allowlist of tokens the DAO may trade. Empty = no restriction.

**External functions**
```solidity
function swap(
    bytes calldata commands,     // Universal Router commands
    bytes[] calldata inputs,     // ABI-encoded inputs per command
    uint256 deadline,
    address tokenIn,
    uint256 amountIn,
    address tokenOut,
    uint256 minAmountOut
) external auth(TRIGGER_SWAP_PERMISSION_ID);

function setUniversalRouter(address) external auth(UPDATE_ROUTER_PERMISSION_ID);
function setAllowedToken(address token, bool allowed) external auth(MANAGE_ALLOWLIST_PERMISSION_ID);
```

**Behavior of `swap`:**
1. Validate `tokenIn` and `tokenOut` against the allowlist (if non-empty).
2. Snapshot DAO `tokenOut` balance before.
3. Build `Action[]` (length 3):
   - `IERC20(tokenIn).approve(permit2, amountIn)`
   - `IPermit2.approve(tokenIn, universalRouter, uint160(amountIn), uint48(deadline))`
   - `IUniversalRouter.execute(commands, inputs, deadline)`
4. Call `dao.execute(keccak256("UNI_V4_SWAP:" || proposalIdHint), actions, 0)`.
5. Read DAO `tokenOut` balance after; require `delta >= minAmountOut`.
6. Emit `SwapExecuted(tokenIn, amountIn, tokenOut, amountOutActual)`.

**Permissions (set up at install)**
- Grant `EXECUTE_PERMISSION_ID` on DAO to the plugin (lets plugin call `dao.execute`).
- Grant `TRIGGER_SWAP_PERMISSION_ID` on the plugin to the DAO (only proposal-executed calls reach `swap`).
- Grant `UPDATE_ROUTER_PERMISSION_ID` and `MANAGE_ALLOWLIST_PERMISSION_ID` on the plugin to the DAO.

**Security notes**
- `commands`/`inputs` come from the proposal payload. The post-swap `minAmountOut` check is the slippage guard — required for every swap.
- Plugin never holds funds: `tokenIn` is debited from the DAO via the approve+execute sequence; `tokenOut` lands in the DAO directly because the Universal Router's recipient is set to the DAO in the encoded command.
- Approval is `amountIn` not `type(uint256).max`. The Permit2 expiry handles the second-layer approval.

### 6.2 AAVE Lending Plugin

**Base class:** `PluginUUPSUpgradeable`.

**Why upgradeable:** the answered design choice is to ship with **AAVE v3 today** and adapter-swap to **v4 later** without redeploying the plugin.

**Adapter pattern**
```solidity
interface IAaveAdapter {
    function supply(address asset, uint256 amount, address onBehalfOf) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
    function poolAddress() external view returns (address);
}
```

Two concrete adapters:
- `AaveV3Adapter` → wraps AAVE v3 Pool (`0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` on mainnet).
- `AaveV4Adapter` → built when v4 is live; same interface.

The plugin holds `IAaveAdapter adapter` in storage. Swapping versions is a DAO vote that calls `setAdapter(newAdapter)`.

**State**
- `IAaveAdapter adapter`
- `mapping(address => bool) allowedAsset` — optional asset allowlist.

**External functions**
```solidity
function supply(address asset, uint256 amount) external auth(TRIGGER_LENDING_PERMISSION_ID);
function withdraw(address asset, uint256 amount) external auth(TRIGGER_LENDING_PERMISSION_ID);
function borrow(address asset, uint256 amount, uint256 interestRateMode) external auth(TRIGGER_LENDING_PERMISSION_ID);
function repay(address asset, uint256 amount, uint256 interestRateMode) external auth(TRIGGER_LENDING_PERMISSION_ID);

function setAdapter(IAaveAdapter newAdapter) external auth(UPDATE_ADAPTER_PERMISSION_ID);
function setAllowedAsset(address asset, bool allowed) external auth(MANAGE_ALLOWLIST_PERMISSION_ID);
```

**Behavior of `supply` (representative):**
1. Validate asset against allowlist.
2. Build `Action[]`:
   - `IERC20(asset).approve(adapter.poolAddress(), amount)`
   - `adapter.poolAddress().supply(asset, amount, dao, 0)` — `onBehalfOf = dao`, so aTokens land in DAO.
3. Call `dao.execute(...)`.
4. Emit `Supplied(asset, amount)`.

**Why `onBehalfOf = dao`:** aTokens (the interest-bearing receipts) and debt tokens must be issued to the DAO so the DAO remains the sole custodian.

**Borrow guardrails (recommended for v1):**
- `borrow` requires the proposal to also include a sanity-check action that asserts a post-borrow health factor. This can be enforced by a `BorrowHealthCondition` contract attached to the `TRIGGER_LENDING_PERMISSION_ID` grant via `grantWithCondition`. (Optional in v1, recommended for v1.1.)

**Permissions** mirror the Uniswap plugin (EXECUTE on DAO, TRIGGER_LENDING on plugin, UPDATE_ADAPTER on plugin, MANAGE_ALLOWLIST on plugin).

### 6.3 Payroll Plugin

**Base class:** `PluginUUPSUpgradeable`.

**Why upgradeable:** payroll logic (calendar math, multi-recipient batching, failure handling) is the most likely to evolve.

**State**
```solidity
struct Recipient {
    address payee;        // who gets paid
    address token;        // 0x0 = native ETH
    uint256 amount;       // amount per month, in token decimals
    bool active;          // soft-delete flag (preserves history)
}

Recipient[] public recipients;
mapping(address => uint256) public indexOfPayee;  // 1-based; 0 = absent

uint8  public payDayOfMonth;            // 1..28 to avoid month-length edge cases
uint256 public lastPayoutPeriod;        // packed (year * 12 + month) of last successful run
uint256 public payoutGracePeriod;       // seconds after payDay during which crank is allowed (e.g., 7 days)
```

**External functions**

Vote-gated (admin):
```solidity
function addRecipient(address payee, address token, uint256 amount)
    external auth(MANAGE_PAYROLL_PERMISSION_ID);

function removeRecipient(address payee)
    external auth(MANAGE_PAYROLL_PERMISSION_ID);

function setAmount(address payee, uint256 newAmount)
    external auth(MANAGE_PAYROLL_PERMISSION_ID);

function setPayDayOfMonth(uint8 day)
    external auth(MANAGE_PAYROLL_PERMISSION_ID);  // require 1 <= day <= 28
```

Permissionless (the crank):
```solidity
function executePayroll() external {
    (uint256 year, uint256 month, uint256 day) = _toYMD(block.timestamp);
    uint256 currentPeriod = year * 12 + month;

    require(currentPeriod > lastPayoutPeriod, "Payroll: already paid this month");
    require(day >= payDayOfMonth, "Payroll: not yet due this month");

    // Build action array
    uint256 n = _activeCount();
    Action[] memory actions = new Action[](n);
    uint256 j;
    for (uint256 i; i < recipients.length; ++i) {
        Recipient memory r = recipients[i];
        if (!r.active) continue;
        actions[j++] = (r.token == address(0))
            ? Action({ to: r.payee, value: r.amount, data: "" })
            : Action({ to: r.token, value: 0,
                       data: abi.encodeCall(IERC20.transfer, (r.payee, r.amount)) });
    }

    // Allow individual transfers to fail rather than blocking everyone.
    uint256 allowFailureMap = (1 << n) - 1; // every bit set
    (, uint256 failureMap) = IDAO(dao()).execute(
        keccak256(abi.encodePacked("PAYROLL:", currentPeriod)),
        actions,
        allowFailureMap
    );

    lastPayoutPeriod = currentPeriod;
    emit PayrollExecuted(currentPeriod, n, failureMap);
}
```

**Calendar math:** use BokkyPooBah's DateTime library (BSD-licensed, widely audited) for `_toYMD`. Solidity's lack of native calendar support makes this the standard choice. Vendor as a dependency under `lib/`.

**Edge cases handled**
- Restrict `payDayOfMonth` to `1..28` to dodge February and 30/31 mismatches entirely.
- `lastPayoutPeriod` prevents double-pay in the same month if the crank is called twice.
- Per-transfer failure tolerance (`allowFailureMap` all-bits-set) means one bad recipient (e.g., a smart-contract wallet that reverts on receive) doesn't halt the entire payroll. The `failureMap` is emitted for observability.
- If the crank is missed entirely (no one calls in a given month), that month is skipped. The next valid call pays only the current month — there is no back-pay. This is intentional: missed-month back-pay would let an attacker stack payouts. If the DAO wants to back-pay, that's a normal vote.

**Permissions**
- Grant `EXECUTE_PERMISSION_ID` on DAO to the plugin.
- Grant `MANAGE_PAYROLL_PERMISSION_ID` on the plugin to the DAO.
- `executePayroll` has no `auth` modifier — anyone can call it. The plugin's privilege flows from the DAO grant, not from the caller.

**Keeper**
- Production: register the call with Gelato or Chainlink Automation. They cost ~$2–$10 per execution depending on gas.
- Fallback: anyone can call it (incentive: prove DAO is good for it). Consider adding a small `keeperBounty` paid to `msg.sender` from the DAO's ETH balance as an Action in `executePayroll`. (Optional in v1.)

### 6.4 GovernanceERC20 token (delivered by TokenVotingSetup)

We do **not** write this contract. `TokenVotingSetup.prepareInstallation` deploys a fresh `GovernanceERC20` with parameters we pass in (name, symbol, initial holders, initial balances). Reference: external `aragon/token-voting-plugin` repo.

## 7. PluginSetup contracts

Each new plugin ships with a `PluginSetup` deployed once per repo. Each implements `IPluginSetup` from `src/common/plugin/setup/IPluginSetup.sol`.

Each `prepareInstallation(dao, data)` does:
1. ABI-decode `data` into the plugin's init params.
2. Deploy the plugin proxy (UUPS) targeted at the new plugin implementation.
3. Build `PermissionLib.MultiTargetPermission[]` array with the grants listed in §6.x.
4. Return `(pluginAddress, PreparedSetupData({ helpers: [], permissions: <grants> }))`.

`prepareUninstallation` returns the inverse `Revoke` set.

`prepareUpdate(fromBuild, payload)` returns ABI-encoded `initializeV{N}()` calldata when we ship build N.

Each setup is published in its **own** `PluginRepo` (created via `PluginRepoFactory.createPluginRepoWithFirstVersion(...)`).

## 8. DAO bootstrap — single transaction

```solidity
// Pseudocode for the deploy script (scripts/DeployCustomDao.s.sol)

DAOFactory.DAOSettings memory daoSettings = DAOFactory.DAOSettings({
    trustedForwarder: address(0),
    daoURI: "ipfs://…",
    subdomain: "<your-subdomain>",
    metadata: "<metadata bytes>"
});

DAOFactory.PluginSettings[] memory plugins = new DAOFactory.PluginSettings[](4);

// 1. TokenVoting (existing repo)
plugins[0] = DAOFactory.PluginSettings({
    pluginSetupRef: PluginSetupRef({ versionTag: Tag({release:1, build: N}),
                                     pluginSetupRepo: TOKEN_VOTING_REPO_ON_MAINNET }),
    data: abi.encode(votingSettings, tokenSettings, mintSettings)
});

// 2. Uniswap V4 plugin (new repo)
plugins[1] = DAOFactory.PluginSettings({
    pluginSetupRef: PluginSetupRef({ versionTag: Tag(1,1), pluginSetupRepo: UNI_V4_PLUGIN_REPO }),
    data: abi.encode(UNIVERSAL_ROUTER, PERMIT2, POOL_MANAGER, allowlistTokens)
});

// 3. AAVE plugin (new repo)
plugins[2] = DAOFactory.PluginSettings({
    pluginSetupRef: PluginSetupRef({ versionTag: Tag(1,1), pluginSetupRepo: AAVE_PLUGIN_REPO }),
    data: abi.encode(aaveV3AdapterAddress, allowlistAssets)
});

// 4. Payroll plugin (new repo)
plugins[3] = DAOFactory.PluginSettings({
    pluginSetupRef: PluginSetupRef({ versionTag: Tag(1,1), pluginSetupRepo: PAYROLL_PLUGIN_REPO }),
    data: abi.encode(payDayOfMonth, initialRecipients)
});

(DAO dao, IPluginSetup.PreparedSetupData[] memory) =
    DAOFactory.createDao(daoSettings, plugins);
```

One transaction creates the DAO, mints the governance token, installs all five plugins, wires all permissions, and emits a registry event.

## 9. Permission matrix

Notation: `(permissionId, where, who)`.

| Permission | where | who | Granted at | Why |
|---|---|---|---|---|
| `EXECUTE_PERMISSION_ID` | DAO | TokenVoting | Voting install | Lets passed proposals execute on DAO. |
| `EXECUTE_PERMISSION_ID` | DAO | UniswapV4Plugin | Uni install | Plugin builds Action[] and calls `dao.execute`. |
| `EXECUTE_PERMISSION_ID` | DAO | AaveLendingPlugin | AAVE install | Same. |
| `EXECUTE_PERMISSION_ID` | DAO | PayrollPlugin | Payroll install | Plugin issues transfers on the monthly crank. |
| `TRIGGER_SWAP_PERMISSION_ID` | UniswapV4Plugin | DAO | Uni install | Only proposal-triggered calls reach `swap`. |
| `UPDATE_ROUTER_PERMISSION_ID` | UniswapV4Plugin | DAO | Uni install | Vote-gated config changes. |
| `MANAGE_ALLOWLIST_PERMISSION_ID` | UniswapV4Plugin | DAO | Uni install | Vote-gated allowlist edits. |
| `TRIGGER_LENDING_PERMISSION_ID` | AaveLendingPlugin | DAO | AAVE install | Only proposals reach supply/borrow/etc. |
| `UPDATE_ADAPTER_PERMISSION_ID` | AaveLendingPlugin | DAO | AAVE install | v3 → v4 adapter swap is a vote. |
| `MANAGE_ALLOWLIST_PERMISSION_ID` | AaveLendingPlugin | DAO | AAVE install | Vote-gated. |
| `MANAGE_PAYROLL_PERMISSION_ID` | PayrollPlugin | DAO | Payroll install | Vote-gated participant + amount changes. |
| `UPGRADE_PLUGIN_PERMISSION_ID` | each new plugin | DAO | each install | Vote can upgrade the plugin via UUPS. |
| `ROOT_PERMISSION_ID` | DAO | DAO | Always | Self-sovereign per OSx default. |

Permissions explicitly *not* granted:
- No EOA / multisig has `ROOT_PERMISSION_ID`. The DAO is fully self-sovereign from genesis.
- `executePayroll()` carries **no** permission — by design.

### 9a. Governance-path action builders (`preview…Actions`)

OSx `DAO.execute` is `nonReentrant`. Plugins whose vote-gated functions internally call `dao.execute(actions)` (V3 mint, V4 LP `modifyLiquidities`, AAVE supply/withdraw/borrow/repay) **cannot** be invoked through a TokenVoting proposal that does `to=plugin, data=mint(params)` — the proposal's own `dao.execute(outer)` re-enters the guard when the plugin's wrapper calls `dao.execute(inner)`.

The canonical OSx workaround is to compose multi-action proposals directly. Each fund-moving plugin therefore exposes a **view helper** that builds the same `Action[]` the wrapper would have submitted:

| Plugin | View helper(s) |
|---|---|
| `UniswapV3Plugin` | `previewMintActions`, `previewIncreaseLiquidityActions`, `previewDecreaseLiquidityActions`, `previewCollectActions`, `previewBurnActions` |
| `UniswapV4Plugin` | `previewModifyLiquiditiesActions` (LP) |
| `AaveLendingPlugin` | `previewSupplyActions`, `previewWithdrawActions`, `previewBorrowActions`, `previewRepayActions` |

Each plugin's existing direct entry (`mint`, `supply`, …) is now a thin wrapper: `actions = preview…(args); dao.execute(actions); emit X`. Behavior is unchanged for non-governance callers (admin / multisig / cron). The frontend's governance path calls `preview…Actions` via the connected provider, lifts each entry into a `ProposalAction`, and submits the **N-action TokenVoting proposal** — `dao.execute(actions)` then runs them atomically under the single `nonReentrant` lock with no nested execute call.

Permissionless cranks (`executePayroll`, `executePayrollPage`, `processDue`) keep their original shape: they're called directly (no proposal), so the nested-`execute` doesn't apply.

## 10. External protocol integrations (Ethereum mainnet addresses)

| Protocol | Contract | Address |
|---|---|---|
| Uniswap V4 | PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` |
| Uniswap | Universal Router (V4-capable) | TBD — confirm latest at deploy time (`docs.uniswap.org`). |
| Permit2 | Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| AAVE v3 | Pool | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` |
| AAVE v3 | PoolAddressesProvider | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` |
| AAVE v4 | TBD | Address(es) TBD — adapter pattern lets us add later. |
| Aragon OSx | DAOFactory (mainnet) | Read from `npm-artifacts/` at deploy time. |
| Aragon OSx | PluginRepoFactory | Read from `npm-artifacts/`. |
| Aragon | TokenVoting PluginRepo | Read from `npm-artifacts/`. |

> The new-plugin `PluginRepo` addresses (Uniswap, AAVE, Payroll) are produced by **our** deploy script and recorded in `deployments/mainnet-<timestamp>.json`.

## 11. Security considerations

| Risk | Mitigation |
|---|---|
| Plugin holding DAO funds | Plugins never custody. All funds in DAO. Plugins only build `Action[]`. |
| Reentrancy via external protocols | DAO's `nonReentrant` on `execute()` (`src/core/dao/DAO.sol:73`) blocks. Plugins do not re-enter DAO mid-execution. |
| Unbounded loops in payroll | Cap `recipients.length` at 100 (configurable). DAO's `execute` already caps at 256 actions. |
| Slippage on swaps | Plugin enforces post-swap `balanceAfter - balanceBefore >= minAmountOut`. Proposal must set `minAmountOut`. |
| AAVE liquidation from over-borrow | v1: documentation + proposal review. v1.1: `BorrowHealthCondition` enforces post-borrow health factor via OSx `grantWithCondition`. |
| Upgrade hijack | `UPGRADE_PLUGIN_PERMISSION_ID` granted only to DAO. Only a vote can upgrade. |
| Malicious adapter swap | `UPDATE_ADAPTER_PERMISSION_ID` granted only to DAO. Vote required. |
| Payroll back-pay attack | `executePayroll` always pays only the current period (`lastPayoutPeriod = currentPeriod`, no loop). Missed months are skipped permanently. |
| Token allowance lingering | Swap path approves exact `amountIn` (not max) and revokes after if non-zero leftover. |
| ETH stuck in plugin | Plugins do not receive ETH. All ETH transfers in payroll go DAO → payee directly. |
| Permit2 expiry races | Use a tight `deadline` parameter (≤ 30 minutes from proposal execution) and require it as a swap arg. |

## 12. Tooling stack

| Layer | Tool | Why |
|---|---|---|
| Smart contracts (Solidity 0.8.17) | Foundry (`forge build`) | Matches existing OSx build (`foundry.toml`, `remappings.txt`). Faster compile + storage layout output. |
| Tests | **Hardhat + TypeScript (ethers v5)** | Required by project mandate. Native fork support, `hardhat_reset`, `hardhat_impersonateAccount`, time travel via `evm_increaseTime`/`evm_mine`. Existing OSx legacy Hardhat suite under `packages/contracts/test/` is the template. |
| Deployment scripts | Foundry (`forge script` via `just-foundry`) | Keeps deploy pathway aligned with OSx convention in `DEPLOYMENT.md`. Produces broadcast logs + verify. |
| Fork engine | **anvil** (`anvil --fork-url <rpc> --chain-id <id>`), driven via the `just fork-*` recipes; Hardhat connects to it as a named `*Fork` network | A named Hardhat network can't fork in-process, and `hardhat node` can't set `--chain-id` (needed so OSx addresses resolve). anvil does both. One recipe per target chain. |
| Coverage | `hardhat-coverage` (solidity-coverage) | Generates lcov; CI gate at ≥ 90 % on new plugin code. |
| Lint/format | `solhint` + `prettier-plugin-solidity` | Same configs as upstream OSx. |
| Type-safe contract bindings | `@typechain/hardhat` | Auto-generated for both our new plugins and the upstream OSx + Uniswap + AAVE ABIs (pulled from `npm-artifacts/` and the protocols' own packages). |

The repo will keep one shared Solidity source tree but two build pipelines:
- `forge build` for fast Solidity-only compile and deploy.
- `npx hardhat compile` for TypeScript test compilation + TypeChain output.

Both pipelines read from `src/` and the existing `remappings.txt` / `lib/` so the same sources compile under either tool. This is the same dual-pipeline pattern OSx itself ships with today.

### Hardhat networks (fork targets)

An in-process `forking` block only works on the built-in `hardhat` network — a *named* network can't fork in-process. So `hardhat.config.ts` defines one named `*Fork` network per target chain, each pointing at a locally-running **anvil** fork on a distinct port (`accounts: "remote"` so it uses anvil's funded accounts). The `just fork-*` recipes launch the anvil nodes.

```ts
// hardhat.config.ts (shape)
networks: {
  hardhat: { chainId: 31337 }, // in-process; opt-in fork via HH_FORK_URL
  // Each *Fork connects to an anvil node started by `just fork-<chain>`:
  mainnetFork:     { url: "http://127.0.0.1:8545", chainId: 1,        accounts: "remote" },
  baseFork:        { url: "http://127.0.0.1:8546", chainId: 8453,     accounts: "remote" },
  sepoliaFork:     { url: "http://127.0.0.1:8547", chainId: 11155111, accounts: "remote" },
  baseSepoliaFork: { url: "http://127.0.0.1:8548", chainId: 84532,    accounts: "remote" },
},
```

**Local fork mode (recommended for day-to-day iteration):**
```bash
# Terminal 1 — start a persistent anvil fork of mainnet (RPC_MAINNET from .env)
just fork-mainnet            # → anvil --fork-url $RPC_MAINNET --chain-id 1 --port 8545
# Pin a block for deterministic state: just fork-mainnet 21500000

# Terminal 2 — run the *.fork + e2e suites against it
just test-fork mainnetFork
```

This gives a chain that mirrors mainnet state, supports `anvil_impersonateAccount` to spoof whales or the DAO itself, and survives across test runs (so we can manually inspect state after a failed run).

**One-shot fork mode (for CI):** start the matching `just fork-<chain>` node, then
```bash
just test-fork mainnetFork
just test-fork baseFork
# (the recipe runs `npx hardhat test $(find test -name '*.fork.test.ts') --network <net>`;
#  Hardhat resolves paths literally, so a quoted `**` glob won't expand — enumerate with find)
```

Each test file declares which networks it supports via a small helper:
```ts
import { onlyOn } from "../helpers/fork-guard";
onlyOn(["mainnetFork", "localFork"], () => describe("Uniswap V4 swap on mainnet fork", () => { ... }));
```

`addresses.json` from `npm-artifacts/` is the source of truth for OSx contract addresses per chainId — tests read it directly so they auto-target the right `DAOFactory` / `PluginRepoFactory` / `TokenVotingRepo` per fork.

### Block pinning

For determinism, CI fork tests pin to a specific block (`PIN_MAINNET`, `PIN_BASE`, …) so external protocol state (Uniswap pools, AAVE rates) doesn't drift. Local dev forks unpinned for freshness.

## 13. Testing strategy

All tests in Hardhat + TypeScript under `test/` (root) and structured to mirror OSx's existing `packages/contracts/test/` layout (mocha + chai with the project's `chai-setup.ts` matchers).

**Unit tests** (per plugin, no fork — use `hardhat` in-memory network):
- Permission gating on each external function.
- `PluginSetup.prepareInstallation` returns the correct permission set.
- `prepareUninstallation` returns the inverse.
- State transitions (allowlist edits, recipient add/remove, adapter swap).
- Re-use mocked `DAO` and `PermissionManager` from `packages/contracts/test/` where applicable.

**Fork-integration tests** (per plugin, per target chain):

| Plugin | Fork networks | What we assert |
|---|---|---|
| UniswapV4Plugin | `mainnetFork`, `baseFork` | Real DAO with real USDC + WETH balances, real Universal Router, real PoolManager. Assert DAO balance delta = expected output within slippage tolerance. |
| AaveLendingPlugin | `mainnetFork`, `baseFork` | Real AAVE v3 Pool. Supply USDC → assert aUSDC minted to DAO. Borrow → assert debt token issued to DAO. Withdraw → assert aTokens burned. |
| PayrollPlugin | `mainnetFork`, `localFork` | DAO holds USDC and ETH. `vm` time-travel to payday across 3 simulated months. One recipient is a reverting contract — assert others get paid, `failureMap` set. |
| End-to-end DAO bootstrap | `mainnetFork`, `baseFork`, `sepoliaFork` | Full `DAOFactory.createDao` call with all five plugins. Assert DAO permissions match §9 permission matrix. |

**Time travel for payroll tests:**
```ts
import { time } from "@nomicfoundation/hardhat-network-helpers";

await time.setNextBlockTimestamp(daysFromNow(31));   // jump to next month
await payroll.connect(anyone).executePayroll();       // permissionless crank
expect(await usdc.balanceOf(payee1)).to.equal(salary1);
```

**Impersonation pattern** (e.g., to test with a real whale's USDC):
```ts
const whale = "0x..."; // a real USDC holder on mainnet
await network.provider.send("hardhat_impersonateAccount", [whale]);
await usdc.connect(await ethers.getSigner(whale)).transfer(dao.address, parseUnits("1000000", 6));
```

**Invariant tests** (Hardhat fuzz-lite via `fast-check` or stateful loops):
- For every plugin call path, DAO is the sole custodian post-call (`plugin.balance == 0`, `usdc.balanceOf(plugin) == 0`).
- Payroll never pays twice in the same period (loop random timestamp jumps within a month).

**Cross-chain matrix in CI:**
GitHub Actions runs the full fork suite in parallel on `mainnetFork` and `baseFork` (and optionally Polygon/Arbitrum/Optimism if RPCs are configured), so a regression on any deployed OSx network blocks the PR.

**Existing helpers to reuse:**
- `packages/contracts/test/chai-setup.ts` — custom matchers (`changeBalance`, etc.).
- `packages/contracts/test/test-utils/dao.ts` — `getERC20TransferAction` and other Action-builders.
- `packages/contracts/test/test-utils/protocol-version.ts` — version helpers for PluginRepo testing.
- `npm-artifacts/src/addresses.json` — read at test setup to resolve OSx addresses per chain.

## 14. Repository structure for new code

```
src/
  plugins/
    uniswap-v4/
      UniswapV4Plugin.sol
      UniswapV4PluginSetup.sol
      IUniversalRouter.sol
      IPermit2.sol
    aave/
      AaveLendingPlugin.sol
      AaveLendingPluginSetup.sol
      adapters/
        IAaveAdapter.sol
        AaveV3Adapter.sol
        AaveV4Adapter.sol         (stub until v4 is live)
    payroll/
      PayrollPlugin.sol
      PayrollPluginSetup.sol
      lib/
        BokkyPooBahDateTime.sol   (vendored)

test/                              ← Hardhat + TypeScript tests
  helpers/
    fork-guard.ts                  (onlyOn / skipOn helpers)
    addresses.ts                   (loads npm-artifacts/src/addresses.json)
    impersonate.ts                 (hardhat_impersonateAccount wrappers)
    time.ts                        (re-exports @nomicfoundation/hardhat-network-helpers)
  plugins/
    uniswap-v4/
      UniswapV4Plugin.unit.test.ts
      UniswapV4Plugin.fork.test.ts        (mainnetFork + baseFork)
    aave/
      AaveLendingPlugin.unit.test.ts
      AaveLendingPlugin.fork.test.ts      (mainnetFork + baseFork)
    payroll/
      PayrollPlugin.unit.test.ts
      PayrollPlugin.fork.test.ts          (time-travel scenarios)
  e2e/
    CustomDaoBootstrap.fork.test.ts       (full DAOFactory + 5 plugins, multi-chain)

hardhat.config.ts                  ← network + forking config (see §12)
tsconfig.json
package.json                       ← hardhat, ethers, typechain, chai

scripts/                           ← Foundry deploy scripts (unchanged convention)
  DeployUniswapV4Plugin.s.sol      (deploys impl + setup + repo)
  DeployAavePlugin.s.sol
  DeployPayrollPlugin.s.sol
  DeployCustomDao.s.sol            (uses DAOFactory + 5 plugins)
```

The Hardhat test tree is rooted at top-level `test/` rather than `packages/contracts/test/` so it's clearly *our* project's test suite, separate from OSx's legacy Hardhat tests (which stay in `packages/contracts/test/` as a reference).

## 15. Deployment plan

**Phase 0 — preparation (off-chain)**
- Pin Aragon mainnet artifact addresses from `npm-artifacts/`.
- Confirm Uniswap Universal Router latest address.
- Confirm AAVE v3 Pool address.
- Decide initial governance token holders + balances.
- Decide initial payroll recipients (or leave empty and add by vote).
- Burner deployer wallet funded with ~0.5 ETH (well above estimate per `DEPLOYMENT.md`).

**Phase 1 — plugin publication (one tx each, five plugins)**
1. Deploy `UniswapV4Plugin` implementation.
2. Deploy `UniswapV4PluginSetup` pointing to that implementation.
3. Call `PluginRepoFactory.createPluginRepoWithFirstVersion(...)` → emits `UniswapV4PluginRepo` address.
4. Repeat for `AaveLendingPlugin` and `PayrollPlugin`.

**Phase 2 — DAO bootstrap (one tx)**
- Run `scripts/DeployCustomDao.s.sol` against the five plugin repos. This calls `DAOFactory.createDao(...)` and creates the DAO with all five plugins installed atomically.

**Phase 3 — verification**
- Verify all contracts on Etherscan (automatic via just-foundry).
- Read DAO state: confirm `PermissionManager` grants match §9.
- Submit a smoke-test proposal (e.g., a 1 USDC swap on Uniswap V4) and walk it through end-to-end.
- Register the payroll crank with Gelato / Chainlink Automation.

**Phase 4 — handoff**
- Save `deployments/mainnet-<timestamp>.json` with all addresses.
- Publish ABIs + addresses as a `frontend-abi/` artifact (consumed by our custom UI repo — see §3a). No Aragon App publication.

## 16. Open questions / risks

1. **AAVE v4 launch date + concurrent v3/v4.** Adapter shape mitigates, but if v4's interface diverges significantly from v3 (e.g., the announced "GHO-native" liquidity layer), the `IAaveAdapter` interface may need a v2. Operating v3 and v4 *simultaneously* (not just migrating) is the multi-adapter registry designed in `docs/plugins/AAVE.md §3a` — a v1.1 refactor that is mock-testable now and gets live v4 wiring once v4 ships. Tracking: `aave/aave-v4` repo.
2. **Universal Router version drift.** Uniswap has shipped multiple router revisions. We pin the latest at deploy time and the `setUniversalRouter` vote handles future migrations.
3. **Keeper economics.** If gas on the payday is high and no keeper is incentivized, payroll could be delayed within the grace window. Adding a small ETH bounty paid to `msg.sender` from `executePayroll` is a recommended v1.1.
4. **Gas ceiling on payroll batch.** ~~Up to ~100 recipients tested; beyond that we'd need a paginated crank.~~ **Shipped:** `executePayrollPage(uint256 maxCount)` pays the period across multiple cursor-tracked pages (`MAX_RECIPIENTS_PER_PAGE = 100`, total `MAX_RECIPIENTS = 300`); `executePayroll()` stays the single-batch path and reverts `PayrollExceedsSinglePage` when the set won't fit one page. See `docs/plugins/PAYROLL.md §`.
5. **"Aragon network" target.** The brief mentions forking against "Aragon" — there isn't a single Aragon chain; Aragon OSx is deployed across Ethereum, Polygon, Arbitrum, Optimism, Base, Avalanche, Sepolia, Base Sepolia, etc. (see `npm-artifacts/src/addresses.json`). For v1 we default fork CI to **Ethereum + Base**, and any other supported chain can be added by dropping an `RPC_<NAME>` env var and a network entry in `hardhat.config.ts`. Confirm the precise target list before CI is wired.
6. **RPC cost / rate limits.** Fork tests hit external RPCs hard. Use a paid Alchemy/Infura plan with archive access (block pinning needs `eth_getBlockByNumber` historically), or stand up a dedicated `erigon`/`reth` archive node for CI. Anvil/Hardhat caching mitigates but doesn't eliminate.

## 17. Estimated effort

| Workstream | Estimate |
|---|---|
| Hardhat project scaffolding (config, network matrix, helpers, typechain wiring) | 1–2 days |
| UniswapV4Plugin + setup + unit + fork tests (mainnet + base) | 5–7 days |
| AaveLendingPlugin + v3 adapter + setup + unit + fork tests (mainnet + base) | 5–7 days |
| PayrollPlugin + setup + unit + fork tests with time-travel (incl. date-math vendoring) | 6–8 days |
| Bootstrap script + e2e fork test across mainnet + base + sepolia | 3–4 days |
| Toy frontend (Svelte + ethers.js v5 + WalletConnect v2; read + write screens for all plugins) | 5–7 days |
| Frontend integration artifacts (npm package, subgraph, IPFS metadata) | 4–5 days |
| Internal security review + fuzz / invariant testing | 5–7 days |
| External audit (recommended before mainnet) | 4–6 weeks calendar (Halborn or similar) |
| Internal hardening + fixes from audit | 1–2 weeks |

**Total engineering**: ~4–5 weeks to a fork-tested, mainnet-deployable build including the toy frontend, excluding audit calendar time. Add audit + testnet bounty period before any real funds touch the DAO. Full phase-by-phase plan lives in [ROADMAP.md](ROADMAP.md).
