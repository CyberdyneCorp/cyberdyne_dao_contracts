// Proposal-action builders for every vote-gated plugin function.
//
// Each builder returns a `ProposalAction` — the `{to, value, data}` triple the
// DAO executes, plus a human-readable `summary` for the UI. Permissionless
// cranks (executePayroll / executePayrollPage) are NOT here: they're called
// directly by the connected wallet, not routed through a proposal.

import {ethers} from "ethers";
import {getAbi} from "@cyberdyne/dao-contracts";
import type {ChainConfig} from "./types";

export type ProposalAction = {
  to: string;
  value: string; // decimal string (wei)
  data: string; // 0x calldata
  summary: string;
};

function ifaceFor(
  name: "PayrollPlugin" | "UniswapV4Plugin" | "AaveLendingPlugin" | "CostRegistryPlugin"
): ethers.utils.Interface {
  return new ethers.utils.Interface(getAbi(name));
}

function requireDao(cfg: ChainConfig): NonNullable<ChainConfig["dao"]> {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  return cfg.dao;
}

function action(
  to: string,
  iface: ethers.utils.Interface,
  fn: string,
  args: unknown[],
  summary: string,
  value = "0"
): ProposalAction {
  return {to, value, data: iface.encodeFunctionData(fn, args), summary};
}

// --- Payroll ----------------------------------------------------------------

export function payrollAddRecipient(
  cfg: ChainConfig,
  payee: string,
  token: string,
  amount: ethers.BigNumber
): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.payroll, ifaceFor("PayrollPlugin"), "addRecipient", [payee, token, amount],
    `Payroll: add ${payee} (${token === ethers.constants.AddressZero ? "ETH" : token}) amount ${amount.toString()}`);
}

export function payrollRemoveRecipient(cfg: ChainConfig, payee: string): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.payroll, ifaceFor("PayrollPlugin"), "removeRecipient", [payee],
    `Payroll: remove ${payee}`);
}

export function payrollSetAmount(cfg: ChainConfig, payee: string, newAmount: ethers.BigNumber): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.payroll, ifaceFor("PayrollPlugin"), "setAmount", [payee, newAmount],
    `Payroll: set ${payee} amount → ${newAmount.toString()}`);
}

export function payrollSetPayDay(cfg: ChainConfig, day: number): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.payroll, ifaceFor("PayrollPlugin"), "setPayDayOfMonth", [day],
    `Payroll: set pay day → ${day}`);
}

// --- Uniswap V4 -------------------------------------------------------------

export function uniSwap(
  cfg: ChainConfig,
  p: {
    commands: string; // 0x… Universal Router command bytes
    inputs: string[]; // array of 0x… encoded inputs (one per command)
    deadline: ethers.BigNumberish;
    tokenIn: string;
    amountIn: ethers.BigNumber;
    tokenOut: string;
    minAmountOut: ethers.BigNumber;
  }
): ProposalAction {
  const dao = requireDao(cfg);
  return action(
    dao.uniswap,
    ifaceFor("UniswapV4Plugin"),
    "swap",
    [p.commands, p.inputs, p.deadline, p.tokenIn, p.amountIn, p.tokenOut, p.minAmountOut],
    `Uniswap: swap ${p.amountIn.toString()} ${p.tokenIn} → ${p.tokenOut} (min ${p.minAmountOut.toString()})`
  );
}

export function uniSetRouter(cfg: ChainConfig, router: string): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.uniswap, ifaceFor("UniswapV4Plugin"), "setUniversalRouter", [router],
    `Uniswap: set Universal Router → ${router}`);
}

export function uniSetAllowedToken(cfg: ChainConfig, token: string, allowed: boolean): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.uniswap, ifaceFor("UniswapV4Plugin"), "setAllowedToken", [token, allowed],
    `Uniswap: ${allowed ? "allow" : "disallow"} token ${token}`);
}

// --- AAVE lending -----------------------------------------------------------

export function aaveSupply(cfg: ChainConfig, asset: string, amount: ethers.BigNumber): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.aave, ifaceFor("AaveLendingPlugin"), "supply", [asset, amount],
    `AAVE: supply ${amount.toString()} ${asset}`);
}

export function aaveWithdraw(cfg: ChainConfig, asset: string, amount: ethers.BigNumber): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.aave, ifaceFor("AaveLendingPlugin"), "withdraw", [asset, amount],
    `AAVE: withdraw ${amount.toString()} ${asset}`);
}

export function aaveBorrow(
  cfg: ChainConfig,
  asset: string,
  amount: ethers.BigNumber,
  interestRateMode: number
): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.aave, ifaceFor("AaveLendingPlugin"), "borrow", [asset, amount, interestRateMode],
    `AAVE: borrow ${amount.toString()} ${asset} (rateMode ${interestRateMode})`);
}

export function aaveRepay(
  cfg: ChainConfig,
  asset: string,
  amount: ethers.BigNumber,
  interestRateMode: number
): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.aave, ifaceFor("AaveLendingPlugin"), "repay", [asset, amount, interestRateMode],
    `AAVE: repay ${amount.toString()} ${asset} (rateMode ${interestRateMode})`);
}

export function aaveSetAdapter(cfg: ChainConfig, adapter: string): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.aave, ifaceFor("AaveLendingPlugin"), "setAdapter", [adapter],
    `AAVE: set adapter → ${adapter}`);
}

export function aaveSetAllowedAsset(cfg: ChainConfig, asset: string, allowed: boolean): ProposalAction {
  const dao = requireDao(cfg);
  return action(dao.aave, ifaceFor("AaveLendingPlugin"), "setAllowedAsset", [asset, allowed],
    `AAVE: ${allowed ? "allow" : "disallow"} asset ${asset}`);
}

// --- Cost registry ----------------------------------------------------------

function requireCost(cfg: ChainConfig): string {
  const addr = cfg.dao?.costRegistry;
  if (!addr) throw new Error(`No CostRegistry plugin configured for chain ${cfg.chainId}`);
  return addr;
}

export function costRegister(
  cfg: ChainConfig,
  name: string,
  description: string,
  costUsdc: ethers.BigNumber,
  frequencyDays: number,
  payee: string
): ProposalAction {
  return action(
    requireCost(cfg),
    ifaceFor("CostRegistryPlugin"),
    "registerEntry",
    [name, description, costUsdc, frequencyDays, payee],
    `Cost: register "${name}" — ${costUsdc.toString()} every ${frequencyDays}d → ${payee}`
  );
}

export function costUpdate(
  cfg: ChainConfig,
  id: number,
  name: string,
  description: string,
  costUsdc: ethers.BigNumber,
  frequencyDays: number,
  payee: string
): ProposalAction {
  return action(
    requireCost(cfg),
    ifaceFor("CostRegistryPlugin"),
    "updateEntry",
    [id, name, description, costUsdc, frequencyDays, payee],
    `Cost: update #${id} "${name}" — ${costUsdc.toString()} every ${frequencyDays}d`
  );
}

export function costRemove(cfg: ChainConfig, id: number): ProposalAction {
  return action(requireCost(cfg), ifaceFor("CostRegistryPlugin"), "removeEntry", [id],
    `Cost: remove entry #${id}`);
}
