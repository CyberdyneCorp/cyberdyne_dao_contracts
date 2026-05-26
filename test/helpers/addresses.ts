import addresses from "../../lib/osx/packages/artifacts/src/addresses.json";

// addresses.json schema: { [contractKind: string]: { [networkName: string]: string } }
type AddressBook = Record<string, Record<string, string>>;
const book = addresses as AddressBook;

// Maps Hardhat network names + chainIds → OSx artifact network names.
const NETWORK_BY_NAME: Record<string, string> = {
  mainnet: "mainnet",
  mainnetFork: "mainnet",
  base: "base",
  baseFork: "base",
  sepolia: "sepolia",
  sepoliaFork: "sepolia",
  baseSepolia: "baseSepolia",
  baseSepoliaFork: "baseSepolia",
  polygon: "polygon",
  polygonFork: "polygon",
  arbitrum: "arbitrum",
  arbitrumFork: "arbitrum",
  optimism: "optimism",
  optimismFork: "optimism",
};

const NETWORK_BY_CHAIN_ID: Record<number, string> = {
  1: "mainnet",
  8453: "base",
  11155111: "sepolia",
  84532: "baseSepolia",
  137: "polygon",
  42161: "arbitrum",
  10: "optimism",
};

export function osxNetworkName(opts: {hardhatNetwork?: string; chainId?: number}): string {
  if (opts.hardhatNetwork && NETWORK_BY_NAME[opts.hardhatNetwork]) {
    return NETWORK_BY_NAME[opts.hardhatNetwork];
  }
  if (opts.chainId !== undefined && NETWORK_BY_CHAIN_ID[opts.chainId]) {
    return NETWORK_BY_CHAIN_ID[opts.chainId];
  }
  throw new Error(
    `Cannot resolve OSx network name (hardhatNetwork=${opts.hardhatNetwork}, chainId=${opts.chainId})`
  );
}

export type OsxContractKind =
  | "dao"
  | "daoFactory"
  | "daoRegistry"
  | "pluginRepoFactory"
  | "pluginRepoRegistry"
  | "pluginSetupProcessor"
  | "ensSubdomainRegistrar";

export function osxAddress(
  kind: OsxContractKind | string,
  network: {hardhatNetwork?: string; chainId?: number}
): string {
  const net = osxNetworkName(network);
  const entry = book[kind];
  if (!entry) throw new Error(`Unknown OSx contract kind: ${kind}`);
  const addr = entry[net];
  if (!addr) throw new Error(`OSx ${kind} not deployed on ${net}`);
  return addr;
}

// External (non-OSx) protocol addresses used by fork tests. Static per chain — TRD §10.
// TODO: verify on docs.uniswap.org before mainnet deploy. Universal Router has
// been redeployed historically and the plugin's `setUniversalRouter` is the
// upgrade path — but for fork tests we pin to the V4-capable releases below.
export const EXTERNAL = {
  mainnet: {
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    UNISWAP_V4_POOL_MANAGER: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    UNIVERSAL_ROUTER: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
    PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    AAVE_V3_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    AAVE_V3_POOL_ADDRESSES_PROVIDER: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  },
  base: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
    UNISWAP_V4_POOL_MANAGER: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    UNIVERSAL_ROUTER: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    AAVE_V3_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    AAVE_V3_POOL_ADDRESSES_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  },
} as const;

export type ExternalChain = keyof typeof EXTERNAL;
