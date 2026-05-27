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

echo ""
echo "Stack up. Frontend: cp the PUBLIC_DAO line above into frontend/.env.local"
echo "(addresses are deterministic, so an existing .env.local already matches),"
echo "then: just frontend-dev   →   connect MetaMask to http://127.0.0.1:$PORT (chainId 31337),"
echo "import anvil key $ANVIL_KEY"
