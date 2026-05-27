# Cyberdyne DAO — Toy Frontend

Dev/inspector tool for the Cyberdyne DAO contracts. **Not the production UI** (TRD §3a — that lives in a sibling repo).

Per TRD §3b: SvelteKit + ethers v5 + WalletConnect v2, ≤~1k LOC, no design polish, no off-chain backend, no auth beyond wallet signatures. Audit walkthroughs and the testnet bug bounty (P11) lean on this for a "see the state, push the buttons" UI.

## Quick start

Run these from the repo root (each is a `just` recipe):

```bash
just build-package                       # produces addresses.json + frontend-abi/
just frontend-install                    # links @cyberdyne/dao-contracts via file:..
cp frontend/.env.example frontend/.env.local  # fill PUBLIC_WC_PROJECT_ID + PUBLIC_DAO_<CHAIN>
just frontend-dev                        # http://localhost:5173
```

`@cyberdyne/dao-contracts` is consumed via `file:..` so local changes flow without a publish step. Once the package ships to npm, swap to a semver.

## Views

| Route | Purpose |
|---|---|
| `/` | DAO overview — treasury balances (ETH + tracked ERC20s), plugin addresses, OSx framework addresses |
| `/proposals` | Action-builder for vote-gated admin actions (TokenVoting list/vote/execute lands in P11) |
| `/payroll` | Active recipients + pay day + last-paid period + `executePayroll()` button + add-recipient action builder |
| `/lending` | DAO's aToken balances, variable debt, health factor (read from AAVE Pool directly) + plugin state |
| `/swaps` | Recent `SwapExecuted` events via `eth_getLogs` (last ~24h on mainnet; subgraph is the richer source) |

## Env

| Var | Purpose |
|---|---|
| `PUBLIC_WC_PROJECT_ID` | WalletConnect v2 project ID. Required for WC connections; injected wallet works without it. |
| `PUBLIC_RPC_<CHAIN>` | Optional pre-connect RPC. Wallet provides its own after connect. |
| `PUBLIC_DAO_<CHAIN>` | Comma-separated `<dao>,<payroll>,<uniswap>,<aave>` per chain. Hand-maintained from `../deployments/<chain>-*.json`. |

## CI

`npm run check` runs `svelte-check` (TS + Svelte type errors). `npm run build` produces a static SPA in `build/`. Both are wired into the parent CI workflow so ABI/address drift in the contracts package surfaces here on every PR.

## Stack non-goals

- No design system / Tailwind / animations.
- No mobile breakpoints.
- No telemetry, analytics, or auth.
- No proposal drafts / pre-staging — straight to on-chain create.
- No SSR — pure SPA so wallet + chain state aren't stale.
