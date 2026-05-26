import {HardhatUserConfig} from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-foundry";
import "@typechain/hardhat";
import "solidity-coverage";
import * as dotenv from "dotenv";

dotenv.config();

const {
  RPC_MAINNET,
  RPC_BASE,
  RPC_SEPOLIA,
  RPC_BASE_SEPOLIA,
  RPC_POLYGON,
  RPC_ARBITRUM,
  RPC_OPTIMISM,
  PIN_MAINNET,
  PIN_BASE,
  DEPLOYER_KEY,
  ETHERSCAN_API_KEY,
  BASESCAN_API_KEY,
} = process.env;

// Allow undefined RPCs at config-load time so `hardhat compile` works without secrets.
// Tests that target a given fork will fail fast at runtime if the RPC isn't set.
const optionalFork = (url: string | undefined, pin?: string) =>
  url
    ? {url, ...(pin ? {blockNumber: Number(pin)} : {})}
    : undefined;

const accounts = DEPLOYER_KEY ? [DEPLOYER_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.17",
    settings: {
      optimizer: {enabled: true, runs: 2000},
      // Match Foundry / OSx audited build verbatim.
      outputSelection: {
        "*": {
          "*": ["storageLayout"],
        },
      },
    },
  },
  paths: {
    sources: "src",
    tests: "test",
    cache: "cache_hardhat",
    artifacts: "artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // forking config is set per-test-run via HH_FORK_URL when needed
      ...(process.env.HH_FORK_URL
        ? {
            forking: {
              url: process.env.HH_FORK_URL,
              ...(process.env.HH_FORK_BLOCK
                ? {blockNumber: Number(process.env.HH_FORK_BLOCK)}
                : {}),
            },
          }
        : {}),
      allowUnlimitedContractSize: false,
    },
    localFork: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      accounts,
    },
    mainnetFork: {
      chainId: 1,
      url: "http://127.0.0.1:0", // unused; we fork via HH_FORK_URL into the in-process network
      ...(RPC_MAINNET
        ? {forking: optionalFork(RPC_MAINNET, PIN_MAINNET)}
        : {}),
    },
    baseFork: {
      chainId: 8453,
      url: "http://127.0.0.1:0",
      ...(RPC_BASE ? {forking: optionalFork(RPC_BASE, PIN_BASE)} : {}),
    },
    sepoliaFork: {
      chainId: 11155111,
      url: "http://127.0.0.1:0",
      ...(RPC_SEPOLIA ? {forking: optionalFork(RPC_SEPOLIA)} : {}),
    },
    baseSepoliaFork: {
      chainId: 84532,
      url: "http://127.0.0.1:0",
      ...(RPC_BASE_SEPOLIA ? {forking: optionalFork(RPC_BASE_SEPOLIA)} : {}),
    },
    polygonFork: {
      chainId: 137,
      url: "http://127.0.0.1:0",
      ...(RPC_POLYGON ? {forking: optionalFork(RPC_POLYGON)} : {}),
    },
    arbitrumFork: {
      chainId: 42161,
      url: "http://127.0.0.1:0",
      ...(RPC_ARBITRUM ? {forking: optionalFork(RPC_ARBITRUM)} : {}),
    },
    optimismFork: {
      chainId: 10,
      url: "http://127.0.0.1:0",
      ...(RPC_OPTIMISM ? {forking: optionalFork(RPC_OPTIMISM)} : {}),
    },
    sepolia: {
      url: RPC_SEPOLIA ?? "",
      chainId: 11155111,
      accounts,
    },
    baseSepolia: {
      url: RPC_BASE_SEPOLIA ?? "",
      chainId: 84532,
      accounts,
    },
    mainnet: {
      url: RPC_MAINNET ?? "",
      chainId: 1,
      accounts,
    },
    base: {
      url: RPC_BASE ?? "",
      chainId: 8453,
      accounts,
    },
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v5",
  },
  gasReporter: {
    enabled: process.env.GAS_REPORT === "true",
    currency: "USD",
  },
  etherscan: {
    apiKey: {
      mainnet: ETHERSCAN_API_KEY ?? "",
      sepolia: ETHERSCAN_API_KEY ?? "",
      base: BASESCAN_API_KEY ?? "",
      baseSepolia: BASESCAN_API_KEY ?? "",
    },
  },
  mocha: {
    timeout: 120_000, // fork tests can be slow
  },
};

export default config;
