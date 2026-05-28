// Uniswap V3 + V4 positions ViewModel (MVVM). Owns the full LP-lifecycle form
// state + commands and the DAO-owned-positions read. View only binds + renders.

import {ethers} from "ethers";
import {writable, get} from "svelte/store";
import {wallet} from "$lib/wallet";
import {chainConfig} from "$lib/chains";
import {uniswapV3Contract} from "$lib/contracts";
import * as actions from "$lib/actions";
import type {ProposalAction} from "$lib/actions";
import type {ChainConfig} from "$lib/types";
import {toasts} from "$lib/stores/toasts";
import {errorMessage, resolveToken} from "$lib/format";
import {
  amountsFromLiquidity,
  liquidityFromAmounts,
  snapTick,
} from "$lib/uniswapMath";
import {
  listV3PositionsOwnedBy,
  simulateV3Collect,
  readV3PoolState,
  type V3PoolState,
  type V3PositionRead,
} from "$lib/v3Positions";
import {listV4PositionsOwnedBy, readV4Position, type V4PositionRead} from "$lib/v4Positions";
import {readV4PoolState, v4QuoteEnabled, type V4PoolState} from "$lib/v4Quote";

export const U128_MAX = ethers.BigNumber.from(2).pow(128).sub(1);
export const FULL_LOWER = -887220;
export const FULL_UPPER = 887220;

export type V3QuoteState = V3PoolState | {error: string} | "loading" | null;
export type V4QuoteState = V4PoolState | {error: string} | "loading" | null;
export type FeeCell = {amount0: string; amount1: string} | {error: string} | "loading";
export type V3Lookup = {
  liquidity: string;
  token0: string;
  token1: string;
  fee: number;
  owed0: string;
  owed1: string;
};

function farDeadline(): number {
  return Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
}

