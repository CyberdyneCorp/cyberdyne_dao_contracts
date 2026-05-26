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

# Run all fork tests against a specific network (default mainnetFork).
test-fork network='mainnetFork':
    npx hardhat test --network {{network}} --grep 'fork'

# Run the full coverage suite and gate at >=90%.
coverage:
    npx hardhat coverage
    node scripts/check-coverage.js

# --- Local fork node ---

# Start a persistent Hardhat node forked from $RPC_MAINNET (port 8545).
node-mainnet:
    npx hardhat node --fork "$RPC_MAINNET"

# Start a persistent Hardhat node forked from $RPC_BASE.
node-base:
    npx hardhat node --fork "$RPC_BASE"

# --- Foundry-only ---

# Foundry tests (Solidity-based).
forge-test:
    forge test -vvv

# Storage layout for a contract.
storage contract:
    forge inspect {{contract}} storage-layout --pretty

# --- Deploy (Foundry scripts) ---

# Dry-run a deploy script.
deploy-dry script network='mainnetFork':
    forge script scripts/{{script}}.s.sol --rpc-url "$RPC_{{uppercase(network)}}" -vvv

# --- Cleanup ---

clean:
    forge clean
    rm -rf out cache cache_hardhat artifacts typechain-types coverage

# --- ABI export for frontend ---

build-abi:
    node scripts/export-abis.js
