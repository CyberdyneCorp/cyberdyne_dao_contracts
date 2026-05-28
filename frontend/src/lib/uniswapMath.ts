// Light Uniswap V3/V4 concentrated-liquidity math for the LP form UX. Used to
// (1) snap human prices ↔ ticks, (2) derive liquidity L from desired amounts,
// (3) project L back to amount0/amount1 at the current pool price so we can
// compute amount0Max/amount1Max with slippage.
//
// All math is in JS floats — fine for UX-level previews and for *upper bounds*
// like amount0Max (we then add a slippage buffer on top, and the on-chain
// settlement enforces precise correctness). Don't use these helpers for
// settlement-critical math.

export const TICK_LOWER_MAX = -887272;
export const TICK_UPPER_MAX = 887272;
export const FULL_LOWER = -887220;
export const FULL_UPPER = 887220;

/** Snap a tick down (floor) or up (ceil) to the nearest multiple of `spacing`,
 *  clipped to the V3/V4 absolute range. */
export function snapTick(tick: number, spacing: number, dir: "down" | "up"): number {
  const fn = dir === "down" ? Math.floor : Math.ceil;
  const snapped = fn(tick / spacing) * spacing;
  return Math.max(TICK_LOWER_MAX, Math.min(TICK_UPPER_MAX, snapped));
}

/** Raw-units price (token1 per token0, both in atomic units) → tick. */
export function rawPriceToTick(rawPriceToken1PerToken0: number): number {
  if (rawPriceToken1PerToken0 <= 0) return 0;
  return Math.log(rawPriceToken1PerToken0) / Math.log(1.0001);
}

export function tickToRawPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

/** Human price (token1 per token0, both in display units) → raw price. */
export function humanPriceToRaw(humanPrice: number, dec0: number, dec1: number): number {
  return humanPrice * Math.pow(10, dec1 - dec0);
}

export function rawPriceToHuman(rawPrice: number, dec0: number, dec1: number): number {
  return rawPrice * Math.pow(10, dec0 - dec1);
}

function sqrtAt(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/** Standard Uniswap L from desired amounts + range, given the current tick.
 *  amounts in *atomic units* (i.e. parseUnits already applied). */
export function liquidityFromAmounts(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  amount0Atomic: number,
  amount1Atomic: number
): number {
  const sl = sqrtAt(tickLower);
  const su = sqrtAt(tickUpper);
  const sc = sqrtAt(currentTick);
  if (currentTick < tickLower) {
    return (amount0Atomic * (sl * su)) / (su - sl);
  }
  if (currentTick >= tickUpper) {
    return amount1Atomic / (su - sl);
  }
  const L0 = (amount0Atomic * (sc * su)) / (su - sc);
  const L1 = amount1Atomic / (sc - sl);
  return Math.min(L0, L1);
}

/** Project a given L back to the atomic amounts it consumes at currentTick.
 *  Inverse of liquidityFromAmounts — used to compute amount0Max / amount1Max. */
export function amountsFromLiquidity(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  L: number
): {amount0Atomic: number; amount1Atomic: number} {
  const sl = sqrtAt(tickLower);
  const su = sqrtAt(tickUpper);
  const sc = sqrtAt(currentTick);
  if (currentTick < tickLower) {
    return {amount0Atomic: (L * (su - sl)) / (sl * su), amount1Atomic: 0};
  }
  if (currentTick >= tickUpper) {
    return {amount0Atomic: 0, amount1Atomic: L * (su - sl)};
  }
  return {
    amount0Atomic: (L * (su - sc)) / (sc * su),
    amount1Atomic: L * (sc - sl),
  };
}
