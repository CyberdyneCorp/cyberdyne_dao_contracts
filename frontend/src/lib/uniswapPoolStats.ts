// Uniswap-grade pool analytics (volume / fees / APR / history) sourced from
// Uniswap's official subgraphs on The Graph's decentralized network.
//
// WHY a separate client from `subgraph.ts`: that one queries the *Cyberdyne
// DAO* subgraph (DAO-initiated swaps/positions). This one queries *Uniswap's*
// subgraph for whole-pool, market-wide stats keyed by pool address (V3) or
// poolId (V4) — the same data Uniswap's own UI renders.
//
// FORK NOTE: the subgraph indexes REAL mainnet. The frontend usually runs on a
// mainnet fork, where the pools mirror real mainnet at the fork block — so
// pool-level aggregates are valid. The DAO's *fork-local* positions never reach
// the subgraph; those keep coming from RPC reads. This is purely additive.
//
// Feature-flagged like the other integrations: no endpoint configured →
// `uniswapStatsEnabled()` is false and the UI just omits the extra columns.

import {env} from "$env/dynamic/public";

export type UniswapVersion = "v3" | "v4";

/** Gateway endpoint for a Uniswap subgraph version, or undefined when unset.
 *  Expected form: https://gateway.thegraph.com/api/<KEY>/subgraphs/id/<ID> */
