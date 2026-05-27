// Contract factory — reads ABIs from the @cyberdyne/dao-contracts npm package
// and binds them to addresses from the current chain's DAO config.

import {ethers} from "ethers";
import {getAbi} from "@cyberdyne/dao-contracts";
import type {ChainConfig} from "./types";

export type PluginName =
  | "PayrollPlugin"
  | "UniswapV4Plugin"
  | "AaveLendingPlugin"
  | "CostRegistryPlugin";

export function payrollContract(
  chain: ChainConfig,
  providerOrSigner: ethers.providers.Provider | ethers.Signer
): ethers.Contract {
  if (!chain.dao) throw new Error(`No DAO configured for chainId ${chain.chainId}`);
  return new ethers.Contract(chain.dao.payroll, getAbi("PayrollPlugin"), providerOrSigner);
}

export function uniswapContract(
  chain: ChainConfig,
  providerOrSigner: ethers.providers.Provider | ethers.Signer
): ethers.Contract {
  if (!chain.dao) throw new Error(`No DAO configured for chainId ${chain.chainId}`);
  return new ethers.Contract(chain.dao.uniswap, getAbi("UniswapV4Plugin"), providerOrSigner);
}

export function aaveContract(
  chain: ChainConfig,
  providerOrSigner: ethers.providers.Provider | ethers.Signer
): ethers.Contract {
  if (!chain.dao) throw new Error(`No DAO configured for chainId ${chain.chainId}`);
  return new ethers.Contract(chain.dao.aave, getAbi("AaveLendingPlugin"), providerOrSigner);
}

export function costRegistryContract(
  chain: ChainConfig,
  providerOrSigner: ethers.providers.Provider | ethers.Signer
): ethers.Contract {
  if (!chain.dao?.costRegistry) {
    throw new Error(`No CostRegistry plugin configured for chainId ${chain.chainId}`);
  }
  return new ethers.Contract(
    chain.dao.costRegistry,
    getAbi("CostRegistryPlugin"),
    providerOrSigner
  );
}

// Minimal DAO surface — for treasury balance reads + DAO.execute calls.
const DAO_ABI = [
  "function hasPermission(address where, address who, bytes32 permissionId, bytes data) view returns (bool)",
];
export function daoContract(
  chain: ChainConfig,
  providerOrSigner: ethers.providers.Provider | ethers.Signer
): ethers.Contract {
  if (!chain.dao) throw new Error(`No DAO configured for chainId ${chain.chainId}`);
  return new ethers.Contract(chain.dao.dao, DAO_ABI, providerOrSigner);
}

// Minimal ERC20 surface — for treasury balance reads.
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
export function erc20(
  address: string,
  providerOrSigner: ethers.providers.Provider | ethers.Signer
): ethers.Contract {
  return new ethers.Contract(address, ERC20_ABI, providerOrSigner);
}
