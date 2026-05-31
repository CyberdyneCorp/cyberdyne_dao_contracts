// Uniswap-style pool analytics for the positions view. Everything here is
// derived purely from on-chain reads we already do (pool slot0/tick, position
// liquidity L, and — for V3 — the pool's ERC20 reserves), so it works on a
// bare fork with no subgraph or price feed.
//
//   - positionUnderlying:  L + range + current tick → the token0/token1 amounts
//                          the position actually holds right now.
//   - usdValue:            value a (token0, token1) pair in USD *when one leg is
//                          a known stablecoin*, using the pool's own price.
//   - buildPoolGroups:     collapse the flat position lists into per-pool cards
//                          (pair, fee, spot price, reserves/TVL, DAO exposure)
//                          mirroring Uniswap's pool list/detail surface.
//
// Volume / APR / fee-history / charts are intentionally NOT here: those need an
// indexer (the subgraph only tracks DAO-initiated swaps, not pool-wide flow).

import {ethers} from "ethers";
import type {ChainConfig} from "./types";
import {resolveToken} from "./format";
import {amountsFromLiquidity, rawPriceToHuman, tickToRawPrice, FULL_LOWER, FULL_UPPER} from "./uniswapMath";
import type {V3PositionRead, V3PoolState} from "./v3Positions";
import type {V4PositionRead} from "./v4Positions";
import type {V4PoolState} from "./v4Quote";

/** Symbols we treat as ≈ $1 so we can derive a USD price from the pool itself. */
const STABLES = new Set(["USDC", "USDT", "DAI"]);

/** Human-unit token amounts a position's liquidity maps to at the current tick.
 *  Float math — fine for a read-only display; settlement uses on-chain amounts. */
export function positionUnderlying(
  poolTick: number,
  tickLower: number,
  tickUpper: number,
  liquidity: ethers.BigNumberish,
  dec0: number,
  dec1: number
): {amount0: number; amount1: number} {
  const L = parseFloat(ethers.BigNumber.from(liquidity).toString());
  if (!isFinite(L) || L <= 0) return {amount0: 0, amount1: 0};
  const {amount0Atomic, amount1Atomic} = amountsFromLiquidity(poolTick, tickLower, tickUpper, L);
  return {amount0: amount0Atomic / 10 ** dec0, amount1: amount1Atomic / 10 ** dec1};
}

/** USD value of (amount0Human, amount1Human) using the pool's own price, but
 *  only when one leg is a known stablecoin (≈ $1). Returns null otherwise — we
 *  refuse to invent a price for two volatile assets with no oracle. */
export function usdValue(
  cfg: ChainConfig | undefined,
  addr0: string,
  addr1: string,
  amount0Human: number,
  amount1Human: number,
  rawPriceToken1PerToken0: number
): number | null {
  const t0 = resolveToken(cfg, addr0);
  const t1 = resolveToken(cfg, addr1);
  // Human price = how many token1 (display units) per 1 token0 (display units).
  const humanT1perT0 = rawPriceToHuman(rawPriceToken1PerToken0, t0.decimals, t1.decimals);
  if (STABLES.has(t0.symbol)) {
    // token0 ≈ $1; 1 token1 = 1 / humanT1perT0 token0.
    return humanT1perT0 > 0 ? amount0Human + amount1Human / humanT1perT0 : null;
  }
  if (STABLES.has(t1.symbol)) {
    // token1 ≈ $1; 1 token0 = humanT1perT0 token1.
    return amount1Human + amount0Human * humanT1perT0;
  }
  return null;
}

/** USD price of 1 (human) token0 and token1, derived from the pool price when
 *  one leg is a stablecoin. Null when neither leg is priceable. */
export function tokenUsdPrices(
  cfg: ChainConfig | undefined,
  addr0: string,
  addr1: string,
  rawPriceToken1PerToken0: number
): {usd0: number; usd1: number} | null {
  const t0 = resolveToken(cfg, addr0);
  const t1 = resolveToken(cfg, addr1);
  const humanT1perT0 = rawPriceToHuman(rawPriceToken1PerToken0, t0.decimals, t1.decimals);
  if (STABLES.has(t0.symbol)) return humanT1perT0 > 0 ? {usd0: 1, usd1: 1 / humanT1perT0} : null;
  if (STABLES.has(t1.symbol)) return {usd0: humanT1perT0, usd1: 1};
  return null;
}

export type AprEstimate = {
  /** Fee APR earned *while the price is inside the range* (instantaneous). */
  aprInRangePct: number;
  /** Fraction (0–1) of the sampled price history that sat inside the range. */
  timeInRange: number;
  /** in-range APR × time-in-range — a realism-weighted blended estimate. */
  aprAdjustedPct: number;
  /** Liquidity-per-dollar vs a full-range position (the concentration boost). */
  capitalEfficiency: number;
};

