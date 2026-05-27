// Pre-submit pool-state preview for Uniswap V4 LP forms — the V4 analogue of
// `readV3PoolState`. v4 keeps pool state inside the singleton PoolManager and
// exposes reads through the periphery `StateView` lens contract, so this needs
// a per-chain `UNISWAP_V4_STATE_VIEW` address in the address book. It is
// feature-flagged (like the subgraph / IPFS integrations): absent address →
// `v4QuoteEnabled` is false and the form hides the quote button rather than
// guessing an address.

import {ethers} from "ethers";
import type {ChainConfig} from "./types";
import type {PoolKey} from "./v4Encode";

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
];

export type V4PoolState = {
  poolId: string;
  sqrtPriceX96: ethers.BigNumber;
  tick: number;
  liquidity: ethers.BigNumber;
  rawPriceToken1PerToken0: number;
  inRange: (tickLower: number, tickUpper: number) => boolean;
};

/** True when this chain has a StateView address configured (quotes available). */
export function v4QuoteEnabled(cfg: ChainConfig): boolean {
  return Boolean(cfg.external?.UNISWAP_V4_STATE_VIEW);
}

/**
 * v4 PoolId = keccak256(abi.encode(PoolKey)) — the same derivation
 * `PoolIdLibrary.toId` uses on-chain. Field order matches the Solidity struct:
 * (currency0, currency1, fee, tickSpacing, hooks).
 */
export function v4PoolId(k: PoolKey): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint24", "int24", "address"],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]
    )
  );
}

/**
 * Read the live slot0 (sqrtPriceX96 / tick) + liquidity for a v4 pool via the
 * StateView lens, so the LP form can show the current tick + an in/below/above
 * range verdict before a proposal is built. Float price math is fine for a UI
 * preview — any operational LP op still uses on-chain amounts at execution.
 *
 * Throws if no StateView is configured for the chain, or (via the underlying
 * call) if the pool is uninitialized — the form should surface that as "no
 * live pool" rather than building a doomed proposal.
 */
export async function readV4PoolState(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  poolKey: PoolKey
): Promise<V4PoolState> {
  const sv = cfg.external?.UNISWAP_V4_STATE_VIEW;
  if (!sv) {
    throw new Error(
      "No UNISWAP_V4_STATE_VIEW configured for this chain — add it to the address book to enable V4 quotes."
    );
  }
  const poolId = v4PoolId(poolKey);
  const stateView = new ethers.Contract(sv, STATE_VIEW_ABI, provider);
  const [slot0, liquidity] = await Promise.all([
    stateView.getSlot0(poolId),
    stateView.getLiquidity(poolId),
  ]);
  const sqrtPriceX96 = slot0.sqrtPriceX96 as ethers.BigNumber;
  const ratio = parseFloat(sqrtPriceX96.toString()) / 2 ** 96;
  const tick = Number(slot0.tick);
  return {
    poolId,
    sqrtPriceX96,
    tick,
    liquidity,
    rawPriceToken1PerToken0: ratio * ratio,
    inRange: (tickLower: number, tickUpper: number) => tick >= tickLower && tick < tickUpper,
  };
}
