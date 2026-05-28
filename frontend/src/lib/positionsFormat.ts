// Display helpers for the Uniswap V3/V4 positions table. Turns raw integers
// (ticks, fee, liquidity L, owed amounts) into human-readable strings with
// token symbols, fee %, and human price ranges.

import {ethers} from "ethers";
import type {ChainConfig} from "./types";
import {resolveToken, formatUnits} from "./format";
import {FULL_LOWER, FULL_UPPER, tickToRawPrice, rawPriceToHuman} from "./uniswapMath";

/** "USDC / WETH" or, for unknown tokens, short hex. */
export function formatPair(cfg: ChainConfig | undefined, addr0: string, addr1: string): string {
  return `${resolveToken(cfg, addr0).symbol} / ${resolveToken(cfg, addr1).symbol}`;
}

/** 3000 → "0.30%" */
export function formatFeePct(fee: number): string {
  return `${(fee / 10000).toFixed(2)}%`;
}

/** Compact decimal: 44_522_393_153_464 → "44.5T" */
export function formatCompact(n: ethers.BigNumberish): string {
  const asNum = Number(n.toString());
  if (!isFinite(asNum)) return n.toString();
  return new Intl.NumberFormat("en-US", {notation: "compact", maximumFractionDigits: 2}).format(asNum);
}

function formatNumber(n: number): string {
  if (n === 0) return "0";
  if (!isFinite(n) || n > 1e15) return "~∞";
  if (n < 1e-9) return "~0";
  if (n < 0.0001) return n.toExponential(3);
  if (n < 1) return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (n < 10) return n.toPrecision(5).replace(/0+$/, "").replace(/\.$/, "");
  if (n < 1e9) return n.toLocaleString("en-US", {maximumFractionDigits: 2});
  return n.toExponential(2);
}

/** Should we invert the natural token1/token0 price? We invert when the natural
 *  price is sub-1 (typical for token0=stablecoin, token1=ETH-class), so the
 *  rendered number is e.g. "2,425 USDC/WETH" instead of "0.000412 WETH/USDC". */
export function shouldInvertPrice(
  cfg: ChainConfig | undefined,
  addr0: string,
  addr1: string,
  referenceTick: number
): boolean {
  const t0 = resolveToken(cfg, addr0);
  const t1 = resolveToken(cfg, addr1);
  const human = rawPriceToHuman(tickToRawPrice(referenceTick), t0.decimals, t1.decimals);
  return human > 0 && human < 1;
}

/** Number + unit split, so the caller can render "min 2,378 → max 2,481 UNIT"
 *  with the unit appearing only once. */
export function tickPriceParts(
  tick: number,
  cfg: ChainConfig | undefined,
  addr0: string,
  addr1: string,
  invert = false
): {value: string; unit: string} {
  const t0 = resolveToken(cfg, addr0);
  const t1 = resolveToken(cfg, addr1);
  const natural = rawPriceToHuman(tickToRawPrice(tick), t0.decimals, t1.decimals);
  const value = invert ? (natural === 0 ? Infinity : 1 / natural) : natural;
  const unit = invert ? `${t0.symbol}/${t1.symbol}` : `${t1.symbol}/${t0.symbol}`;
  return {value: formatNumber(value), unit};
}

/** Friendly price label for a tick. Natural orientation is token1 per token0;
 *  `invert` flips it to token0 per token1 so the number reads larger.
 *  E.g. for USDC/WETH at tick 199951: natural "4.12e-4 WETH/USDC",
 *  inverted "2,427 USDC/WETH". */
export function tickPriceLabel(
  tick: number,
  cfg: ChainConfig | undefined,
  addr0: string,
  addr1: string,
  invert = false
): string {
  const {value, unit} = tickPriceParts(tick, cfg, addr0, addr1, invert);
  return `${value} ${unit}`;
}

/** Returns a primary + secondary string pair for a position's tick range, plus
 *  an in-range badge when a pool's current tick is provided.
 *  - isFull (tickLower/Upper at the V3 limits): primary = "Full range", and
 *    secondary becomes "current ~<price>" so the row still tells you what the
 *    pair is priced at right now.
 *  - bounded: primary = "<min> → <max>", secondary = ticks; status reflects
 *    whether currentTick is inside the range. */
export function formatRange(
  tickLower: number,
  tickUpper: number,
  cfg: ChainConfig | undefined,
  addr0: string,
  addr1: string,
  currentTick?: number
): {
  primary: string;
  secondary: string;
  isFull: boolean;
  status: "in" | "below" | "above" | null;
} {
  const isFull = tickLower <= FULL_LOWER + 1 && tickUpper >= FULL_UPPER - 1;
  const status =
    currentTick === undefined
      ? null
      : currentTick < tickLower
        ? ("below" as const)
        : currentTick >= tickUpper
          ? ("above" as const)
          : ("in" as const);
  // Pick orientation once per row so lower/upper/current all read the same way.
  // Prefer the current tick as the reference; fall back to the range midpoint.
  const refTick = currentTick !== undefined ? currentTick : Math.floor((tickLower + tickUpper) / 2);
  const invert = shouldInvertPrice(cfg, addr0, addr1, refTick);
  // Inversion is monotonically decreasing, so the lower-tick price becomes the
  // upper bound and vice versa when we flip.
  const aParts = tickPriceParts(tickLower, cfg, addr0, addr1, invert);
  const bParts = tickPriceParts(tickUpper, cfg, addr0, addr1, invert);
  const minParts = invert ? bParts : aParts;
  const maxParts = invert ? aParts : bParts;
  const minMaxLine = `min ${minParts.value}  →  max ${maxParts.value} ${minParts.unit}`;
  if (isFull) {
    // Full range = essentially [0, ∞]. We still show the literal min/max so it's
    // explicit what "Full range" means in price terms.
    const sub =
      currentTick !== undefined
        ? `current ~${tickPriceLabel(currentTick, cfg, addr0, addr1, invert)}`
        : `[${tickLower}, ${tickUpper}]`;
    return {primary: `Full range · ${minMaxLine}`, secondary: sub, isFull: true, status};
  }
  const sub =
    currentTick !== undefined
      ? `now ${tickPriceParts(currentTick, cfg, addr0, addr1, invert).value} · ticks [${tickLower}, ${tickUpper}]`
      : `ticks [${tickLower}, ${tickUpper}]`;
  return {primary: minMaxLine, secondary: sub, isFull: false, status};
}

/** "0 USDC / 0 WETH" — falls back to "—" when both amounts are zero. */
export function formatPairAmounts(
  cfg: ChainConfig | undefined,
  amount0: ethers.BigNumberish,
  amount1: ethers.BigNumberish,
  addr0: string,
  addr1: string
): string {
  const a0 = ethers.BigNumber.from(amount0);
  const a1 = ethers.BigNumber.from(amount1);
  if (a0.isZero() && a1.isZero()) return "—";
  const t0 = resolveToken(cfg, addr0);
  const t1 = resolveToken(cfg, addr1);
  return `${formatUnits(a0, t0.decimals)} ${t0.symbol} / ${formatUnits(a1, t1.decimals)} ${t1.symbol}`;
}