export function uniswapSubgraphUrl(version: UniswapVersion): string | undefined {
  const raw = version === "v3" ? env.PUBLIC_UNISWAP_V3_SUBGRAPH_URL : env.PUBLIC_UNISWAP_V4_SUBGRAPH_URL;
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function uniswapStatsEnabled(version: UniswapVersion): boolean {
  return uniswapSubgraphUrl(version) !== undefined;
}

export type PoolDayPoint = {
  date: number;
  volumeUSD: number;
  feesUSD: number;
  /** Day-close price as token0-per-token1 (subgraph `close`, decimal-adjusted).
   *  The card re-orients this to match its spot label. 0 when unavailable. */
  priceClose: number;
};

export type UniswapPoolStats = {
  tvlUSD: number;
  /** Cumulative all-time volume/fees (subgraph running totals). */
  volumeUSDAllTime: number;
  feesUSDAllTime: number;
  /** Trailing windows derived from poolDayData. */
  volume1dUSD: number;
  volume30dUSD: number;
  fees1dUSD: number;
  /** Fee APR = trailing-24h fees annualized / TVL. Null when TVL is zero. */
  aprPct: number | null;
  /** Ascending-by-date day points (oldest → newest) for a sparkline. */
  days: PoolDayPoint[];
};

type RawPool = {
  totalValueLockedUSD: string;
  volumeUSD: string;
  feesUSD: string;
  poolDayData: {date: number; volumeUSD: string; feesUSD: string; tvlUSD: string; close: string}[];
} | null;

const POOL_QUERY = `query Pool($id: ID!) {
  pool(id: $id) {
    totalValueLockedUSD
    volumeUSD
    feesUSD
    poolDayData(first: 30, orderBy: date, orderDirection: desc) {
      date
      volumeUSD
      feesUSD
      tvlUSD
      close
    }
  }
}`;

// Module-level memo: pool stats don't change second-to-second and the lists
// re-render often, so cache by `${version}:${id}` for the session.
const cache = new Map<string, UniswapPoolStats | null>();

function num(s: string | number | undefined): number {
  const n = typeof s === "number" ? s : parseFloat(s ?? "0");
  return isFinite(n) ? n : 0;
}

/**
 * Fetch whole-pool stats for a V3 pool address or a V4 poolId (both lowercase
 * hex). Returns null when the pool isn't indexed (e.g. a brand-new or
 * fork-only pool) or on any query error — callers treat null as "no data".
 */
export async function fetchUniswapPoolStats(
  version: UniswapVersion,
  poolRef: string
): Promise<UniswapPoolStats | null> {
  const url = uniswapSubgraphUrl(version);
  if (!url) return null;
  const id = poolRef.toLowerCase();
  const cacheKey = `${version}:${id}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let stats: UniswapPoolStats | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({query: POOL_QUERY, variables: {id}}),
    });
    if (res.ok) {
      const json = (await res.json()) as {data?: {pool: RawPool}; errors?: unknown};
      const pool = json.data?.pool;
      if (pool) {
        // poolDayData comes newest-first; reverse to ascending for the sparkline.
        const daysDesc = pool.poolDayData ?? [];
        const days: PoolDayPoint[] = daysDesc
          .map((d) => ({date: d.date, volumeUSD: num(d.volumeUSD), feesUSD: num(d.feesUSD), priceClose: num(d.close)}))
          .reverse();
        const tvlUSD = num(pool.totalValueLockedUSD);
        const fees1dUSD = daysDesc.length ? num(daysDesc[0].feesUSD) : 0;
        const volume1dUSD = daysDesc.length ? num(daysDesc[0].volumeUSD) : 0;
        const volume30dUSD = days.reduce((s, d) => s + d.volumeUSD, 0);
        stats = {
          tvlUSD,
          volumeUSDAllTime: num(pool.volumeUSD),
          feesUSDAllTime: num(pool.feesUSD),
          volume1dUSD,
          volume30dUSD,
          fees1dUSD,
          aprPct: tvlUSD > 0 ? (fees1dUSD * 365 * 100) / tvlUSD : null,
          days,
        };
      }
    }
  } catch {
    // Network/parse error → leave null; the card falls back to on-chain stats.
  }
  cache.set(cacheKey, stats);
  return stats;
}

/** Average daily fees (USD) over the last `days` COMPLETE days — drops the
 *  current partial day so a fresh-UTC reading doesn't crater the APR estimate. */
export function avgDailyFeesUSD(stats: UniswapPoolStats | null, days = 7): number {
  if (!stats) return 0;
  const complete = stats.days.length > 1 ? stats.days.slice(0, -1) : stats.days;
  const window = complete.slice(-days);
  if (!window.length) return stats.fees1dUSD;
  return window.reduce((s, d) => s + d.feesUSD, 0) / window.length;
}

/** Compact USD: $1.2M / $48.9K / $12.34 / "—". */
export function formatUsdCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1000) {
    return "$" + new Intl.NumberFormat("en-US", {notation: "compact", maximumFractionDigits: 2}).format(n);
  }
  return "$" + n.toLocaleString("en-US", {maximumFractionDigits: 2});
}

/** "2.36%" / "—". */
export function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

// ---- Liquidity depth (per-tick) for the range chart histogram ----

/** One depth bar: active liquidity over the tick band [lo, hi). */
export type DepthBar = {lo: number; hi: number; liq: number};

const ticksCache = new Map<string, {tickIdx: number; liquidityNet: string}[] | null>();

/**
 * Fetch initialized ticks within ±`windowTicks` of the current tick. Each tick
 * carries `liquidityNet` (the L added/removed when price crosses it upward).
 * Returns ascending by tickIdx, or null on miss/error.
 */
export async function fetchPoolTicks(
  version: UniswapVersion,
  poolRef: string,
  currentTick: number,
  windowTicks = 10000
): Promise<{tickIdx: number; liquidityNet: string}[] | null> {
  const url = uniswapSubgraphUrl(version);
  if (!url) return null;
  const id = poolRef.toLowerCase();
  const lo = currentTick - windowTicks;
  const hi = currentTick + windowTicks;
  const cacheKey = `${version}:${id}:${lo}:${hi}`;
  if (ticksCache.has(cacheKey)) return ticksCache.get(cacheKey)!;

  // V3 indexes a flat `poolAddress` on Tick; V4 nests it under `pool`.
  const filter = version === "v3" ? `poolAddress:"${id}"` : `pool:"${id}"`;
  const query = `{ ticks(first: 1000, orderBy: tickIdx, where: {${filter}, tickIdx_gte: ${lo}, tickIdx_lte: ${hi}}) { tickIdx liquidityNet } }`;
  let ticks: {tickIdx: number; liquidityNet: string}[] | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({query}),
    });
    if (res.ok) {
      const json = (await res.json()) as {data?: {ticks: {tickIdx: string; liquidityNet: string}[]}};
      const raw = json.data?.ticks;
      if (raw) ticks = raw.map((t) => ({tickIdx: Number(t.tickIdx), liquidityNet: t.liquidityNet}));
    }
  } catch {
    // leave null
  }
  ticksCache.set(cacheKey, ticks);
  return ticks;
}

/**
 * Reconstruct active liquidity per tick band by anchoring at the pool's current
 * liquidity and walking `liquidityNet` outward (up: +net on cross, down: −net).
 * Pure — `currentLiquidity` is the pool's live in-range L. Negative bands
 * (window doesn't reach the bottom) clamp to 0.
 */
export function buildDepthBars(
  ticks: {tickIdx: number; liquidityNet: string}[] | null,
  currentTick: number,
  currentLiquidity: number
): DepthBar[] {
  if (!ticks || ticks.length === 0 || !(currentLiquidity > 0)) return [];
  const T = ticks.map((t) => ({tick: t.tickIdx, net: BigInt(t.liquidityNet)})).sort((a, b) => a.tick - b.tick);
  const bars: DepthBar[] = [];
  const toNum = (b: bigint) => Math.max(0, Number(b));
  const L0 = BigInt(Math.round(currentLiquidity));

  // Upward: band [prev, t) holds L; crossing t adds net.
  let L = L0;
  let prev = currentTick;
  for (const t of T) {
    if (t.tick <= currentTick) continue;
    bars.push({lo: prev, hi: t.tick, liq: toNum(L)});
    L += t.net;
    prev = t.tick;
  }
  // Downward: band [t, next) holds L; crossing below t removes net.
  L = L0;
  let next = currentTick;
  for (let i = T.length - 1; i >= 0; i--) {
    const t = T[i];
    if (t.tick > currentTick) continue;
    bars.push({lo: t.tick, hi: next, liq: toNum(L)});
    L -= t.net;
    next = t.tick;
  }
  return bars;
}

// ---- Price history for the range chart (multi-timeframe) ----

export type Timeframe = "1D" | "1W" | "1M" | "1Y" | "ALL";
export const TIMEFRAMES: Timeframe[] = ["1D", "1W", "1M", "1Y", "ALL"];

/** A single close-price sample (price = token0-per-token1, decimal-adjusted). */
export type PricePoint = {time: number; price: number};
/** Hourly (≤7d) + daily (≤1y) close series, each oldest→newest. */
export type PriceHistory = {hours: PricePoint[]; days: PricePoint[]};

const HISTORY_QUERY = `query Hist($id: ID!) {
  pool(id: $id) {
    poolHourData(first: 168, orderBy: periodStartUnix, orderDirection: desc) {
      periodStartUnix
      close
    }
    poolDayData(first: 365, orderBy: date, orderDirection: desc) {
      date
      close
    }
  }
}`;

const historyCache = new Map<string, PriceHistory | null>();

/** Fetch hourly (7d) + daily (1y) close history for a pool, for the range
 *  chart's 1D/1W/1M/1Y/All timeframes. Returns null on miss/error. */
export async function fetchPriceHistory(
  version: UniswapVersion,
  poolRef: string
): Promise<PriceHistory | null> {
  const url = uniswapSubgraphUrl(version);
  if (!url) return null;
  const id = poolRef.toLowerCase();
  const cacheKey = `${version}:${id}`;
  if (historyCache.has(cacheKey)) return historyCache.get(cacheKey)!;

  let history: PriceHistory | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({query: HISTORY_QUERY, variables: {id}}),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        data?: {pool: {poolHourData: {periodStartUnix: number; close: string}[]; poolDayData: {date: number; close: string}[]} | null};
      };
      const pool = json.data?.pool;
      if (pool) {
        history = {
          hours: (pool.poolHourData ?? [])
            .map((d) => ({time: d.periodStartUnix, price: num(d.close)}))
            .reverse(),
          days: (pool.poolDayData ?? [])
            .map((d) => ({time: d.date, price: num(d.close)}))
            .reverse(),
        };
      }
    }
  } catch {
    // leave null
  }
  historyCache.set(cacheKey, history);
  return history;
}

/** Build oriented price series for every timeframe from a fetched history.
 *  `invert=true` keeps the subgraph orientation (token0 per token1); false
 *  flips to token1 per token0 — matching the card/quote spot label. */
export function orientedSeries(history: PriceHistory | null, invert: boolean): Record<Timeframe, number[]> {
  const o = (pts: PricePoint[]) =>
    pts.map((p) => (p.price > 0 ? (invert ? p.price : 1 / p.price) : 0)).filter((p) => p > 0 && isFinite(p));
  const h = history?.hours ?? [];
  const d = history?.days ?? [];
  return {
    "1D": o(h.slice(-24)),
    "1W": o(h.slice(-168)),
    "1M": o(d.slice(-30)),
    "1Y": o(d.slice(-365)),
    ALL: o(d),
  };
}

/** Re-orient the day-close prices to match the card's spot label. The subgraph
 *  `close` is token0-per-token1; pass `invert=true` when the card shows that
 *  orientation (token0 per token1), false to flip to token1 per token0. Drops
 *  days with no price. Returns oldest→newest. */
export function orientedPrices(days: PoolDayPoint[], invert: boolean): number[] {
  return days
    .map((d) => (d.priceClose > 0 ? (invert ? d.priceClose : 1 / d.priceClose) : 0))
    .filter((p) => p > 0 && isFinite(p));
}

/** Percent change first→last of a series, or null when undeterminable. */
export function pctChange(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (!(first > 0)) return null;
  return ((last - first) / first) * 100;
}

/** Build an SVG polyline `points` string (0..W × 0..H, y-flipped) for a tiny
 *  volume sparkline. Returns "" when there's nothing to plot. */
export function sparklinePoints(values: number[], width = 96, height = 24): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 0);
  if (max <= 0) return "";
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
