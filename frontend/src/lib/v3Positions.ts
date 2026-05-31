// Uniswap V3 NonfungiblePositionManager (NPM) read helpers.
//
// The canonical NPM implements ERC721Enumerable, so we can enumerate
// DAO-owned positions directly via `tokenOfOwnerByIndex` (unlike V4 which
// requires a Transfer-event scan).

import {ethers} from "ethers";

const NPM_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  // Collect is a state-changing function; we use callStatic so the eth_call
  // returns the amounts the position would receive RIGHT NOW (full pending fees
  // get rolled into `tokensOwed` inside the simulation and returned). The
  // `from` override is required because NPM checks the caller is approved for
  // the tokenId.
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external returns (uint256 amount0, uint256 amount1)",
  "function factory() view returns (address)",
];

const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
];

const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"];

export type V3PositionRead = {
  tokenId: ethers.BigNumber;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: ethers.BigNumber;
  tokensOwed0: ethers.BigNumber;
  tokensOwed1: ethers.BigNumber;
};

export async function readV3Position(
  npmAddress: string,
  provider: ethers.providers.Provider,
  tokenId: ethers.BigNumberish
): Promise<V3PositionRead> {
  const npm = new ethers.Contract(npmAddress, NPM_ABI, provider);
  const p = await npm.positions(tokenId);
  return {
    tokenId: ethers.BigNumber.from(tokenId),
    token0: p.token0,
    token1: p.token1,
    fee: Number(p.fee),
    tickLower: Number(p.tickLower),
    tickUpper: Number(p.tickUpper),
    liquidity: p.liquidity,
    tokensOwed0: p.tokensOwed0,
    tokensOwed1: p.tokensOwed1,
  };
}

export async function listV3PositionsOwnedBy(
  npmAddress: string,
  provider: ethers.providers.Provider,
  owner: string
): Promise<V3PositionRead[]> {
  const npm = new ethers.Contract(npmAddress, NPM_ABI, provider);
  const n = (await npm.balanceOf(owner)).toNumber();
  const ids: ethers.BigNumber[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(await npm.tokenOfOwnerByIndex(owner, i));
  }
  // Isolate per-position reads — one failing detail read (e.g. a flaky RPC
  // storage fetch on a fork) shouldn't blank the whole list.
  const results = await Promise.allSettled(
    ids.map((id) => readV3Position(npmAddress, provider, id))
  );
  return results
    .filter((r): r is PromiseFulfilledResult<V3PositionRead> => r.status === "fulfilled")
    .map((r) => r.value);
}

export type V3PoolState = {
  poolAddress: string;
  sqrtPriceX96: ethers.BigNumber;
  tick: number;
  liquidity: ethers.BigNumber;
  /** Decimal price expressed as token1 per 1 token0 (raw units, no decimals applied). */
  rawPriceToken1PerToken0: number;
  /** Whole-pool ERC20 reserves (raw integer units). The V3 pool contract custodies
   *  its tokens directly, so `balanceOf(pool)` is the canonical TVL source. */
  reserve0?: ethers.BigNumber;
  reserve1?: ethers.BigNumber;
  /** Whether `[tickLower, tickUpper]` contains the current tick. */
  inRange: (tickLower: number, tickUpper: number) => boolean;
};

/**
 * Read the live pool state for (token0, token1, fee) via the canonical V3
 * factory. Used by the mint form to show context (current tick, price) so
 * users can set sensible amount0Min / amount1Min slippage before submitting
 * a proposal. Pool address is derived on-chain via `factory.getPool`, so we
 * don't have to embed factory/init-code-hash constants per chain.
 *
 * Reverts (via the underlying contract calls) if no pool exists for the
 * (token0, token1, fee) tuple — the form should surface that as "no live
 * pool" rather than building a doomed proposal.
 */
export async function readV3PoolState(
  npmAddress: string,
  provider: ethers.providers.Provider,
  token0: string,
  token1: string,
  fee: number
): Promise<V3PoolState> {
  const npm = new ethers.Contract(npmAddress, NPM_ABI, provider);
  const factoryAddr = (await npm.factory()) as string;
  const factory = new ethers.Contract(factoryAddr, V3_FACTORY_ABI, provider);
  const poolAddress = (await factory.getPool(token0, token1, fee)) as string;
  if (poolAddress === ethers.constants.AddressZero) {
    throw new Error(`No V3 pool for ${token0} / ${token1} / fee=${fee}`);
  }
  const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
  const t0 = new ethers.Contract(token0, ERC20_BALANCE_ABI, provider);
  const t1 = new ethers.Contract(token1, ERC20_BALANCE_ABI, provider);
  // Reserves are best-effort (balanceOf on the pool) — a flaky read shouldn't
  // sink the price/tick the form actually depends on, so they resolve to
  // undefined on failure rather than rejecting the whole call.
  const [slot0, liquidity, reserve0, reserve1] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    t0.balanceOf(poolAddress).catch(() => undefined),
    t1.balanceOf(poolAddress).catch(() => undefined),
  ]);
  // price = (sqrtPriceX96 / 2^96) ** 2. JS float is fine for a UI preview —
  // any operational proposal still uses the on-chain math via NPM.mint.
  const sqrtPriceX96 = slot0.sqrtPriceX96 as ethers.BigNumber;
  const numerator = parseFloat(sqrtPriceX96.toString());
  const Q96 = 2 ** 96;
  const ratio = numerator / Q96;
  const rawPriceToken1PerToken0 = ratio * ratio;
  const currentTick = Number(slot0.tick);
  return {
    poolAddress,
    sqrtPriceX96,
    tick: currentTick,
    liquidity,
    rawPriceToken1PerToken0,
    reserve0,
    reserve1,
    inRange: (tickLower: number, tickUpper: number) =>
      currentTick >= tickLower && currentTick < tickUpper,
  };
}

/**
 * Simulate `NPM.collect(tokenId, recipient=owner, max, max)` via eth_call so
 * the returned amount0/amount1 reflect the FULL pending fees right now (not
 * just the stale `tokensOwed` snapshot). The position must be owned by
 * `owner` for the simulation to pass NPM's approval check.
 */
export async function simulateV3Collect(
  npmAddress: string,
  provider: ethers.providers.Provider,
  tokenId: ethers.BigNumberish,
  owner: string
): Promise<{amount0: ethers.BigNumber; amount1: ethers.BigNumber}> {
  const npm = new ethers.Contract(npmAddress, NPM_ABI, provider);
  const U128_MAX = ethers.BigNumber.from(2).pow(128).sub(1);
  // The `from` override makes eth_call use `owner` as msg.sender so NPM's
  // approval check passes. Works against any standard JSON-RPC node.
  const [amount0, amount1] = await npm.callStatic.collect(
    {tokenId, recipient: owner, amount0Max: U128_MAX, amount1Max: U128_MAX},
    {from: owner}
  );
  return {amount0, amount1};
}
