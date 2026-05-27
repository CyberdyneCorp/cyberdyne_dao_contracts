# Frontend Integration

How a custom UI — production app in a sibling repo, or any third-party — consumes the Cyberdyne DAO contracts end-to-end.

| | |
|---|---|
| npm package | `@cyberdyne/dao-contracts` (this repo's published artifact) |
| Subgraph | per-DAO, manifest template in `subgraph/` |
| IPFS proposal metadata | `scripts/pin-metadata.js`, schema in `docs/PROPOSAL_METADATA.md` |
| Worked example | The toy frontend at [`frontend/`](../frontend) is the reference implementation — every pattern in this doc has a corresponding file there |

## Where to start

1. **Want a working DAO to integrate against right now?** Follow [`docs/LOCAL_STACK.md`](LOCAL_STACK.md) to spin one up on a local mainnet fork in ~5 minutes, then point your UI at `http://127.0.0.1:8545`.
2. **Just need addresses + ABIs?** `npm install @cyberdyne/dao-contracts` and read §2 below.
3. **Building proposal flows?** §3 has create / vote / execute / executePayroll / plugin-admin snippets.
4. **Indexing for a history view?** §1 explains why direct-RPC and subgraph are split; `subgraph/README.md` has the deploy recipe.

The Cyberdyne plugins do NOT publish Aragon-App-compatible metadata (no per-action decoder JSON, no UI schemas — see TRD §3a). The contract surface is the integration contract; this document describes how to consume it cleanly.

---

## 1. Data flow

```
                   ┌──────────────────────────────────────┐
                   │     User wallet (MM / WC v2)         │
                   └────────────────┬─────────────────────┘
                                    │
                                    ▼
                   ┌──────────────────────────────────────┐
       ┌──────────►│            Frontend (UI)              │◄────┐
       │           │ - reads addresses + ABIs from npm pkg │     │
       │           │ - reads recent history from subgraph  │     │
       │           │ - reads live state via direct RPC     │     │
       │           └────────────┬───────────┬────────┬─────┘     │
       │                        │           │        │           │
       │      ipfs://<cid>      │           │        │           │
       │  (proposal metadata)   │           │ direct │           │
       │                        ▼           ▼ RPC    ▼ direct    │
       │             ┌────────────────┐ ┌──────────┐ ┌─────────┐ │
       │             │ IPFS gateways  │ │ JSON-RPC │ │ Subgraph│ │
       │             │ (Cloudflare,   │ │ provider │ │ (Graph/ │ │
       │             │ Pinata, …)     │ │          │ │ Goldsky)│ │
       │             └───────┬────────┘ └─────┬────┘ └────┬────┘ │
       │                     │                │           │      │
       │ pin-metadata.js     │                ▼           │      │
       │ (writes new pins)   │           ┌──────────────┐ │      │
       │                     │           │  EVM chain   │ │      │
       │                     │           │  (OSx DAO +  │ │      │
       │                     │           │  plugins +   │ │      │
       │                     │           │  external    │ │      │
       │                     │           │  protocols)  │ │      │
       │                     │           └──────────────┘ │      │
       │                     │                            │      │
       └─────────────────────┴────────────────────────────┘
            "I just pinned an action batch" → "Show me the proposal"
```

Three reads, one write per user flow:

| Need | Source | Why |
|---|---|---|
| Plugin/DAO **addresses** per chain | `@cyberdyne/dao-contracts/addresses` | Compile-time. One npm import. No round-trip. |
| Contract **ABIs** | `@cyberdyne/dao-contracts/abis/<name>` | Compile-time. No round-trip. |
| **Live state** (DAO balances, allowlists, payroll schedule, last-paid period) | Direct RPC via ethers (or viem in production UI) | Always fresh. Required reads sized for one round-trip per screen. |
| **Historical/derived state** (swap history, lending action log, per-recipient payout history) | Subgraph | Pre-indexed. Avoids burning RPC reads on `eth_getLogs` paging. |
| **Proposal metadata** (title, description, discussion link) | IPFS gateway (`ipfs://<cid>`) | Stored off-chain; only the CID lives on-chain in `metadata`. |
| **Write actions** | Direct contract calls via wallet provider | One signed tx per action. |

---

## 2. Reading state — one RPC round-trip per UI screen

Each UI screen should resolve to **one** RPC batch. The view methods on each plugin are sized for this (TRD §3a). Pseudo-code with `ethers` v5 (production UI may use viem; semantics identical):

```ts
import {ethers} from "ethers";
import {addresses, getAbi} from "@cyberdyne/dao-contracts";

const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
const chain = addresses[chainId];

// Payroll schedule screen — one RPC, all the data we need.
const payroll = new ethers.Contract(payrollAddress, getAbi("PayrollPlugin"), provider);
const [recipients, payDay, lastPeriod] = await Promise.all([
  payroll.allActiveRecipients(),
  payroll.payDayOfMonth(),
  payroll.lastPayoutPeriod(),
]);
```

Per screen, the canonical read pattern:

| Screen | Reads (single batch) | Subgraph queries |
|---|---|---|
| DAO overview | `dao.balance` (ETH); `IERC20(tracked).balanceOf(dao)` for tracked tokens; plugin addresses from `addresses.json`; `IProtocolVersion(daoFactory).protocolVersion()` | none |
| Proposal list | `TokenVoting.getProposalIds()` (or events via subgraph) | `proposals(first: N, orderBy: createdAt desc)` |
| Proposal detail | `TokenVoting.getProposal(id)` for live tally + status | `proposal(id) { votes, executions }` for history |
| Payroll schedule | `PayrollPlugin.allActiveRecipients()` + `payDayOfMonth()` + `lastPayoutPeriod()` | `payrollRecipient(id) { payoutItems }` for per-recipient history |
| Lending positions | `Pool.getUserAccountData(dao)` for health factor (toy frontend shows a color-coded tier banner); per-asset `aToken.balanceOf(dao)` + `variableDebtToken.balanceOf(dao)` | `dao.lendingActions` for tx history |
| Swap history | none (event-only) | `swaps(first: N, orderBy: timestamp desc)` |
| V3 LP positions | `NPM.tokenOfOwnerByIndex(dao, i)` + `positions(tokenId)`; live fees via `NPM.callStatic.collect(...)`; pool state via `factory.getPool` + `slot0` | `v3Positions(where: {dao})` + `v3Collects` |
| V4 LP positions | `IV4PositionManager.getPoolAndPositionInfo(tokenId)` + `getPositionLiquidity`; enumerate via `Transfer(0x0, dao)` scan | `v4LpOps(where: {dao})` |
| Operating costs | `CostRegistryPlugin.getEntries(offset, limit)` (paginated) | `costEntries(where: {dao})` + `costPayments` history |
| Proposal pre-execute check | `dao.callStatic.execute(callId, actions, 0)` with `from = TokenVoting` (toy frontend "Sim" column) | none |

---

## 3. Writing — per-action snippets

The toy frontend (P6) uses ethers v5 directly. The production UI (sibling repo) is expected to use wagmi v2 + viem; pattern is the same.

### Create a proposal (TokenVoting)

```ts
// 1. Pin metadata to IPFS off-chain (or via your CI hook).
const cid = "..."; // from scripts/pin-metadata.js

// 2. Encode the actions you want the DAO to execute.
const swapData = uniswapInterface.encodeFunctionData("swap", [
  commands, inputs, deadline, USDC, parseUnits("10000", 6), WETH, minOut,
]);
const actions = [{to: uniswapAddress, value: 0n, data: swapData}];

// 3. Submit.
const tx = await tokenVoting.createProposal(
  ethers.utils.toUtf8Bytes(`ipfs://${cid}`),
  actions,
  0, // allowFailureMap
  /* startDate */ 0,
  /* endDate */ 0,
  /* voteOption */ 0,
  /* tryEarlyExecution */ false
);
```

### Vote on a proposal

```ts
await tokenVoting.vote(proposalId, /* Yes=2, No=3, Abstain=1 */ 2, /* tryEarlyExecution */ false);
```

### Execute a passed proposal

```ts
await tokenVoting.execute(proposalId);
```

### Trigger payroll crank (permissionless)

```ts
const payroll = new ethers.Contract(payrollAddress, getAbi("PayrollPlugin"), signer);
await payroll.executePayroll(); // anyone can call; no permission needed
```

### Plugin admin actions (vote-gated)

These are NEVER called directly. The UI builds them as `Action[]` payloads for a TokenVoting proposal:

```ts
const addRecipientAction = {
  to: payrollAddress,
  value: 0n,
  data: payrollInterface.encodeFunctionData("addRecipient", [payee, token, amount]),
};
// → include in the proposal's actions array
```

---

## 4. Chain switching

The UI lets the user pick a chain via the wallet's chain switcher. Per-chain config flows from `@cyberdyne/dao-contracts/addresses`:

```ts
import {addresses} from "@cyberdyne/dao-contracts";

