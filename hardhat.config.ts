import {HardhatUserConfig} from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-foundry";
import "@typechain/hardhat";
import "solidity-coverage";
import * as dotenv from "dotenv";

dotenv.config();

const {
  RPC_MAINNET,
  RPC_SEPOLIA,
  RPC_BASE_SEPOLIA,
  DEPLOYER_KEY,
  ETHERSCAN_API_KEY,
  BASESCAN_API_KEY,
} = process.env;

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
    // --- Fork networks ---
    // Hardhat's in-process `forking` only works on the built-in `hardhat`
    // network — a NAMED network cannot fork in-process. So each `*Fork`
    // network connects to a separately-launched anvil node. We use anvil
    // (not `hardhat node`) because anvil accepts `--chain-id`, which these
    // networks require:
    //
    //   anvil --fork-url $RPC_MAINNET --chain-id 1        --port 8545  # mainnetFork
    //   anvil --fork-url $RPC_BASE    --chain-id 8453     --port 8546  # baseFork
    //   anvil --fork-url $RPC_SEPOLIA --chain-id 11155111 --port 8547  # sepoliaFork
    //
    // `--chain-id` makes the node report the real chain id so addresses
    // resolve. Then run `npx hardhat test --network mainnetFork`. The justfile
    // `fork-mainnet` / `fork-base` / `fork-sepolia` recipes wrap these (and
    // `just test-fork <network>` runs the suites). Distinct ports let targets
    // run concurrently (one per CI runner).
    localFork: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      accounts: "remote",
    },
    mainnetFork: {
      url: "http://127.0.0.1:8545",
      chainId: 1,
      accounts: "remote",
    },
    baseFork: {
      url: "http://127.0.0.1:8546",
      chainId: 8453,
      accounts: "remote",
    },
    sepoliaFork: {
      url: "http://127.0.0.1:8547",
      chainId: 11155111,
      accounts: "remote",
    },
    baseSepoliaFork: {
      url: "http://127.0.0.1:8548",
      chainId: 84532,
      accounts: "remote",
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
      url: process.env.RPC_BASE ?? "",
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
