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
import {errorMessage} from "$lib/format";
import {
  listV3PositionsOwnedBy,
  simulateV3Collect,
  readV3PoolState,
  type V3PoolState,
  type V3PositionRead,
} from "$lib/v3Positions";
import {listV4PositionsOwnedBy, readV4Position, type V4PositionRead} from "$lib/v4Positions";
import {readV4PoolState, type V4PoolState} from "$lib/v4Quote";

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

  // --- V3 mint ---
  const mToken0 = writable("");
  const mToken1 = writable("");
  const mFee = writable("3000");
  const mDec0 = writable("6");
  const mDec1 = writable("18");
  const mAmt0 = writable("");
  const mAmt1 = writable("");
  const mFull = writable(true);
  const mLower = writable(String(FULL_LOWER));
  const mUpper = writable(String(FULL_UPPER));
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

  function buildMint(): Promise<void> {
    return build(mintAction, async () => {
      const cfg = cfgNow();
      const full = get(mFull);
      const batch = await actions.previewV3Mint(cfg, prov(), {
        token0: get(mToken0),
        token1: get(mToken1),
        fee: parseInt(get(mFee), 10),
        tickLower: full ? FULL_LOWER : parseInt(get(mLower), 10),
        tickUpper: full ? FULL_UPPER : parseInt(get(mUpper), 10),
        amount0Desired: ethers.utils.parseUnits(get(mAmt0) || "0", parseInt(get(mDec0), 10)),
        amount1Desired: ethers.utils.parseUnits(get(mAmt1) || "0", parseInt(get(mDec1), 10)),
        amount0Min: ethers.constants.Zero,
        amount1Min: ethers.constants.Zero,
        deadline: farDeadline(),
      });
      const wrap = get(mWrapEth).trim();
      return wrap ? [actions.wethDepositAction(cfg, ethers.utils.parseEther(wrap)), ...batch] : batch;
    });
  }

  // --- V3 increase / decrease / collect / burn (shared tokenId) ---
  const opTokenId = writable("");
  const iAmt0 = writable("");
  const iAmt1 = writable("");
  const iDec0 = writable("6");
  const iDec1 = writable("18");
  const incAction = writable<ProposalAction[] | null>(null);
  const decLiquidity = writable("");
  const decAction = writable<ProposalAction[] | null>(null);
  const collectAction = writable<ProposalAction[] | null>(null);
  const burnAction = writable<ProposalAction[] | null>(null);

  const buildIncrease = () =>
    build(incAction, () =>
      actions.previewV3IncreaseLiquidity(
        cfgNow(),
        prov(),
        ethers.BigNumber.from(get(opTokenId) || "0"),
        ethers.utils.parseUnits(get(iAmt0) || "0", parseInt(get(iDec0), 10)),
        ethers.utils.parseUnits(get(iAmt1) || "0", parseInt(get(iDec1), 10)),
        ethers.constants.Zero,
        ethers.constants.Zero,
        farDeadline()
      )
    );
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
  const vmLiquidity = writable("");
  const vmAmount0Max = writable("");
  const vmAmount1Max = writable("");
  const vmDec0 = writable("6");
  const vmDec1 = writable("18");
  const v4MintAction = writable<ProposalAction[] | null>(null);
  const v4MintQuote = writable<V4QuoteState>(null);

  const buildV4Mint = () =>
    build(v4MintAction, () =>
      actions.previewV4Mint(cfgNow(), prov(), {
        poolKey: v4PoolKey(),
        tickLower: parseInt(get(vmTickLower), 10),
        tickUpper: parseInt(get(vmTickUpper), 10),
        liquidity: ethers.BigNumber.from(get(vmLiquidity) || "0"),
        amount0Max: ethers.utils.parseUnits(get(vmAmount0Max) || "0", parseInt(get(vmDec0), 10)),
        amount1Max: ethers.utils.parseUnits(get(vmAmount1Max) || "0", parseInt(get(vmDec1), 10)),
      })
    );

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
    build(v4IncAction, () =>
      actions.previewV4Increase(cfgNow(), prov(), {
        poolKey: v4PoolKey(),
        tokenId: ethers.BigNumber.from(get(viTokenId) || "0"),
        liquidity: ethers.BigNumber.from(get(viLiquidity) || "0"),
        amount0Max: ethers.utils.parseUnits(get(viAmount0Max) || "0", parseInt(get(vmDec0), 10)),
        amount1Max: ethers.utils.parseUnits(get(viAmount1Max) || "0", parseInt(get(vmDec1), 10)),
      })
    );
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
    try {
      const cfg = cfgNow();
      if (cfg.dao.uniswapV3) {
        const npmAddr = (await uniswapV3Contract(cfg, prov()).positionManager()) as string;
        v3Positions.set(await listV3PositionsOwnedBy(npmAddr, prov(), cfg.dao.dao));
      } else {
        v3Positions.set([]);
      }
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
      v4Positions.set(
        pmAddr !== ethers.constants.AddressZero
          ? await listV4PositionsOwnedBy(pmAddr, prov(), cfg.dao.dao)
          : []
      );
    } catch (err) {
      toasts.error(`Load positions failed: ${errorMessage(err)}`);
    } finally {
      listing.set(false);
    }
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
    mToken0, mToken1, mFee, mDec0, mDec1, mAmt0, mAmt1, mFull, mLower, mUpper, mWrapEth,
    mintAction, mintQuote, quoteMint, buildMint,
    // V3 manage
    opTokenId, iAmt0, iAmt1, iDec0, iDec1, incAction, decLiquidity, decAction, collectAction, burnAction,
    buildIncrease, buildDecrease, buildCollect, buildBurn,
    // V3 lookup
    lookupId, lookup, doLookup,
    // V4 pool key
    v4PoolToken0, v4PoolToken1, v4PoolFee, v4PoolTickSpacing, v4PoolHooks,
    // V4 mint
    vmTickLower, vmTickUpper, vmLiquidity, vmAmount0Max, vmAmount1Max, vmDec0, vmDec1,
    v4MintAction, v4MintQuote, buildV4Mint, quoteV4Mint,
    // V4 manage
    viTokenId, viLiquidity, viAmount0Max, viAmount1Max, v4IncAction, buildV4Increase,
    vdTokenId, vdLiquidity, v4DecAction, v4CollectAction, v4BurnAction,
    buildV4Decrease, buildV4Collect, buildV4Burn,
    // lists + lookups
    v3Positions, v4Positions, listing, v3LiveFees, simulateCollectFor, loadPositions,
    v4LookupId, v4Lookup, doV4Lookup,
  };
}