/**
 * Estimate a concentrated-liquidity position's fee APR — the method Uniswap's
 * UI uses:
 *   pool_fee_APR    = fees_24h × 365 / TVL          (the full-range baseline)
 *   capEff          = L_per_$(range) / L_per_$(full range)   (concentration boost)
 *   APR_in_range    = pool_fee_APR × capEff         (earned while price in range)
 *   APR_adjusted    = APR_in_range × time_in_range  (empirical, from price history)
 * L_per_$ depends only on the range + current price, so the estimate is
 * size-independent. Excludes impermanent loss, gas, and assumes the recent fee
 * rate persists — a planning aid, not a guarantee.
 */
export function estimatePositionApr(p: {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  dec0: number;
  dec1: number;
  usd0: number;
  usd1: number;
  feesUSD24h: number;
  tvlUSD: number;
  /** Oriented price samples for the time-in-range backtest. */
  priceSeries: number[];
  /** Display-oriented band bounds for the time-in-range test. */
  minPrice: number;
  maxPrice: number;
}): AprEstimate | null {
  if (!(p.tvlUSD > 0) || !(p.feesUSD24h >= 0)) return null;
  const L = 1e18; // arbitrary probe; the scale cancels in the capEff ratio
  const capUsd = (tickL: number, tickU: number): number => {
    const {amount0Atomic, amount1Atomic} = amountsFromLiquidity(p.currentTick, tickL, tickU, L);
    return (amount0Atomic / 10 ** p.dec0) * p.usd0 + (amount1Atomic / 10 ** p.dec1) * p.usd1;
  };
  const cap = capUsd(p.tickLower, p.tickUpper);
  const capFull = capUsd(FULL_LOWER, FULL_UPPER);
  if (!(cap > 0) || !(capFull > 0)) return null;
  // L per $1 = L/cap; capEff = that, relative to full range.
  const capitalEfficiency = capFull / cap;

  const poolFeeAprPct = (p.feesUSD24h * 365 * 100) / p.tvlUSD;
  const aprInRangePct = poolFeeAprPct * capitalEfficiency;

  const lo = Math.min(p.minPrice, p.maxPrice);
  const hi = Math.max(p.minPrice, p.maxPrice);
  const inWin = p.priceSeries.filter((x) => x >= lo && x <= hi).length;
  const timeInRange = p.priceSeries.length
    ? inWin / p.priceSeries.length
    : p.currentTick >= p.tickLower && p.currentTick < p.tickUpper
      ? 1
      : 0;

  return {aprInRangePct, timeInRange, aprAdjustedPct: aprInRangePct * timeInRange, capitalEfficiency};
}

/** "$1,234" / "$12.34" / "<$0.01" / "—" (null). */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return "$" + n.toLocaleString("en-US", {maximumFractionDigits: n < 1000 ? 2 : 0});
}

/** Compact human token amount: "0", "0.0042", "2,427.5", "1.2M". */
export function formatAmt(n: number): string {
  if (n === 0) return "0";
  if (!isFinite(n)) return "∞";
  if (n < 0.0001) return n.toExponential(2);
  if (n < 1) return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (n < 1e6) return n.toLocaleString("en-US", {maximumFractionDigits: 4});
  return new Intl.NumberFormat("en-US", {notation: "compact", maximumFractionDigits: 2}).format(n);
}

/** Spot price as "1 WETH = 2,427.50 USDC", orienting so the printed number is
 *  ≥ 1 when possible (matches how Uniswap quotes the pair). */
export function spotPriceLabel(
  cfg: ChainConfig | undefined,
  addr0: string,
  addr1: string,
  tick: number
): string {
  const t0 = resolveToken(cfg, addr0);
  const t1 = resolveToken(cfg, addr1);
  const t1PerT0 = rawPriceToHuman(tickToRawPrice(tick), t0.decimals, t1.decimals);
  if (!isFinite(t1PerT0) || t1PerT0 <= 0) return "—";
  // Quote the cheaper unit in terms of the more expensive one so the number reads big.
  if (t1PerT0 >= 1) return `1 ${t0.symbol} = ${formatAmt(t1PerT0)} ${t1.symbol}`;
  return `1 ${t1.symbol} = ${formatAmt(1 / t1PerT0)} ${t0.symbol}`;
}

