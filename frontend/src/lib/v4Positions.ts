// V4 PositionManager read helpers.
//
// Decodes the packed `PositionInfo` uint256 returned by
// `getPoolAndPositionInfo(tokenId)`, and enumerates DAO-owned position NFTs
// via ERC721 Transfer events (the v4 PositionManager doesn't implement
// ERC721Enumerable, so we can't `tokenOfOwnerByIndex`).
//
// PositionInfo layout (v4-periphery PositionInfoLibrary — matching the
// canonical lib's tickLower/tickUpper inline-assembly):
//   bits [0..8)    hasSubscriber (bool flag, low byte)
//   bits [8..32)   tickLower (int24, sign-extended)
//   bits [32..56)  tickUpper (int24, sign-extended)
//   bits [56..256) poolId (top 200 bits — bytes25 of keccak256(PoolKey))

import {ethers} from "ethers";

const V4_PM_ABI = [
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks), uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function nextTokenId() view returns (uint256)",
];

export type V4PoolKeyRead = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

export type V4PositionRead = {
  tokenId: ethers.BigNumber;
  poolKey: V4PoolKeyRead;
  tickLower: number;
  tickUpper: number;
  hasSubscriber: boolean;
  liquidity: ethers.BigNumber;
};

function decodePositionInfo(info: ethers.BigNumber): {
  tickLower: number;
  tickUpper: number;
  hasSubscriber: boolean;
} {
  const v = info.toBigInt();
  const hasSubscriber = Number(v & 0xffn) !== 0;
  // tickLower at bits 8..32, tickUpper at bits 32..56 — both int24 (sign-extend).
  let tickLower = Number((v >> 8n) & 0xffffffn);
  if (tickLower >= 0x800000) tickLower -= 0x1000000;
  let tickUpper = Number((v >> 32n) & 0xffffffn);
  if (tickUpper >= 0x800000) tickUpper -= 0x1000000;
  return {tickLower, tickUpper, hasSubscriber};
}

export function v4PositionManager(
  pmAddress: string,
  provider: ethers.providers.Provider
): ethers.Contract {
  return new ethers.Contract(pmAddress, V4_PM_ABI, provider);
}

export async function readV4Position(
  pmAddress: string,
  provider: ethers.providers.Provider,
  tokenId: ethers.BigNumberish
): Promise<V4PositionRead> {
  const pm = v4PositionManager(pmAddress, provider);
  const [poolKey, info] = await pm.getPoolAndPositionInfo(tokenId);
  const liquidity = await pm.getPositionLiquidity(tokenId);
  const {tickLower, tickUpper, hasSubscriber} = decodePositionInfo(info);
  return {
    tokenId: ethers.BigNumber.from(tokenId),
    poolKey: {
      currency0: poolKey.currency0,
      currency1: poolKey.currency1,
      fee: Number(poolKey.fee),
      tickSpacing: Number(poolKey.tickSpacing),
      hooks: poolKey.hooks,
    },
    tickLower,
    tickUpper,
    hasSubscriber,
    liquidity,
  };
}

/**
 * Enumerate position NFTs currently owned by `owner` on the PositionManager.
 * Scans ERC721 Transfer events: every position mint emits Transfer(0x0, owner, tokenId).
 * For each mint we also confirm the current owner is still `owner` (positions
 * transferred away are filtered out). `fromBlock` defaults to genesis on the
 * connected node — on a fresh anvil fork this is the pin block, which is what
 * we want.
 */
// Most RPCs cap eth_getLogs at ~10k blocks; scan in chunks under that. The
// default lookback (~7 days of mainnet blocks) keeps the toy frontend's direct
// scan shallow — deeper history is the subgraph's job. Pass a larger
// `lookbackBlocks` (or 0 for "from genesis", chunked) if you need it.
const LOG_CHUNK = 9_000;
const DEFAULT_LOOKBACK = 50_000;

export async function listV4PositionsOwnedBy(
  pmAddress: string,
  provider: ethers.providers.Provider,
  owner: string,
  lookbackBlocks: number = DEFAULT_LOOKBACK
): Promise<V4PositionRead[]> {
  const pm = new ethers.Contract(
    pmAddress,
    [
      ...V4_PM_ABI,
      "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    ],
    provider
  );
  const tip = await provider.getBlockNumber();
  const from = lookbackBlocks > 0 ? Math.max(0, tip - lookbackBlocks) : 0;
  // Filter Transfer(from=0x0, to=owner) — i.e. mints to this owner — in
  // ≤LOG_CHUNK windows so a wide range can't blow the RPC's getLogs cap.
  const mintFilter = pm.filters.Transfer(ethers.constants.AddressZero, owner);
  const events: ethers.Event[] = [];
  for (let end = tip; end >= from; end -= LOG_CHUNK) {
    const start = Math.max(from, end - LOG_CHUNK + 1);
    try {
      events.push(...(await pm.queryFilter(mintFilter, start, end)));
    } catch {
      /* skip an unreadable range */
    }
  }
  const tokenIds = Array.from(new Set(events.map((e) => e.args!.tokenId.toString()))).map((s) =>
    ethers.BigNumber.from(s)
  );

  // Filter out positions transferred away after mint.
  const stillOwned: ethers.BigNumber[] = [];
  for (const id of tokenIds) {
    try {
      const o = await pm.ownerOf(id);
      if (o.toLowerCase() === owner.toLowerCase()) stillOwned.push(id);
    } catch {
      /* burned / not found */
    }
  }
  // Isolate per-position reads — one failing detail read (e.g. a flaky RPC
  // storage fetch) shouldn't blank the whole list.
  const results = await Promise.allSettled(
    stillOwned.map((id) => readV4Position(pmAddress, provider, id))
  );
  return results
    .filter((r): r is PromiseFulfilledResult<V4PositionRead> => r.status === "fulfilled")
    .map((r) => r.value);
}