export function createPositionsVM() {
  function cfgNow(): ChainConfig & {dao: NonNullable<ChainConfig["dao"]>} {
    const w = get(wallet);
    const cfg = chainConfig(w.status === "connected" ? w.chainId : 1);
    if (!cfg?.dao) throw new Error("No DAO configured");
    return cfg as ChainConfig & {dao: NonNullable<ChainConfig["dao"]>};
  }
  function prov(): ethers.providers.Provider {
    const w = get(wallet);
    if (w.status !== "connected") throw new Error("Connect a wallet");
    return w.provider;
  }
  function build<T>(target: {set: (v: T | null) => void}, fn: () => Promise<T>): Promise<void> {
    target.set(null);
    return fn()
      .then((v) => target.set(v))
      .catch((err) => {
        toasts.error(`Build failed: ${errorMessage(err)}`);
      });
  }

  // Helper: token decimals from the cfg.external book (fallback 18 for unknowns).
  function decimalsOf(cfg: ChainConfig, addr: string): number {
    return resolveToken(cfg, addr).decimals;
  }

  // tickSpacing per V3 fee tier.
  const FEE_TO_SPACING: Record<string, number> = {"100": 1, "500": 10, "3000": 60, "10000": 200};

  // --- V3 mint ---
  const mToken0 = writable("");
  const mToken1 = writable("");
  const mFee = writable("3000");
  const mAmt0 = writable("");
  const mAmt1 = writable("");
  const mFull = writable(true);
  const mLower = writable(String(FULL_LOWER));
  const mUpper = writable(String(FULL_UPPER));
  const mSlippagePct = writable("0.5"); // % off desired → min bound
  const mWrapEth = writable("");
  const mintAction = writable<ProposalAction[] | null>(null);
  const mintQuote = writable<V3QuoteState>(null);

  async function quoteMint(): Promise<void> {
    mintQuote.set("loading");
    try {
      const cfg = cfgNow();
      if (!cfg.dao?.uniswapV3) throw new Error("V3 plugin not configured");
      const npmAddr = (await uniswapV3Contract(cfg, prov()).positionManager()) as string;
      mintQuote.set(
        await readV3PoolState(npmAddr, prov(), get(mToken0), get(mToken1), parseInt(get(mFee), 10))
      );
    } catch (err) {
      mintQuote.set({error: errorMessage(err)});
    }
  }

  function applySlippage(amount: ethers.BigNumber, pct: number, direction: "down"): ethers.BigNumber {
    // bps = pct * 100 (e.g. 0.5% → 50 bps off → mul by 9950/10000)
    const bps = Math.round(pct * 100);
    if (bps <= 0) return amount;
    if (direction === "down") return amount.mul(10000 - bps).div(10000);
    return amount;
  }

  function buildMint(): Promise<void> {
    return build(mintAction, async () => {
      const cfg = cfgNow();
      const full = get(mFull);
      const dec0 = decimalsOf(cfg, get(mToken0));
      const dec1 = decimalsOf(cfg, get(mToken1));
      const amount0Desired = ethers.utils.parseUnits(get(mAmt0) || "0", dec0);
      const amount1Desired = ethers.utils.parseUnits(get(mAmt1) || "0", dec1);
      const slip = parseFloat(get(mSlippagePct) || "0") || 0;
      const batch = await actions.previewV3Mint(cfg, prov(), {
        token0: get(mToken0),
        token1: get(mToken1),
        fee: parseInt(get(mFee), 10),
        tickLower: full ? FULL_LOWER : parseInt(get(mLower), 10),
        tickUpper: full ? FULL_UPPER : parseInt(get(mUpper), 10),
        amount0Desired,
        amount1Desired,
        amount0Min: applySlippage(amount0Desired, slip, "down"),
        amount1Min: applySlippage(amount1Desired, slip, "down"),
        deadline: farDeadline(),
      });
      const wrap = get(mWrapEth).trim();
      return wrap ? [actions.wethDepositAction(cfg, ethers.utils.parseEther(wrap)), ...batch] : batch;
    });
  }

  // Adjust the V3 mint tick range to a ±pct band around the pool's current
  // tick (or set Full range). Requires that quoteMint() ran. `pct === null`
  // means full range.
  function applyMintRangePreset(pct: number | null): void {
    if (pct === null) {
      mFull.set(true);
      mLower.set(String(FULL_LOWER));
      mUpper.set(String(FULL_UPPER));
      return;
    }
    const q = get(mintQuote);
    if (!q || typeof q === "string" || "error" in q) {
      toasts.error("Quote the pool first to use ± presets.");
      return;
    }
    const spacing = FEE_TO_SPACING[get(mFee)] ?? 60;
    // ±pct% in price ≈ ±ln(1+pct/100)/ln(1.0001) ticks
    const delta = Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));
    mFull.set(false);
    mLower.set(String(snapTick(q.tick - delta, spacing, "down")));
    mUpper.set(String(snapTick(q.tick + delta, spacing, "up")));
  }

  // --- V3 increase / decrease / collect / burn (shared tokenId) ---
  const opTokenId = writable("");
  const iAmt0 = writable("");
  const iAmt1 = writable("");
  // Token addresses for the position being managed — sets decimals for the
  // amount fields. Prefilled by clicking a row in the V3 positions table.
  const iToken0 = writable("");
  const iToken1 = writable("");
  const incAction = writable<ProposalAction[] | null>(null);
  const decLiquidity = writable("");
  const decAction = writable<ProposalAction[] | null>(null);
  const collectAction = writable<ProposalAction[] | null>(null);
  const burnAction = writable<ProposalAction[] | null>(null);

  const buildIncrease = () =>
    build(incAction, () => {
      const cfg = cfgNow();
      return actions.previewV3IncreaseLiquidity(
        cfg,
        prov(),
        ethers.BigNumber.from(get(opTokenId) || "0"),
        ethers.utils.parseUnits(get(iAmt0) || "0", decimalsOf(cfg, get(iToken0))),
        ethers.utils.parseUnits(get(iAmt1) || "0", decimalsOf(cfg, get(iToken1))),
        ethers.constants.Zero,
        ethers.constants.Zero,
        farDeadline()
      );
    });
  const buildDecrease = () =>
    build(decAction, () =>
      actions.previewV3DecreaseLiquidity(
        cfgNow(),
        prov(),
        ethers.BigNumber.from(get(opTokenId) || "0"),
        ethers.BigNumber.from(get(decLiquidity) || "0"),
        ethers.constants.Zero,
        ethers.constants.Zero,
        farDeadline()
      )
    );
  const buildCollect = () =>
    build(collectAction, () =>
      actions.previewV3Collect(
        cfgNow(),
        prov(),
        ethers.BigNumber.from(get(opTokenId) || "0"),
        U128_MAX,
        U128_MAX
      )
    );
  const buildBurn = () =>
    build(burnAction, () =>
      actions.previewV3Burn(cfgNow(), prov(), ethers.BigNumber.from(get(opTokenId) || "0"))
    );

  // --- V3 lookup ---
  const lookupId = writable("");
  const lookup = writable<V3Lookup | null>(null);
  async function doLookup(): Promise<void> {
    lookup.set(null);
    try {
      const cfg = cfgNow();
      if (!cfg.dao?.uniswapV3) throw new Error("No UniswapV3 plugin configured");
      const npmAddr = await uniswapV3Contract(cfg, prov()).positionManager();
      const npm = new ethers.Contract(
        npmAddr,
        [
          "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24,int24,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
        ],
        prov()
      );
      const p = await npm.positions(ethers.BigNumber.from(get(lookupId) || "0"));
      lookup.set({
        token0: p.token0,
        token1: p.token1,
        fee: p.fee,
        liquidity: p.liquidity.toString(),
        owed0: p.tokensOwed0.toString(),
        owed1: p.tokensOwed1.toString(),
      });
    } catch (err) {
      toasts.error(`Lookup failed: ${errorMessage(err)}`);
    }
  }

  // --- V4 pool key (shared) ---
  const v4PoolToken0 = writable("");
  const v4PoolToken1 = writable("");
  const v4PoolFee = writable("3000");
  const v4PoolTickSpacing = writable("60");
  const v4PoolHooks = writable("0x0000000000000000000000000000000000000000");

  function v4PoolKey() {
    const t0 = get(v4PoolToken0);
    const t1 = get(v4PoolToken1);
    if (t0 && t1 && t0.toLowerCase() === t1.toLowerCase())
      throw new Error("currency0 and currency1 must differ");
    if (!t0 || !t1) throw new Error("Both currencies are required for the PoolKey");
    const sorted = t0.toLowerCase() < t1.toLowerCase() ? {c0: t0, c1: t1} : {c0: t1, c1: t0};
    return {
      currency0: sorted.c0,
      currency1: sorted.c1,
      fee: parseInt(get(v4PoolFee), 10),
      tickSpacing: parseInt(get(v4PoolTickSpacing), 10),
      hooks: get(v4PoolHooks) || ethers.constants.AddressZero,
    };
  }

  // --- V4 mint ---
  const vmTickLower = writable("-887220");
  const vmTickUpper = writable("887220");
  // Two ways to mint: auto-derive L from amount0/amount1 (default), or paste a
  // raw L + amount maxes (Advanced). vmAuto toggles between them.
  const vmAuto = writable(true);
  const vmAmt0Desired = writable("");
  const vmAmt1Desired = writable("");
  const vmSlippagePct = writable("0.5");
  // Raw mode:
  const vmLiquidity = writable("");
  const vmAmount0Max = writable("");
  const vmAmount1Max = writable("");
  const v4MintAction = writable<ProposalAction[] | null>(null);
  const v4MintQuote = writable<V4QuoteState>(null);

  // Apply slippage upward to a float atomic amount, return as BigNumber (ceiled).
  function ceilWithSlippage(atomic: number, slipPct: number): ethers.BigNumber {
    const bumped = atomic * (1 + Math.max(0, slipPct) / 100);
    return ethers.BigNumber.from(Math.ceil(bumped).toString());
  }

  function buildV4Mint(): Promise<void> {
    return build(v4MintAction, async () => {
      const cfg = cfgNow();
      const pk = v4PoolKey();
      const dec0 = decimalsOf(cfg, pk.currency0);
      const dec1 = decimalsOf(cfg, pk.currency1);
      const tickLower = parseInt(get(vmTickLower), 10);
      const tickUpper = parseInt(get(vmTickUpper), 10);
      let liquidity: ethers.BigNumber;
      let amount0Max: ethers.BigNumber;
      let amount1Max: ethers.BigNumber;
      if (get(vmAuto)) {
        // Derive L from desired amounts + current pool tick (needs a Quote).
        const q = get(v4MintQuote);
        if (!q || typeof q === "string" || "error" in q) {
          throw new Error('Click "Quote pool" first — auto-L needs the current tick');
        }
        const a0 = parseFloat(ethers.utils.parseUnits(get(vmAmt0Desired) || "0", dec0).toString());
        const a1 = parseFloat(ethers.utils.parseUnits(get(vmAmt1Desired) || "0", dec1).toString());
        const L = liquidityFromAmounts(q.tick, tickLower, tickUpper, a0, a1);
        if (!isFinite(L) || L <= 0) throw new Error("Derived liquidity is zero — increase amounts or widen range");
        liquidity = ethers.BigNumber.from(Math.floor(L).toString());
        const consumed = amountsFromLiquidity(q.tick, tickLower, tickUpper, L);
        const slip = parseFloat(get(vmSlippagePct) || "0") || 0;
        amount0Max = ceilWithSlippage(consumed.amount0Atomic, slip);
        amount1Max = ceilWithSlippage(consumed.amount1Atomic, slip);
      } else {
        liquidity = ethers.BigNumber.from(get(vmLiquidity) || "0");
        amount0Max = ethers.utils.parseUnits(get(vmAmount0Max) || "0", dec0);
        amount1Max = ethers.utils.parseUnits(get(vmAmount1Max) || "0", dec1);
      }
      return actions.previewV4Mint(cfg, prov(), {
        poolKey: pk,
        tickLower,
        tickUpper,
        liquidity,
        amount0Max,
        amount1Max,
      });
    });
  }

  // Range presets for V4 mint, mirroring V3.
  function applyV4MintRangePreset(pct: number | null): void {
    if (pct === null) {
      vmTickLower.set("-887220");
      vmTickUpper.set("887220");
      return;
    }
    const q = get(v4MintQuote);
    if (!q || typeof q === "string" || "error" in q) {
      toasts.error("Quote the pool first to use ± presets.");
      return;
    }
    const spacing = parseInt(get(v4PoolTickSpacing), 10) || 60;
    const delta = Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));
    vmTickLower.set(String(snapTick(q.tick - delta, spacing, "down")));
    vmTickUpper.set(String(snapTick(q.tick + delta, spacing, "up")));
  }

  async function quoteV4Mint(): Promise<void> {
    v4MintQuote.set("loading");
    try {
      v4MintQuote.set(await readV4PoolState(cfgNow(), prov(), v4PoolKey()));
    } catch (err) {
      v4MintQuote.set({error: errorMessage(err)});
    }
  }

  // --- V4 increase / decrease / collect / burn ---
  const viTokenId = writable("");
  const viLiquidity = writable("");
  const viAmount0Max = writable("");
  const viAmount1Max = writable("");
  const v4IncAction = writable<ProposalAction[] | null>(null);
  const vdTokenId = writable("");
  const vdLiquidity = writable("");
  const v4DecAction = writable<ProposalAction[] | null>(null);
  const v4CollectAction = writable<ProposalAction[] | null>(null);
  const v4BurnAction = writable<ProposalAction[] | null>(null);

  const buildV4Increase = () =>
    build(v4IncAction, () => {
      const cfg = cfgNow();
      const pk = v4PoolKey();
      return actions.previewV4Increase(cfg, prov(), {
        poolKey: pk,
        tokenId: ethers.BigNumber.from(get(viTokenId) || "0"),
        liquidity: ethers.BigNumber.from(get(viLiquidity) || "0"),
        amount0Max: ethers.utils.parseUnits(get(viAmount0Max) || "0", decimalsOf(cfg, pk.currency0)),
        amount1Max: ethers.utils.parseUnits(get(viAmount1Max) || "0", decimalsOf(cfg, pk.currency1)),
      });
    });
  const buildV4Decrease = () =>
    build(v4DecAction, () =>
      actions.previewV4Decrease(cfgNow(), prov(), {
        poolKey: v4PoolKey(),
        tokenId: ethers.BigNumber.from(get(vdTokenId) || "0"),
        liquidity: ethers.BigNumber.from(get(vdLiquidity) || "0"),
        amount0Min: 0,
        amount1Min: 0,
      })
    );
  const buildV4Collect = () =>
    build(v4CollectAction, () =>
      actions.previewV4Collect(cfgNow(), prov(), {
        poolKey: v4PoolKey(),
        tokenId: ethers.BigNumber.from(get(vdTokenId) || "0"),
      })
    );
  const buildV4Burn = () =>
    build(v4BurnAction, () =>
      actions.previewV4Burn(cfgNow(), prov(), {
        poolKey: v4PoolKey(),
        tokenId: ethers.BigNumber.from(get(vdTokenId) || "0"),
      })
    );

  // --- DAO-owned positions list + per-row live fees + V4 lookup ---
  const v3Positions = writable<V3PositionRead[] | null>(null);
  const v4Positions = writable<V4PositionRead[] | null>(null);
  const listing = writable(false);
  const v3LiveFees = writable<Record<string, FeeCell>>({});

  // Live pool state per (token0,token1,fee) for V3 and per poolId for V4 —
  // populated by loadPositions so the rows can render the current spot price
  // and an in-range badge. Keyed by `${token0}|${token1}|${fee}` and
  // `${currency0}|${currency1}|${fee}|${tickSpacing}|${hooks}` respectively.
  const v3PoolStates = writable<Record<string, V3PoolState>>({});
  const v4PoolStates = writable<Record<string, V4PoolState>>({});
  function v3PoolKey(p: V3PositionRead): string {
    return `${p.token0.toLowerCase()}|${p.token1.toLowerCase()}|${p.fee}`;
  }
  function v4PoolKeyStr(p: V4PositionRead): string {
    const k = p.poolKey;
    return `${k.currency0.toLowerCase()}|${k.currency1.toLowerCase()}|${k.fee}|${k.tickSpacing}|${k.hooks.toLowerCase()}`;
  }

  async function simulateCollectFor(tokenId: ethers.BigNumber): Promise<void> {
    const key = tokenId.toString();
    v3LiveFees.update((m) => ({...m, [key]: "loading"}));
    try {
      const cfg = cfgNow();
      if (!cfg.dao?.uniswapV3) throw new Error("V3 not configured");
      const npmAddr = (await uniswapV3Contract(cfg, prov()).positionManager()) as string;
      const r = await simulateV3Collect(npmAddr, prov(), tokenId, cfg.dao.dao);
      v3LiveFees.update((m) => ({...m, [key]: {amount0: r.amount0.toString(), amount1: r.amount1.toString()}}));
    } catch (err) {
      v3LiveFees.update((m) => ({...m, [key]: {error: errorMessage(err)}}));
    }
  }

  async function loadPositions(): Promise<void> {
    listing.set(true);
    v3Positions.set(null);
    v4Positions.set(null);
    v3PoolStates.set({});
    v4PoolStates.set({});
    try {
      const cfg = cfgNow();
      let npmAddr: string | undefined;
      let v3List: V3PositionRead[] = [];
      if (cfg.dao.uniswapV3) {
        npmAddr = (await uniswapV3Contract(cfg, prov()).positionManager()) as string;
        v3List = await listV3PositionsOwnedBy(npmAddr, prov(), cfg.dao.dao);
      }
      v3Positions.set(v3List);
      const v4 = new ethers.Contract(
        cfg.dao.uniswap,
        ["function v4PositionManager() view returns (address)"],
        prov()
      );
      let pmAddr: string = ethers.constants.AddressZero;
      try {
        pmAddr = (await v4.v4PositionManager()) as string;
      } catch {
        /* pre-LP build */
      }
      const v4List =
        pmAddr !== ethers.constants.AddressZero
          ? await listV4PositionsOwnedBy(pmAddr, prov(), cfg.dao.dao)
          : [];
      v4Positions.set(v4List);
      // Fan out pool-state reads in parallel (deduped by pool key). Best-effort
      // — a per-pool error doesn't block the row from rendering, it just leaves
      // the current-price annotation off.
      void hydratePoolStates(cfg, v3List, v4List, npmAddr);
    } catch (err) {
      toasts.error(`Load positions failed: ${errorMessage(err)}`);
    } finally {
      listing.set(false);
    }
  }

  async function hydratePoolStates(
    cfg: ChainConfig & {dao: NonNullable<ChainConfig["dao"]>},
    v3List: V3PositionRead[],
    v4List: V4PositionRead[],
    npmAddr: string | undefined
  ): Promise<void> {
    const uniqueV3 = new Map<string, V3PositionRead>();
    for (const p of v3List) uniqueV3.set(v3PoolKey(p), p);
    if (npmAddr) {
      await Promise.all(
        Array.from(uniqueV3.entries()).map(async ([k, p]) => {
          try {
            const s = await readV3PoolState(npmAddr!, prov(), p.token0, p.token1, p.fee);
            v3PoolStates.update((m) => ({...m, [k]: s}));
          } catch {/* ignore — leave the row without current-price annotation */}
        })
      );
    }
    if (v4QuoteEnabled(cfg)) {
      const uniqueV4 = new Map<string, V4PositionRead>();
      for (const p of v4List) uniqueV4.set(v4PoolKeyStr(p), p);
      await Promise.all(
        Array.from(uniqueV4.entries()).map(async ([k, p]) => {
          try {
            const s = await readV4PoolState(cfg, prov(), p.poolKey);
            v4PoolStates.update((m) => ({...m, [k]: s}));
          } catch {/* ignore */}
        })
      );
    }
  }

  // --- Per-row prefill helpers (clicked from the DAO-owned positions table) --
  /** Prefill V3 manage form (tokenId + tokens) from a row. */
  function prefillV3Manage(p: V3PositionRead): void {
    opTokenId.set(p.tokenId.toString());
    iToken0.set(p.token0);
    iToken1.set(p.token1);
    decLiquidity.set(p.liquidity.toString());
  }
  /** Prefill V4 manage forms (pool key + tokenId) from a row. */
  function prefillV4Manage(p: V4PositionRead): void {
    v4PoolToken0.set(p.poolKey.currency0);
    v4PoolToken1.set(p.poolKey.currency1);
    v4PoolFee.set(String(p.poolKey.fee));
    v4PoolTickSpacing.set(String(p.poolKey.tickSpacing));
    v4PoolHooks.set(p.poolKey.hooks);
    viTokenId.set(p.tokenId.toString());
    vdTokenId.set(p.tokenId.toString());
    vdLiquidity.set(p.liquidity.toString());
  }

  const v4LookupId = writable("");
  const v4Lookup = writable<V4PositionRead | null>(null);
  async function doV4Lookup(): Promise<void> {
    v4Lookup.set(null);
    try {
      const cfg = cfgNow();
      const v4 = new ethers.Contract(
        cfg.dao.uniswap,
        ["function v4PositionManager() view returns (address)"],
        prov()
      );
      const pmAddr: string = await v4.v4PositionManager();
      v4Lookup.set(await readV4Position(pmAddr, prov(), ethers.BigNumber.from(get(v4LookupId) || "0")));
    } catch (err) {
      toasts.error(`V4 lookup failed: ${errorMessage(err)}`);
    }
  }

  return {
    // V3 mint
    mToken0, mToken1, mFee, mAmt0, mAmt1, mFull, mLower, mUpper, mSlippagePct, mWrapEth,
    mintAction, mintQuote, quoteMint, buildMint, applyMintRangePreset,
    // V3 manage
    opTokenId, iAmt0, iAmt1, iToken0, iToken1, incAction, decLiquidity, decAction, collectAction, burnAction,
    buildIncrease, buildDecrease, buildCollect, buildBurn,
    prefillV3Manage,
    // V3 lookup
    lookupId, lookup, doLookup,
    // V4 pool key
    v4PoolToken0, v4PoolToken1, v4PoolFee, v4PoolTickSpacing, v4PoolHooks,
    // V4 mint
    vmTickLower, vmTickUpper, vmAuto, vmAmt0Desired, vmAmt1Desired, vmSlippagePct,
    vmLiquidity, vmAmount0Max, vmAmount1Max,
    v4MintAction, v4MintQuote, buildV4Mint, quoteV4Mint, applyV4MintRangePreset,
    // V4 manage
    viTokenId, viLiquidity, viAmount0Max, viAmount1Max, v4IncAction, buildV4Increase,
    vdTokenId, vdLiquidity, v4DecAction, v4CollectAction, v4BurnAction,
    buildV4Decrease, buildV4Collect, buildV4Burn,
    prefillV4Manage,
    // lists + lookups
    v3Positions, v4Positions, listing, v3LiveFees, simulateCollectFor, loadPositions,
    v3PoolStates, v4PoolStates, v3PoolKey, v4PoolKeyStr,
    v4LookupId, v4Lookup, doV4Lookup,
  };
}
