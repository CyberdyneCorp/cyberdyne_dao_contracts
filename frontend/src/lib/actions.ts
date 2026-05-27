// Proposal-action builders for every vote-gated plugin function.
//
// Two flavors:
//
//  • SINGLE-ACTION: encodes a direct call to a plugin function. Used for
//    admin / storage-mutating actions (e.g. addRecipient, setAllowedToken).
//    These work via TokenVoting because they don't trigger a nested
//    dao.execute inside the plugin.
//
//  • MULTI-ACTION (preview path): calls the plugin's `preview…Actions(...)`
//    view to fetch the exact Action[] that would be submitted to dao.execute,
//    then turns each into a ProposalAction. Used for fund-moving ops
//    (V3 mint/increase/etc., V4 LP, AAVE supply/withdraw/borrow/repay).
//    The proposal carries the raw action batch, so when TokenVoting executes
//    it as `dao.execute(actions)`, no nested dao.execute occurs and the
//    nonReentrant guard does not trip.
//
// Permissionless cranks (executePayroll / executePayrollPage / processDue)
// are NOT here — they're called directly by the connected wallet, not via
// proposals (anyone can call them).

import {ethers} from "ethers";
import {getAbi} from "@cyberdyne/dao-contracts";
import type {ChainConfig} from "./types";
import {
  encodeMint as v4EncMint,
  encodeIncrease as v4EncIncrease,
  encodeDecrease as v4EncDecrease,
  encodeCollect as v4EncCollect,
  encodeBurn as v4EncBurn,
  type PoolKey as V4PoolKey,
} from "./v4Encode";

export type ProposalAction = {
  to: string;
  value: string; // decimal string (wei)
  data: string; // 0x calldata
  summary: string;
};

/** Lift a raw `(address to, uint256 value, bytes data)[]` tuple from a
 *  preview… call into a ProposalAction array, with a shared summary line. */
function liftPreview(
  rawActions: Array<{to: string; value: ethers.BigNumber; data: string}>,
  summary: string
): ProposalAction[] {
  return rawActions.map((a, i) => ({
    to: a.to ?? (a as unknown as [string])[0],
    value: ((a.value ?? (a as unknown as [unknown, ethers.BigNumber])[1]) as ethers.BigNumber).toString(),
    data: a.data ?? (a as unknown as [unknown, unknown, string])[2],
    summary: rawActions.length === 1 ? summary : `${summary} (${i + 1}/${rawActions.length})`,
  }));
}

