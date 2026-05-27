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
];

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
  return Promise.all(ids.map((id) => readV3Position(npmAddress, provider, id)));
}
