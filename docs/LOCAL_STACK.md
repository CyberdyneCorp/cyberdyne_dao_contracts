# Run the full local stack

End-to-end walkthrough — from `git clone` to a working DAO + connected wallet + executed payroll — in one continuous flow. ~5 minutes once you have the prereqs.

This document is self-contained: no "see the README" cross-references. If you're sending someone to set up the project for the first time, this is the link.

---

## What you'll have at the end

- A local Hardhat node that mirrors live Ethereum mainnet state (so real USDC, real AAVE Pool, real Uniswap V4 PoolManager are all present and queryable).
- The full Cyberdyne DAO deployed onto that local node: PayrollPlugin, UniswapV4Plugin, AaveLendingPlugin all installed atomically via `DAOFactory.createDao`.
- The toy frontend (`frontend/`) running at `http://localhost:5173`, connected to your MetaMask, reading + writing against the DAO.
- A monthly payroll executed end-to-end against a real ETH payee, with the new `lastPayoutPeriod` reflected in the UI.

---

## Prereqs

| Tool | Why | Install command |
|---|---|---|
| **Node 20+** | Hardhat + the toy frontend | https://nodejs.org or `nvm install 20` |
| **Foundry** (forge, cast, anvil) | Solidity build + deploy scripts | `curl -L https://foundry.paradigm.xyz \| bash` then `foundryup` |
| **Git with submodule support** | OSx + OZ + osx-commons are submodules | Built into any modern git |
| **Archive RPC URL for Ethereum mainnet** | The local fork mirrors mainnet state via this RPC | [Alchemy](https://alchemy.com) or [Infura](https://infura.io) free tier — short sessions fit comfortably |
| **MetaMask** (browser extension) | Wallet for signing UI actions | https://metamask.io |

Verify Foundry is on your `PATH`:

```bash
which forge && forge --version
# /Users/you/.foundry/bin/forge
# forge 1.x.x (...)
```

If not, add it: `export PATH="$HOME/.foundry/bin:$PATH"` (and persist in `~/.zshrc` / `~/.bashrc`).

---

## Step 1 — Clone + install

```bash
git clone --recurse-submodules https://github.com/CyberdyneCorp/cyberdyne_dao_contracts.git
cd cyberdyne_dao_contracts

# Install root deps (Hardhat, ethers v5, TypeChain, etc.).
# --legacy-peer-deps is required: hardhat-toolbox 2.x has peer-dep
# conflicts with the bridged hardhat-foundry plugin we use.
npm install --legacy-peer-deps

# Build the artifacts the frontend will consume.
# Runs in order: forge build, hardhat compile, ABI export, addresses
# aggregation. Outputs:
#   - frontend-abi/*.json    (one ABI per contract, plain JSON)
#   - addresses.json         (chainId-keyed: OSx + external + per-chain)
npm run build:package
```

Sanity-check:

```bash
npx hardhat test                                   # 84 unit + invariant tests, ~6s
ls frontend-abi/ addresses.json                    # artifacts exist
```

---

## Step 2 — Start a local mainnet fork

Open **Terminal 1** and keep it running for the rest of the session.

```bash
export RPC_MAINNET=https://eth-mainnet.alchemyapi.io/v2/<YOUR_KEY>

npx hardhat node --fork $RPC_MAINNET --chain-id 1
```

What this does:

- Serves a Hardhat node at `http://127.0.0.1:8545`.
- State mirrors live Ethereum mainnet at the current head — USDC, WETH, AAVE v3 Pool, Uniswap V4 PoolManager, OSx framework (`DAOFactory`, `PluginRepoFactory`, …) all exist with their real addresses + balances.
- **`--chain-id 1`** makes the local node report `chainId = 1` so `scripts/lib/OsxAddresses.sol` resolves to mainnet's OSx factory addresses (otherwise it would default to `31337` and revert `UnsupportedChain`).

You should see:

```
Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/
Accounts
========
Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10000 ETH)
Private Key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
...
```

Save the first account's private key — you'll import it into MetaMask in Step 5.

---

## Step 3 — Deploy the DAO

Open **Terminal 2**.

```bash
cd cyberdyne_dao_contracts
export PATH="$HOME/.foundry/bin:$PATH"

# Anvil/Hardhat's first default account — has 10000 ETH on the local fork.
# NEVER use this key on a real network; it's publicly known.
DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

forge script scripts/DeployCyberdyneDao.s.sol \
    --rpc-url http://127.0.0.1:8545 \
    --broadcast \
    --slow \
    --private-key $DEPLOYER
```

This runs the one-shot bootstrap from `scripts/DeployCyberdyneDao.s.sol`:

1. Publishes three fresh `PluginRepo`s (one per plugin) via `PluginRepoFactory.createPluginRepoWithFirstVersion`.
2. Deploys `AaveV3Adapter` pointing at the real AAVE v3 Pool.
3. Calls `DAOFactory.createDao(...)` with all 3 plugins installed atomically.
4. Writes the resulting addresses to `deployments/1-<timestamp>.json`.

The script's `console2.log` lines print the addresses you need:

```
DAO:                  0xABCD…
Payroll repo:         0xEF01…
Uniswap V4 repo:      0x2345…
AAVE repo:            0x6789…
AAVE adapter:         0xABCD…
```

**The plugin instance addresses** (not the repos) live in the broadcast log under `broadcast/DeployCyberdyneDao.s.sol/1/run-latest.json` — look for the `Executed` event emitted by the DAO during install, which contains the `InstalledPlugin[]` entries. Or use the deployment manifest:

```bash
cat deployments/1-*.json | jq
```

You need four addresses for the frontend env:
- `dao` — the DAO contract
- `payroll` — PayrollPlugin instance
- `uniswap` — UniswapV4Plugin instance
- `aave` — AaveLendingPlugin instance

> **Don't see the plugin instance addresses in the manifest?** They're in `broadcast/.../run-latest.json` under `transactions[N].additionalContracts`. To make them easier to grab, you can grep for `Executed` topic in the broadcast log, or impersonate the DAO and read installed plugins:
> ```bash
> # Easiest path right now:
> cast logs --rpc-url http://127.0.0.1:8545 \
>   --from-block 0 \
>   --address $DAO_FACTORY_ADDR \
>   'DAORegistered(address,address,string)'
> ```

---

## Step 4 — Start the frontend

Open **Terminal 3**.

```bash
cd cyberdyne_dao_contracts/frontend
npm install --legacy-peer-deps      # first time only
cp .env.example .env.local
```

Edit `frontend/.env.local`:

```bash
# WalletConnect — leave blank to use injected MetaMask only.
PUBLIC_WC_PROJECT_ID=

# Point the frontend at your local fork.
PUBLIC_RPC_MAINNET=http://127.0.0.1:8545

# Paste your DAO addresses from Step 3, comma-separated in this exact order:
# <dao>,<payroll>,<uniswap>,<aave>
PUBLIC_DAO_MAINNET=0xABCD…,0xEF01…,0x2345…,0x6789…
```

Then:

```bash
npm run dev
# → Local:   http://localhost:5173/
```

---

## Step 5 — Connect your wallet

1. Open `http://localhost:5173` in a browser with MetaMask installed.
2. In MetaMask, **Add a custom network**:
   - **Network name**: `Local fork`
   - **New RPC URL**: `http://127.0.0.1:8545`
   - **Chain ID**: `1`
   - **Currency symbol**: `ETH`
   - **Block explorer URL**: leave blank
3. MetaMask will warn "This Chain ID is currently used by the Mainnet network". That's the point — we want MetaMask to treat the local fork as mainnet so addresses + UI map correctly. Confirm and add anyway.
4. **Import the deployer account**: MetaMask → Account menu → Import Account → paste the deployer private key from Step 2 (`0xac0974be...`). The account will show 10000 ETH on the Local fork network. **Never** import this key on the real Ethereum mainnet.
5. Switch MetaMask to the Local fork network.
6. In the toy frontend's wallet bar, click **Connect injected**.

The `/` (overview) page should load:
- Treasury balances (ETH + tracked ERC20s — initially zero since the freshly-deployed DAO has no funds).
- DAO + plugin addresses (matching what you pasted into `.env.local`).
- OSx framework addresses (DAOFactory, PluginRepoFactory, PluginSetupProcessor).

Click around the nav (`Overview` / `Proposals` / `Payroll` / `Lending` / `Swaps`) to verify each page renders.

---

## Step 6 — Drive the DAO end-to-end

To exercise the full vote-gate → execute path you'd need TokenVoting wired into the bootstrap, which is deferred (see the `DeployCyberdyneDao.s.sol` header comment). For local-stack validation, impersonate the DAO directly via `cast` to bypass governance and drive the plugins:

```bash
# In Terminal 2.
DAO=0xABCD…             # from Step 3
PAYROLL=0xEF01…         # from Step 3
PAYEE=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045   # vitalik.eth, or any addr you control

# 1. Impersonate the DAO so we can call its admin functions directly.
cast rpc anvil_impersonateAccount $DAO --rpc-url http://127.0.0.1:8545
cast rpc anvil_setBalance $DAO 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8545

# 2. Add a payroll recipient (1 ETH per month).
cast send $PAYROLL "addRecipient(address,address,uint256)" \
  $PAYEE \
  0x0000000000000000000000000000000000000000 \
  1000000000000000000 \
  --from $DAO --unlocked \
  --rpc-url http://127.0.0.1:8545

# 3. Send the DAO some ETH so it can actually pay.
cast send $DAO --value 10ether \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8545

# 4. Time-travel to the 15th of next month at 12:00 UTC (PAY_DAY = 15 by default).
PAYDAY=$(python3 -c "
import datetime, calendar
now = datetime.datetime.utcnow()
month = now.month + 1
year = now.year + (1 if month > 12 else 0)
month = ((month - 1) % 12) + 1
print(int(datetime.datetime(year, month, 15, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()))
")
cast rpc evm_setNextBlockTimestamp $PAYDAY --rpc-url http://127.0.0.1:8545

# 5. Refresh the /payroll page in the frontend and click the
#    "executePayroll()" button. The crank is permissionless — anyone
#    can run it, no permission needed.
```

After the crank tx confirms:
- The frontend's `/payroll` page shows `Last paid period: <YYYY-MM>` updated.
- The payee's ETH balance shows `+1 ETH` (check with `cast balance $PAYEE --rpc-url http://127.0.0.1:8545`).
- The DAO's ETH balance dropped by ~1 ETH on the `/` overview.

You've now exercised the entire on-chain flow: deploy → install → admin action → permissionless crank → real ETH transfer.

For AAVE supplies / Uniswap swaps, the pattern is the same — seed the DAO with USDC by impersonating a known whale (addresses + the pattern are in `test/plugins/payroll/PayrollPlugin.fork.test.ts`), then call `aave.supply(USDC, amount)` or `uniswap.swap(...)` from the DAO.

---

## Tear down

```bash
# Terminal 1: Ctrl+C the hardhat node — fork state is in-memory, discarded.
# Terminal 3: Ctrl+C the vite dev server.

# So the next run doesn't reuse stale plugin addresses:
rm frontend/.env.local
rm -rf broadcast/DeployCyberdyneDao.s.sol/1/
```

The local fork has no persistent disk state. Restarting in Step 2 starts from a fresh mainnet block.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `forge: command not found` | Foundry not on PATH | `export PATH="$HOME/.foundry/bin:$PATH"` |
| `Error: cannot estimate gas` on `forge script` | Local node not running on `127.0.0.1:8545` | Confirm Terminal 1 is still running |
| `UnsupportedChain(31337)` revert from the deploy script | Forgot `--chain-id 1` on `hardhat node` | Restart the node with `--chain-id 1` |
| Frontend says "Unsupported chain id 31337" | MetaMask connected to default Hardhat chain instead of the spoofed mainnet | Switch MetaMask to your "Local fork" network with chain ID `1` |
| `No DAO configured for chain 1` | `PUBLIC_DAO_MAINNET` not set in `frontend/.env.local` | Paste the 4 addresses from Step 3 (dao,payroll,uniswap,aave) |
| `executePayroll()` reverts `NotYetDueThisMonth` | Local-fork block time is before pay day | Use `cast rpc evm_setNextBlockTimestamp` to advance time (Step 6 #4) |
| `executePayroll()` reverts `NoActiveRecipients` | No one's been added via `addRecipient` | Run Step 6 #2 |
| MetaMask: "Account 0x... has insufficient funds" on a tx | Imported account is on the wrong network | Switch MetaMask to "Local fork" before signing |
| Alchemy/Infura rate limit hits | Free tier exhausted by repeated forks | Wait for the rate window or use a paid key |

---

## Where next

- **Build your own UI?** Read [`FRONTEND_INTEGRATION.md`](FRONTEND_INTEGRATION.md) — the toy frontend at `frontend/` is the reference implementation; that doc explains the read / write / event patterns for any client.
- **Deploy to testnet (Sepolia / Base Sepolia)?** Replace `--rpc-url http://127.0.0.1:8545` with the testnet RPC, use a funded testnet key instead of the well-known Anvil key, and remove the `--chain-id 1` from the hardhat-node command (you're not forking). Per-chain OSx addresses are already in `scripts/lib/OsxAddresses.sol`.
- **Understand a specific plugin?** See `docs/plugins/{PAYROLL,UNISWAP_V4,AAVE}.md` for per-plugin specs, allowance lifecycle, and slither audit notes.
- **Run the subgraph?** `subgraph/README.md` has the per-DAO deploy recipe (Goldsky / hosted Graph / Studio).
- **Review security model?** `docs/THREAT_MODEL.md` enumerates assets, trust boundaries, and the 20-vector mitigation table.
