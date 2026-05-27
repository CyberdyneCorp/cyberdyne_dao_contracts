// @cyberdyne/dao-contracts — frontend integration entry point.
//
// Pure ESM with static JSON imports so it works in both Node 22+ and any
// modern bundler (Vite / Rollup / webpack) without polyfilling node:fs.
//
// Consumers:
//   import {addresses, getAbi} from "@cyberdyne/dao-contracts";
//   const {osx, external} = addresses[chainId];
//   const payrollAbi = getAbi("PayrollPlugin");
//
// For ABIs not in the curated `getAbi` map below, import them directly via
// the exports map:
//   import setupAbi from "@cyberdyne/dao-contracts/abis/PayrollPluginSetup";
//
// addresses.json + frontend-abi/ are build artifacts emitted by
// `npm run build:package`.

import addresses from "./addresses.json" with {type: "json"};
import payrollAbi from "./frontend-abi/PayrollPlugin.json" with {type: "json"};
import uniswapAbi from "./frontend-abi/UniswapV4Plugin.json" with {type: "json"};
import aaveAbi from "./frontend-abi/AaveLendingPlugin.json" with {type: "json"};
import costRegistryAbi from "./frontend-abi/CostRegistryPlugin.json" with {type: "json"};

/** @type {Record<string, any[]>} */
const ABIS = {
  PayrollPlugin: payrollAbi.abi,
  UniswapV4Plugin: uniswapAbi.abi,
  AaveLendingPlugin: aaveAbi.abi,
  CostRegistryPlugin: costRegistryAbi.abi,
};

export {addresses};

/**
 * @param {keyof typeof ABIS | string} contractName
 * @returns {any[]}
 */
export function getAbi(contractName) {
  const abi = ABIS[contractName];
  if (!abi) {
    throw new Error(
      `Unknown ABI: ${contractName}. Curated set: ${Object.keys(ABIS).join(", ")}. ` +
        `For other contracts (setups, interfaces), import directly: ` +
        `import x from "@cyberdyne/dao-contracts/abis/<Name>".`
    );
  }
  return abi;
}

/** @returns {string[]} */
export function listAbis() {
  return Object.keys(ABIS);
}

export default {addresses, getAbi, listAbis};