function ifaceFor(
  name:
    | "PayrollPlugin"
    | "UniswapV4Plugin"
    | "AaveLendingPlugin"
    | "CostRegistryPlugin"
    | "UniswapV3Plugin"
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

// --- Uniswap V3 admin -------------------------------------------------------

export function v3SetPositionManager(cfg: ChainConfig, newManager: string): ProposalAction {
  return action(
    requireV3(cfg),
    ifaceFor("UniswapV3Plugin"),
    "setPositionManager",
    [newManager],
    `Uniswap V3: set PositionManager → ${newManager}`
  );
}

export function v3SetAllowedToken(
  cfg: ChainConfig,
  token: string,
  allowed: boolean
): ProposalAction {
  return action(
    requireV3(cfg),
    ifaceFor("UniswapV3Plugin"),
    "setAllowedToken",
    [token, allowed],
    `Uniswap V3: ${allowed ? "allow" : "disallow"} token ${token}`
  );
}

// --- Uniswap V3 LP positions ------------------------------------------------

function requireV3(cfg: ChainConfig): string {
  const addr = cfg.dao?.uniswapV3;
  if (!addr) throw new Error(`No UniswapV3 plugin configured for chain ${cfg.chainId}`);
  return addr;
}

export type V3MintInput = {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: ethers.BigNumber;
  amount1Desired: ethers.BigNumber;
  amount0Min: ethers.BigNumber;
  amount1Min: ethers.BigNumber;
  deadline: ethers.BigNumberish;
};

export function v3Mint(cfg: ChainConfig, p: V3MintInput): ProposalAction {
  // The plugin's MintParams struct: no recipient (forced to the DAO).
  return action(requireV3(cfg), ifaceFor("UniswapV3Plugin"), "mint", [p],
    `Uniswap V3: mint ${p.token0}/${p.token1} fee ${p.fee} [${p.tickLower},${p.tickUpper}]`);
}

export function v3IncreaseLiquidity(
  cfg: ChainConfig,
  tokenId: ethers.BigNumberish,
  amount0Desired: ethers.BigNumber,
  amount1Desired: ethers.BigNumber,
  amount0Min: ethers.BigNumber,
  amount1Min: ethers.BigNumber,
  deadline: ethers.BigNumberish
): ProposalAction {
  return action(
    requireV3(cfg),
    ifaceFor("UniswapV3Plugin"),
    "increaseLiquidity",
    [tokenId, amount0Desired, amount1Desired, amount0Min, amount1Min, deadline],
    `Uniswap V3: increase liquidity on #${tokenId.toString()}`
  );
}

export function v3DecreaseLiquidity(
  cfg: ChainConfig,
  tokenId: ethers.BigNumberish,
  liquidity: ethers.BigNumberish,
  amount0Min: ethers.BigNumber,
  amount1Min: ethers.BigNumber,
  deadline: ethers.BigNumberish
): ProposalAction {
  return action(
    requireV3(cfg),
    ifaceFor("UniswapV3Plugin"),
    "decreaseLiquidity",
    [tokenId, liquidity, amount0Min, amount1Min, deadline],
    `Uniswap V3: decrease liquidity on #${tokenId.toString()}`
  );
}

export function v3Collect(
  cfg: ChainConfig,
  tokenId: ethers.BigNumberish,
  amount0Max: ethers.BigNumberish,
  amount1Max: ethers.BigNumberish
): ProposalAction {
  return action(requireV3(cfg), ifaceFor("UniswapV3Plugin"), "collect",
    [tokenId, amount0Max, amount1Max], `Uniswap V3: collect from #${tokenId.toString()}`);
}

export function v3Burn(cfg: ChainConfig, tokenId: ethers.BigNumberish): ProposalAction {
  return action(requireV3(cfg), ifaceFor("UniswapV3Plugin"), "burn", [tokenId],
    `Uniswap V3: burn #${tokenId.toString()}`);
}

// --- V3 preview-based action builders (governance-safe) ---------------------
//
// Each `previewV3*` builder calls the plugin's view function to fetch the
// EXACT Action[] the wrapper would execute, then returns them as
// ProposalAction[]. Submitting these via TokenVoting executes the batch
// atomically without the nested-dao.execute reentrancy.

function v3Contract(cfg: ChainConfig, provider: ethers.providers.Provider): ethers.Contract {
  return new ethers.Contract(requireV3(cfg), getAbi("UniswapV3Plugin"), provider);
}

export async function previewV3Mint(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  p: V3MintInput
): Promise<ProposalAction[]> {
  const actions = await v3Contract(cfg, provider).previewMintActions(p);
  return liftPreview(
    actions,
    `Uniswap V3: mint ${p.token0}/${p.token1} fee ${p.fee} [${p.tickLower},${p.tickUpper}]`
  );
}

export async function previewV3IncreaseLiquidity(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  tokenId: ethers.BigNumberish,
  amount0Desired: ethers.BigNumber,
  amount1Desired: ethers.BigNumber,
  amount0Min: ethers.BigNumber,
  amount1Min: ethers.BigNumber,
  deadline: ethers.BigNumberish
): Promise<ProposalAction[]> {
  const actions = await v3Contract(cfg, provider).previewIncreaseLiquidityActions(
    tokenId,
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    deadline
  );
  return liftPreview(actions, `Uniswap V3: increase liquidity on #${tokenId.toString()}`);
}

export async function previewV3DecreaseLiquidity(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  tokenId: ethers.BigNumberish,
  liquidity: ethers.BigNumberish,
  amount0Min: ethers.BigNumber,
  amount1Min: ethers.BigNumber,
  deadline: ethers.BigNumberish
): Promise<ProposalAction[]> {
  const actions = await v3Contract(cfg, provider).previewDecreaseLiquidityActions(
    tokenId,
    liquidity,
    amount0Min,
    amount1Min,
    deadline
  );
  return liftPreview(actions, `Uniswap V3: decrease liquidity on #${tokenId.toString()}`);
}

export async function previewV3Collect(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  tokenId: ethers.BigNumberish,
  amount0Max: ethers.BigNumberish,
  amount1Max: ethers.BigNumberish
): Promise<ProposalAction[]> {
  const actions = await v3Contract(cfg, provider).previewCollectActions(
    tokenId,
    amount0Max,
    amount1Max
  );
  return liftPreview(actions, `Uniswap V3: collect from #${tokenId.toString()}`);
}

export async function previewV3Burn(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  tokenId: ethers.BigNumberish
): Promise<ProposalAction[]> {
  const actions = await v3Contract(cfg, provider).previewBurnActions(tokenId);
  return liftPreview(actions, `Uniswap V3: burn #${tokenId.toString()}`);
}

// --- Uniswap V4 LP lifecycle (modifyLiquidities pass-through) --------------

/**
 * v4 LP op: the proposal builds the v4 action stream (`unlockData`) off-chain
 * via the Uniswap SDK; the plugin handles Permit2 approvals for input
 * currencies and enforces a `minOut` slippage check on output currencies.
 */
export function v4ModifyLiquidities(
  cfg: ChainConfig,
  unlockData: string,
  deadline: ethers.BigNumberish,
  inputCurrencies: string[],
  maxIn: ethers.BigNumber[],
  outputCurrencies: string[],
  minOut: ethers.BigNumber[]
): ProposalAction {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  return action(
    cfg.dao.uniswap,
    ifaceFor("UniswapV4Plugin"),
    "modifyLiquidities",
    [unlockData, deadline, inputCurrencies, maxIn, outputCurrencies, minOut],
    `Uniswap V4 LP: modifyLiquidities (${inputCurrencies.length} in, ${outputCurrencies.length} out)`
  );
}

// --- V4 LP: typed builders that encode unlockData on the frontend ----------
//
// Each typed builder composes the v4 action stream (`unlockData`) from
// human-friendly args, then routes it through the V4 plugin's
// `previewModifyLiquiditiesActions` to materialize the multi-action proposal.
// The DAO is always the position owner / take-pair recipient.

function v4ContractFor(cfg: ChainConfig, provider: ethers.providers.Provider): ethers.Contract {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  return new ethers.Contract(cfg.dao.uniswap, getAbi("UniswapV4Plugin"), provider);
}

const FAR_DEADLINE = (): number => Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

/** Mint a new V4 LP position (MINT_POSITION + SETTLE_PAIR). */
export async function previewV4Mint(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  args: {
    poolKey: V4PoolKey;
    tickLower: number;
    tickUpper: number;
    liquidity: ethers.BigNumberish;
    amount0Max: ethers.BigNumber;
    amount1Max: ethers.BigNumber;
    deadline?: ethers.BigNumberish;
  }
): Promise<ProposalAction[]> {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  const owner = cfg.dao.dao;
  const unlockData = v4EncMint({
    poolKey: args.poolKey,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    liquidity: args.liquidity,
    amount0Max: args.amount0Max,
    amount1Max: args.amount1Max,
    owner,
  });
  const deadline = args.deadline ?? FAR_DEADLINE();
  const actions = await v4ContractFor(cfg, provider).previewModifyLiquiditiesActions(
    unlockData,
    deadline,
    [args.poolKey.currency0, args.poolKey.currency1],
    [args.amount0Max, args.amount1Max]
  );
  return liftPreview(
    actions,
    `V4: mint position in ${args.poolKey.currency0}/${args.poolKey.currency1} fee ${args.poolKey.fee}, range [${args.tickLower},${args.tickUpper}], L=${args.liquidity.toString()}`
  );
}

/** Increase liquidity on an existing DAO-owned V4 position. */
export async function previewV4Increase(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  args: {
    poolKey: V4PoolKey;
    tokenId: ethers.BigNumberish;
    liquidity: ethers.BigNumberish;
    amount0Max: ethers.BigNumber;
    amount1Max: ethers.BigNumber;
    deadline?: ethers.BigNumberish;
  }
): Promise<ProposalAction[]> {
  const unlockData = v4EncIncrease({
    poolKey: args.poolKey,
    tokenId: args.tokenId,
    liquidity: args.liquidity,
    amount0Max: args.amount0Max,
    amount1Max: args.amount1Max,
  });
  const deadline = args.deadline ?? FAR_DEADLINE();
  const actions = await v4ContractFor(cfg, provider).previewModifyLiquiditiesActions(
    unlockData,
    deadline,
    [args.poolKey.currency0, args.poolKey.currency1],
    [args.amount0Max, args.amount1Max]
  );
  return liftPreview(actions, `V4: increase liquidity on #${args.tokenId.toString()}`);
}

/** Decrease liquidity; freed tokens + fees go to the DAO via TAKE_PAIR. */
export async function previewV4Decrease(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  args: {
    poolKey: V4PoolKey;
    tokenId: ethers.BigNumberish;
    liquidity: ethers.BigNumberish;
    amount0Min: ethers.BigNumberish;
    amount1Min: ethers.BigNumberish;
    deadline?: ethers.BigNumberish;
  }
): Promise<ProposalAction[]> {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  const unlockData = v4EncDecrease({
    poolKey: args.poolKey,
    tokenId: args.tokenId,
    liquidity: args.liquidity,
    amount0Min: args.amount0Min,
    amount1Min: args.amount1Min,
    recipient: cfg.dao.dao,
  });
  const deadline = args.deadline ?? FAR_DEADLINE();
  // Decrease has no input currencies; the v4 action stream's TAKE_PAIR sends
  // tokens TO the DAO, so no Permit2 approvals are needed.
  const actions = await v4ContractFor(cfg, provider).previewModifyLiquiditiesActions(
    unlockData,
    deadline,
    [],
    []
  );
  return liftPreview(actions, `V4: decrease liquidity on #${args.tokenId.toString()}`);
}

/** Collect-only (DECREASE_LIQUIDITY(0) + TAKE_PAIR) to sweep fees to the DAO. */
export async function previewV4Collect(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  args: {poolKey: V4PoolKey; tokenId: ethers.BigNumberish; deadline?: ethers.BigNumberish}
): Promise<ProposalAction[]> {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  const unlockData = v4EncCollect({
    poolKey: args.poolKey,
    tokenId: args.tokenId,
    recipient: cfg.dao.dao,
  });
  const deadline = args.deadline ?? FAR_DEADLINE();
  const actions = await v4ContractFor(cfg, provider).previewModifyLiquiditiesActions(
    unlockData,
    deadline,
    [],
    []
  );
  return liftPreview(actions, `V4: collect fees from #${args.tokenId.toString()}`);
}

/** Burn an empty position; sweeps any residual to the DAO. */
export async function previewV4Burn(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  args: {poolKey: V4PoolKey; tokenId: ethers.BigNumberish; deadline?: ethers.BigNumberish}
): Promise<ProposalAction[]> {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  const unlockData = v4EncBurn({
    poolKey: args.poolKey,
    tokenId: args.tokenId,
    amount0Min: 0,
    amount1Min: 0,
    recipient: cfg.dao.dao,
  });
  const deadline = args.deadline ?? FAR_DEADLINE();
  const actions = await v4ContractFor(cfg, provider).previewModifyLiquiditiesActions(
    unlockData,
    deadline,
    [],
    []
  );
  return liftPreview(actions, `V4: burn position #${args.tokenId.toString()}`);
}

/** Governance-safe builder: returns multi-action ProposalAction[] via
 *  UniswapV4Plugin.previewModifyLiquiditiesActions. */
export async function previewV4ModifyLiquidities(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  unlockData: string,
  deadline: ethers.BigNumberish,
  inputCurrencies: string[],
  maxIn: ethers.BigNumber[]
): Promise<ProposalAction[]> {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  const v4 = new ethers.Contract(cfg.dao.uniswap, getAbi("UniswapV4Plugin"), provider);
  const actions = await v4.previewModifyLiquiditiesActions(
    unlockData,
    deadline,
    inputCurrencies,
    maxIn
  );
  return liftPreview(
    actions,
    `Uniswap V4 LP: modifyLiquidities (${inputCurrencies.length} input currenc${inputCurrencies.length === 1 ? "y" : "ies"})`
  );
}

/** Governance-safe AAVE builders: each previewX returns multi-action
 *  ProposalAction[] from AaveLendingPlugin.previewX(...). */
function aaveContractFor(cfg: ChainConfig, provider: ethers.providers.Provider): ethers.Contract {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  return new ethers.Contract(cfg.dao.aave, getAbi("AaveLendingPlugin"), provider);
}

export async function previewAaveSupply(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  asset: string,
  amount: ethers.BigNumber
): Promise<ProposalAction[]> {
  const actions = await aaveContractFor(cfg, provider).previewSupplyActions(asset, amount);
  return liftPreview(actions, `AAVE: supply ${amount.toString()} ${asset}`);
}

export async function previewAaveWithdraw(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  asset: string,
  amount: ethers.BigNumber
): Promise<ProposalAction[]> {
  const actions = await aaveContractFor(cfg, provider).previewWithdrawActions(asset, amount);
  return liftPreview(actions, `AAVE: withdraw ${amount.toString()} ${asset}`);
}

export async function previewAaveBorrow(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  asset: string,
  amount: ethers.BigNumber,
  interestRateMode: number
): Promise<ProposalAction[]> {
  const actions = await aaveContractFor(cfg, provider).previewBorrowActions(
    asset,
    amount,
    interestRateMode
  );
  return liftPreview(actions, `AAVE: borrow ${amount.toString()} ${asset} (rateMode ${interestRateMode})`);
}

export async function previewAaveRepay(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  asset: string,
  amount: ethers.BigNumber,
  interestRateMode: number
): Promise<ProposalAction[]> {
  const actions = await aaveContractFor(cfg, provider).previewRepayActions(
    asset,
    amount,
    interestRateMode
  );
  return liftPreview(actions, `AAVE: repay ${amount.toString()} ${asset} (rateMode ${interestRateMode})`);
}

export function v4SetPositionManager(cfg: ChainConfig, newPositionManager: string): ProposalAction {
  if (!cfg.dao) throw new Error(`No DAO configured for chain ${cfg.chainId}`);
  return action(
    cfg.dao.uniswap,
    ifaceFor("UniswapV4Plugin"),
    "setV4PositionManager",
    [newPositionManager],
    `Uniswap V4: set PositionManager → ${newPositionManager}`
  );
}
