// Encoders for Uniswap v4-periphery action streams.
//
// `modifyLiquidities(bytes unlockData, uint256 deadline)` accepts a packed
// action stream: `unlockData = abi.encode(bytes actions, bytes[] params)`,
// where each byte in `actions` is one entry from v4-periphery's `Actions`
// enum, and `params[i]` is the abi-encoded args for action[i]. This module
// builds the most common shapes (mint / increase / decrease / collect /
// burn) so the frontend can offer typed forms instead of asking the user to
// paste raw hex.

import {ethers} from "ethers";

// Subset of the v4-periphery Actions enum used here.
export const V4Actions = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
} as const;

export type PoolKey = {
  currency0: string; // must be < currency1 by address
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string; // 0x0…0 for unhooked
};

const ABI = ethers.utils.defaultAbiCoder;

function packActions(bytes: number[]): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

function encodePoolKey(k: PoolKey): string {
  // PoolKey is encoded inline within the action params; this helper returns
  // the same encoding the contract would do with `abi.encode(poolKey, …)`.
  // We don't strip a wrapping tuple — that's the caller's responsibility.
  return ""; // placeholder, encoded inline below
}

/** MINT_POSITION + SETTLE_PAIR — opens a new position, pulls both tokens. */
export function encodeMint(args: {
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: ethers.BigNumberish;
  amount0Max: ethers.BigNumberish;
  amount1Max: ethers.BigNumberish;
  owner: string;
  hookData?: string;
}): string {
  encodePoolKey(args.poolKey); // type-touch (kept for readability)
  const mintParams = ABI.encode(
    [
      "(address,address,uint24,int24,address)", // PoolKey
      "int24",
      "int24",
      "uint256",
      "uint128",
      "uint128",
      "address",
      "bytes",
    ],
    [
      [
        args.poolKey.currency0,
        args.poolKey.currency1,
        args.poolKey.fee,
        args.poolKey.tickSpacing,
        args.poolKey.hooks,
      ],
      args.tickLower,
      args.tickUpper,
      args.liquidity,
      args.amount0Max,
      args.amount1Max,
      args.owner,
      args.hookData ?? "0x",
    ]
  );
  const settleParams = ABI.encode(
    ["address", "address"],
    [args.poolKey.currency0, args.poolKey.currency1]
  );
  return ABI.encode(
    ["bytes", "bytes[]"],
    [packActions([V4Actions.MINT_POSITION, V4Actions.SETTLE_PAIR]), [mintParams, settleParams]]
  );
}

/** INCREASE_LIQUIDITY + SETTLE_PAIR — adds to an existing DAO position. */
export function encodeIncrease(args: {
  poolKey: PoolKey;
  tokenId: ethers.BigNumberish;
  liquidity: ethers.BigNumberish;
  amount0Max: ethers.BigNumberish;
  amount1Max: ethers.BigNumberish;
  hookData?: string;
}): string {
  const incParams = ABI.encode(
    ["uint256", "uint256", "uint128", "uint128", "bytes"],
    [args.tokenId, args.liquidity, args.amount0Max, args.amount1Max, args.hookData ?? "0x"]
  );
  const settleParams = ABI.encode(
    ["address", "address"],
    [args.poolKey.currency0, args.poolKey.currency1]
  );
  return ABI.encode(
    ["bytes", "bytes[]"],
    [packActions([V4Actions.INCREASE_LIQUIDITY, V4Actions.SETTLE_PAIR]), [incParams, settleParams]]
  );
}

/** DECREASE_LIQUIDITY + TAKE_PAIR — removes liquidity; tokens sent to recipient. */
export function encodeDecrease(args: {
  poolKey: PoolKey;
  tokenId: ethers.BigNumberish;
  liquidity: ethers.BigNumberish;
  amount0Min: ethers.BigNumberish;
  amount1Min: ethers.BigNumberish;
  recipient: string;
  hookData?: string;
}): string {
  const decParams = ABI.encode(
    ["uint256", "uint256", "uint128", "uint128", "bytes"],
    [args.tokenId, args.liquidity, args.amount0Min, args.amount1Min, args.hookData ?? "0x"]
  );
  const takeParams = ABI.encode(
    ["address", "address", "address"],
    [args.poolKey.currency0, args.poolKey.currency1, args.recipient]
  );
  return ABI.encode(
    ["bytes", "bytes[]"],
    [packActions([V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR]), [decParams, takeParams]]
  );
}

/** Fees-only collect = DECREASE_LIQUIDITY(0) + TAKE_PAIR. */
export function encodeCollect(args: {
  poolKey: PoolKey;
  tokenId: ethers.BigNumberish;
  recipient: string;
}): string {
  return encodeDecrease({
    poolKey: args.poolKey,
    tokenId: args.tokenId,
    liquidity: 0,
    amount0Min: 0,
    amount1Min: 0,
    recipient: args.recipient,
  });
}

/** BURN_POSITION + TAKE_PAIR — burns an empty position; sweeps any dust to recipient. */
export function encodeBurn(args: {
  poolKey: PoolKey;
  tokenId: ethers.BigNumberish;
  amount0Min: ethers.BigNumberish;
  amount1Min: ethers.BigNumberish;
  recipient: string;
  hookData?: string;
}): string {
  const burnParams = ABI.encode(
    ["uint256", "uint128", "uint128", "bytes"],
    [args.tokenId, args.amount0Min, args.amount1Min, args.hookData ?? "0x"]
  );
  const takeParams = ABI.encode(
    ["address", "address", "address"],
    [args.poolKey.currency0, args.poolKey.currency1, args.recipient]
  );
  return ABI.encode(
    ["bytes", "bytes[]"],
    [packActions([V4Actions.BURN_POSITION, V4Actions.TAKE_PAIR]), [burnParams, takeParams]]
  );
}

/** Sort two ERC20 addresses to satisfy V4's `currency0 < currency1` invariant. */
export function sortCurrencies(a: string, b: string): {currency0: string; currency1: string} {
  return a.toLowerCase() < b.toLowerCase()
    ? {currency0: a, currency1: b}
    : {currency0: b, currency1: a};
}
