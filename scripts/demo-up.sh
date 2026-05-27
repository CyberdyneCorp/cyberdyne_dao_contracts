#!/usr/bin/env bash
# Bring up the full local demo stack in one shot:
#   1. anvil — mainnet fork (archive RPC, cancun, chainId 31337) on :8545
#   2. deploy the DAO + 5 plugins + TokenVoting (EarlyExecution mode)
#   3. seed realistic activity (payroll / costs / lending / positions / swaps)
#
# Leaves anvil running in the background (pid in .demo-anvil.pid). Stop it with
# `just demo-down` (or `kill $(cat .demo-anvil.pid)`).
#
# Prereqs: foundry (anvil/forge/cast), node, RPC reachable. Uses the public
# archive RPC so historical storage reads (e.g. NPM.positions) work as the
# fork ages — infura free tier is NOT archive and breaks those.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_FORK="${RPC_FORK:-https://ethereum-rpc.publicnode.com}"
PORT=8545
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
# Verified mainnet TokenVoting repo (build 1, PUSH0-free → cancun fork).
export TOKEN_VOTING_REPO="${TOKEN_VOTING_REPO:-0xb7401cD221ceAFC54093168B814Cc3d42579287f}"
export TOKEN_VOTING_BUILD="${TOKEN_VOTING_BUILD:-1}"
export VOTE_MODE="${VOTE_MODE:-1}" # EarlyExecution — a Yes from the 100% holder is instantly executable

# Free the port if a stale anvil is holding it.
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "· killing stale process on :$PORT"
  kill "$(lsof -ti "tcp:$PORT" | head -1)" 2>/dev/null || true
  sleep 2
fi

echo "· starting anvil (fork: $RPC_FORK)"
anvil --fork-url "$RPC_FORK" --chain-id 31337 --port "$PORT" --hardfork cancun >/tmp/demo-anvil.log 2>&1 &
echo $! > .demo-anvil.pid

for i in $(seq 1 30); do
  if cast block-number --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "· anvil ready (block $(cast block-number --rpc-url http://127.0.0.1:$PORT))"
    break
  fi
  sleep 2
done

echo "· deploying DAO + 5 plugins + TokenVoting (EarlyExecution)"
forge script scripts/DeployCyberdyneDao.s.sol \
  --rpc-url "http://127.0.0.1:$PORT" --broadcast --slow \
  --private-key "$ANVIL_KEY" >/tmp/demo-deploy.log 2>&1
grep -A 8 "installed plugin instances" /tmp/demo-deploy.log || true

echo "· seeding activity"
node scripts/seed-local.mjs "http://127.0.0.1:$PORT"

# Sync frontend/.env.local to the freshly-deployed addresses. The DAO address
# is deterministic but the PLUGIN instances are deployed by the PSP at shifting
# nonces, so their addresses change between deploys — a stale .env.local points
# the frontend at dead addresses. Rewrite only the PUBLIC_DAO_MAINNET line.
echo "· syncing frontend/.env.local to the new addresses"
node -e '
const fs = require("fs"), path = require("path");
const files = fs.readdirSync("deployments")
  .filter((f) => f.startsWith("31337-") && f.endsWith(".json"))
  .map((f) => path.join("deployments", f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const d = JSON.parse(fs.readFileSync(files[0], "utf8"));
const line = "PUBLIC_DAO_MAINNET=" +
  [d.dao, d.payroll, d.uniswapV4, d.aave, d.governance, d.costRegistry, d.uniswapV3].join(",");
const env = "frontend/.env.local";
let txt = fs.existsSync(env) ? fs.readFileSync(env, "utf8") : "PUBLIC_RPC_MAINNET=http://127.0.0.1:8545\n";
txt = /^PUBLIC_DAO_MAINNET=.*$/m.test(txt)
  ? txt.replace(/^PUBLIC_DAO_MAINNET=.*$/m, line)
  : txt.replace(/\n*$/, "\n") + line + "\n";
fs.writeFileSync(env, txt);
console.log("  " + line);
'

echo ""
echo "Stack up. frontend/.env.local synced to the new addresses."
echo "Run: just frontend-dev   →   connect MetaMask to http://127.0.0.1:$PORT (chainId 31337),"
echo "import anvil key $ANVIL_KEY"