const SUPPORTED = Object.keys(addresses).map(Number);

function configForChain(chainId: number) {
  const cfg = addresses[chainId];
  if (!cfg) throw new Error(`Unsupported chain: ${chainId}`);
  return cfg; // { name, osx: {...}, external: {...} }
}
```

Per-DAO addresses (the plugin instances, not the framework) live in `deployments/<chain>-<timestamp>.json` produced by `just deploy-cyberdyne-dao`. The UI should ship its own copy of these for the live DAOs it cares about — typically a hand-maintained `src/lib/dao.json` keyed by chainId.

---

## 5. Event reference (one source of truth)

`docs/EVENTS.md` is the canonical event → UI surface → subgraph entity mapping. Whenever the UI adds a new view, check that doc first to confirm there's an event (or a view fn) backing it.

---

## 6. Operational notes

- **Gateway selection**: IPFS gateway reads can be flaky. Configure 2+ gateways with timeout-fallback (Cloudflare → ipfs.io → Pinata gateway). 5s timeout per gateway.
- **RPC budget**: dedicated archive node for the production UI (Alchemy/Infura paid). Toy frontend can lean on public RPCs since traffic is low.
- **Cache strategy**: subgraph queries are cacheable for ~10s; live RPC reads cache for ~1s. Use SWR (React) / `@tanstack/svelte-query` (Svelte) with these defaults.
- **ABI/address drift**: pin to a specific npm version of `@cyberdyne/dao-contracts`. Bumping the version is a coordinated frontend + contracts deploy.
- **Plugin upgrade flow**: when a UUPS upgrade ships, the ABI on the proxy address may add/change methods. Re-publish `@cyberdyne/dao-contracts`, bump the version, redeploy the UI. The subgraph also needs a re-deploy (the schema may have new event signatures).