/** One Uniswap-style pool row aggregating every DAO position in that pool. */
export type PoolGroup = {
  key: string;
  version: "v3" | "v4";
  token0: string;
  token1: string;
  fee: number;
  tickSpacing?: number;
  hooks?: string;
  /** On-chain V3 pool address — the key for the Uniswap V3 subgraph. */
  poolAddress?: string;
  /** V4 poolId (keccak of the PoolKey) — the key for the Uniswap V4 subgraph. */
  poolId?: string;
  /** Live pool tick / price — undefined when the pool-state read didn't land. */
  tick?: number;
  rawPriceToken1PerToken0?: number;
  /** Whole-pool reserves (human units). V3 only — V4 pools share a singleton. */
  reserve0?: number;
  reserve1?: number;
  poolTvlUsd?: number | null;
  /** DAO's exposure across its positions in this pool. */
  positionCount: number;
  daoAmount0: number;
  daoAmount1: number;
  daoUsd: number | null;
};

function v3Key(p: V3PositionRead): string {
  return `${p.token0.toLowerCase()}|${p.token1.toLowerCase()}|${p.fee}`;
}
function v4Key(p: V4PositionRead): string {
  const k = p.poolKey;
  return `${k.currency0.toLowerCase()}|${k.currency1.toLowerCase()}|${k.fee}|${k.tickSpacing}|${k.hooks.toLowerCase()}`;
}

/** Collapse the flat V3 + V4 position lists into per-pool groups, folding in the
 *  live pool state (price, reserves) hydrated by the ViewModel. Sorted by DAO
 *  USD exposure desc (then position count) so the richest pools surface first. */
export function buildPoolGroups(
  cfg: ChainConfig | undefined,
  v3: V3PositionRead[],
  v4: V4PositionRead[],
  v3PoolStates: Record<string, V3PoolState>,
  v4PoolStates: Record<string, V4PoolState>
): PoolGroup[] {
  const groups = new Map<string, PoolGroup>();

  for (const p of v3) {
    const key = v3Key(p);
    const state = v3PoolStates[key];
    const dec0 = resolveToken(cfg, p.token0).decimals;
    const dec1 = resolveToken(cfg, p.token1).decimals;
    let g = groups.get(key);
    if (!g) {
      const reserve0 = state?.reserve0 ? parseFloat(ethers.utils.formatUnits(state.reserve0, dec0)) : undefined;
      const reserve1 = state?.reserve1 ? parseFloat(ethers.utils.formatUnits(state.reserve1, dec1)) : undefined;
      const poolTvlUsd =
        state && reserve0 !== undefined && reserve1 !== undefined
          ? usdValue(cfg, p.token0, p.token1, reserve0, reserve1, state.rawPriceToken1PerToken0)
          : undefined;
      g = {
        key, version: "v3", token0: p.token0, token1: p.token1, fee: p.fee,
        poolAddress: state?.poolAddress,
        tick: state?.tick, rawPriceToken1PerToken0: state?.rawPriceToken1PerToken0,
        reserve0, reserve1, poolTvlUsd,
        positionCount: 0, daoAmount0: 0, daoAmount1: 0, daoUsd: state ? 0 : null,
      };
      groups.set(key, g);
    }
    g.positionCount++;
    if (state) {
      const {amount0, amount1} = positionUnderlying(state.tick, p.tickLower, p.tickUpper, p.liquidity, dec0, dec1);
      g.daoAmount0 += amount0;
      g.daoAmount1 += amount1;
      const usd = usdValue(cfg, p.token0, p.token1, amount0, amount1, state.rawPriceToken1PerToken0);
      g.daoUsd = usd === null ? g.daoUsd : (g.daoUsd ?? 0) + usd;
    }
  }

  for (const p of v4) {
    const key = v4Key(p);
    const k = p.poolKey;
    const state = v4PoolStates[key];
    const dec0 = resolveToken(cfg, k.currency0).decimals;
    const dec1 = resolveToken(cfg, k.currency1).decimals;
    let g = groups.get(key);
    if (!g) {
      g = {
        key, version: "v4", token0: k.currency0, token1: k.currency1, fee: k.fee,
        tickSpacing: k.tickSpacing, hooks: k.hooks,
        poolId: state?.poolId,
        tick: state?.tick, rawPriceToken1PerToken0: state?.rawPriceToken1PerToken0,
        positionCount: 0, daoAmount0: 0, daoAmount1: 0, daoUsd: state ? 0 : null,
      };
      groups.set(key, g);
    }
    g.positionCount++;
    if (state) {
      const {amount0, amount1} = positionUnderlying(state.tick, p.tickLower, p.tickUpper, p.liquidity, dec0, dec1);
      g.daoAmount0 += amount0;
      g.daoAmount1 += amount1;
      const usd = usdValue(cfg, k.currency0, k.currency1, amount0, amount1, state.rawPriceToken1PerToken0);
      g.daoUsd = usd === null ? g.daoUsd : (g.daoUsd ?? 0) + usd;
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => (b.daoUsd ?? 0) - (a.daoUsd ?? 0) || b.positionCount - a.positionCount
  );
}
