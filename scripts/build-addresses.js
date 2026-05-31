#!/usr/bin/env node
/**
 * Build the published `addresses.json` artifact consumed by the toy frontend
 * (P6) and the production UI repo (P7).
 *
 * Aggregates per-chain addresses from two on-repo sources of truth:
 *   - lib/osx/packages/artifacts/src/addresses.json (OSx factories)
 *   - test/helpers/addresses.ts EXTERNAL mapping (Uniswap V4 / Permit2 /
 *     Universal Router / AAVE v3 Pool / USDC / WETH)
 *
 * The resulting addresses.json is keyed by chainId and has shape:
 *   {
 *     "1": {
 *       "name": "mainnet",
 *       "osx": { "daoFactory": "0x...", "pluginRepoFactory": "0x...", ... },
 *       "external": { "USDC": "0x...", "UNIVERSAL_ROUTER": "0x...", ... }
 *     },
 *     ...
 *   }
 *
 * Run via `npm run build:addresses`. Also invoked by `npm run build:package`.
 */
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const OSX_ARTIFACTS = path.join(
  ROOT,
  "lib",
  "osx",
  "packages",
  "artifacts",
  "src",
  "addresses.json"
);
const OUT = path.join(ROOT, "addresses.json");

if (!fs.existsSync(OSX_ARTIFACTS)) {
  console.error(`OSx artifact not found at ${OSX_ARTIFACTS}.`);
  console.error("Run `git submodule update --init --recursive` first.");
  process.exit(1);
}

const osxBook = JSON.parse(fs.readFileSync(OSX_ARTIFACTS, "utf8"));

// Subset of OSx kinds we expose to the frontend. Everything in npm-artifacts
// is technically available; we publish only what the UI / subgraph actually
// reference, so consumers don't tie themselves to internal contracts.
const OSX_KINDS = [
  "dao",
  "daoFactory",
  "daoRegistry",
  "pluginRepoFactory",
  "pluginRepoRegistry",
  "pluginSetupProcessor",
];

// Network → chainId map. Keep in sync with test/helpers/addresses.ts.
const NETWORK_CHAIN_ID = {
  mainnet: 1,
  base: 8453,
  sepolia: 11155111,
  baseSepolia: 84532,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
};

// External (non-OSx) addresses, mirroring EXTERNAL in test/helpers/addresses.ts.
// Updates here MUST stay in sync with that file; consider extracting both into
// a shared JSON if drift becomes a concern.
const EXTERNAL = {
  mainnet: {
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    UNISWAP_V4_POOL_MANAGER: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    UNISWAP_V4_STATE_VIEW: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
    UNIVERSAL_ROUTER: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
    PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    AAVE_V3_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    AAVE_V3_POOL_ADDRESSES_PROVIDER: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  },
  base: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
    UNISWAP_V4_POOL_MANAGER: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    UNISWAP_V4_STATE_VIEW: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
    UNIVERSAL_ROUTER: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    AAVE_V3_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    AAVE_V3_POOL_ADDRESSES_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  },
  sepolia: {
    PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  baseSepolia: {
    PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
};

const out = {};
for (const [network, chainId] of Object.entries(NETWORK_CHAIN_ID)) {
  const osx = {};
  for (const kind of OSX_KINDS) {
    const addr = osxBook[kind]?.[network];
    if (addr) osx[kind] = addr;
  }
  if (Object.keys(osx).length === 0) continue;
  out[String(chainId)] = {
    name: network,
    osx,
    external: EXTERNAL[network] ?? {},
  };
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(
  `Wrote ${Object.keys(out).length} chain entries to ${path.relative(ROOT, OUT)}`
);
