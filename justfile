# Convenience recipes for the dual Foundry + Hardhat workflow.
# `just <recipe>` — see `just --list` for everything available.

set dotenv-load := true
set positional-arguments

# Default: list recipes.
default:
    @just --list

# --- Build / format / lint ---

# Compile both pipelines (forge + hardhat).
build:
    forge build
    npx hardhat compile

# Run Solidity formatter.
fmt:
    npx prettier --write 'src/**/*.sol'

fmt-check:
    npx prettier --check 'src/**/*.sol' 'test/**/*.ts'

lint:
    npx solhint 'src/**/*.sol'
    npx eslint 'test/**/*.ts' 'scripts/**/*.ts'

# Static analysis.
slither:
    slither . --config-file slither.config.json

# --- Test ---

# Run all Hardhat unit tests (no fork).
test:
    npx hardhat test

# Run every *.fork test against a running forked node (default mainnetFork).
# Prereq: a forked node must already be running on the matching port —
# start one with `just fork-mainnet` / `just fork-base` in another terminal.
# `find` enumerates the files (Hardhat resolves paths literally, so a quoted
# `**` glob won't expand); the fork tests self-gate via onlyOn(...), so suites
# for other networks are skipped.
test-fork network='mainnetFork':
    npx hardhat test $(find test -name '*.fork.test.ts') --network {{network}}

# Run the full coverage suite and gate at >=90%.
coverage:
    npx hardhat coverage
    node scripts/check-coverage.js

# Run the Foundry invariant suite (50k sequences under the CI profile).
invariants:
    FOUNDRY_PROFILE=ci forge test --match-path 'test/invariants/*.t.sol' -vv

# --- Local fork nodes (anvil) ---
#
# These use anvil (NOT `hardhat node`) because anvil supports --chain-id, which
# the *Fork networks in hardhat.config.ts require (mainnetFork expects a node
# reporting chainId 1, etc.). Run one in its own terminal, then `just test-fork`.
#
# `block` is optional: pass a block number to PIN the fork (strongly recommended
# on free RPC tiers — anvil caches fetched state, avoiding rate-limit flakiness).
# Leave empty to fork at latest.

# Forked mainnet on :8545 (chainId 1) — for `just test-fork mainnetFork`.
# Usage: just fork-mainnet [block]
fork-mainnet block='':
    anvil --fork-url "$RPC_MAINNET" --chain-id 1 --port 8545 \
        {{ if block != '' { '--fork-block-number ' + block } else { '' } }}

# Forked mainnet on :8545 reporting chainId 31337 — for the FRONTEND demo.
# 31337 avoids MetaMask's chainId-1 conflict, so you can add a plain custom
# network. OsxAddresses + the frontend treat 31337 as a mainnet fork.
# Usage: just fork-local [block]
fork-local block='':
    anvil --fork-url "$RPC_MAINNET" --chain-id 31337 --port 8545 \
        {{ if block != '' { '--fork-block-number ' + block } else { '' } }}

# Forked Base on :8546 (chainId 8453). Usage: just fork-base [block]
fork-base block='':
    anvil --fork-url "$RPC_BASE" --chain-id 8453 --port 8546 \
        {{ if block != '' { '--fork-block-number ' + block } else { '' } }}

# Forked Sepolia on :8547 (chainId 11155111).
fork-sepolia block='':
    anvil --fork-url "$RPC_SEPOLIA" --chain-id 11155111 --port 8547 \
        {{ if block != '' { '--fork-block-number ' + block } else { '' } }}

# --- Foundry-only ---

# Foundry tests (Solidity-based), no fork.
forge-test:
    forge test -vvv

# Storage layout for a contract.
storage contract:
    forge inspect {{contract}} storage-layout --pretty

# --- Deploy (Foundry scripts) ---
#
# Anvil's first default account — 10000 ETH on any local fork, publicly known.
# NEVER use this key on a real network.
ANVIL_KEY := "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

# Bootstrap the full DAO onto the LOCAL forked node (:8545). Broadcasts for
# real against the local fork. Prereq: `just fork-mainnet` running in another
# terminal. Prints + writes deployments/<chain>-<ts>.json.
# Optional env: TOKEN_VOTING_REPO, GOV_TOKEN_HOLDER, PAY_DAY, SUBDOMAIN_DAO.
deploy-local *FLAGS='':
    forge script scripts/DeployCyberdyneDao.s.sol \
        --rpc-url http://127.0.0.1:8545 \
        --broadcast --slow -vvv \
        --private-key {{ANVIL_KEY}} \
        {{FLAGS}}

# Deploy to a real network (testnet/mainnet). Needs DEPLOYER_KEY in .env and
# a verified TOKEN_VOTING_REPO if you want governance. Add --broadcast to send.
deploy rpc *FLAGS='':
    forge script scripts/DeployCyberdyneDao.s.sol \
        --rpc-url "$RPC_{{uppercase(rpc)}}" \
        --slow -vvv \
        --private-key "$DEPLOYER_KEY" \
        {{FLAGS}}

# Publish a single plugin's PluginRepo to a real network (new-version flow).
deploy-plugin name rpc *FLAGS='':
    forge script scripts/Deploy{{name}}Plugin.s.sol \
        --rpc-url "$RPC_{{uppercase(rpc)}}" \
        --slow -vvv \
        --private-key "$DEPLOYER_KEY" \
        {{FLAGS}}

# --- Frontend (toy inspector) ---

# Build the npm-package artifacts the frontend consumes (addresses + ABIs).
build-package:
    npm run build:package

# Install the toy frontend's deps (first time).
frontend-install:
    cd frontend && npm install --legacy-peer-deps

# Start the toy frontend dev server (http://localhost:5173).
# Prereq: cp frontend/.env.example frontend/.env.local and fill PUBLIC_DAO_*
# with the addresses from `just deploy-local`.
frontend-dev:
    cd frontend && npm run dev

# Type-check the frontend (svelte-check).
frontend-check:
    cd frontend && npm run check

# Production build of the frontend (static SPA → frontend/build).
frontend-build:
    cd frontend && npm run build

# --- ABI export ---

build-abi:
    node scripts/export-abis.js

# --- Cleanup ---

clean:
    forge clean
    rm -rf out cache cache_hardhat artifacts typechain-types coverage
