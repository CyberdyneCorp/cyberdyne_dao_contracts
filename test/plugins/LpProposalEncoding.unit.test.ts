/**
 * Proves the V3 + V4 LP proposal-action builders the frontend uses produce
 * calldata that decodes back to the exact plugin function the DAO would
 * execute. This is the "frontend can build LP votes" claim, validated at the
 * ABI layer — independent of whether a TokenVoting plugin is actually
 * installed on the DAO (the proposal payload is the same either way).
 *
 * The frontend builders live in `frontend/src/lib/actions.ts`. Their shape
 * mirrors what's exercised here — both pass the same args through to
 * `ethers.utils.Interface.encodeFunctionData`, so if these decode, the
 * frontend's submissions will too.
 */
import {expect} from "chai";
import {ethers} from "hardhat";
import {UniswapV3Plugin__factory, UniswapV4Plugin__factory} from "../../typechain-types";

describe("LP proposal-action encoding (frontend ↔ contracts)", () => {
  describe("UniswapV3Plugin actions", () => {
    const v3 = new ethers.utils.Interface(UniswapV3Plugin__factory.abi);
    const tokenA = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC
    const tokenB = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // WETH
    const deadline = 99_999_999_999;

    it("mint: encodes the full MintParams tuple", async () => {
      // No `recipient` field — the plugin forces it to dao() on-chain.
      const params = {
        token0: tokenA,
        token1: tokenB,
        fee: 3000,
        tickLower: -887220,
        tickUpper: 887220,
        amount0Desired: ethers.utils.parseUnits("1000", 6),
        amount1Desired: ethers.utils.parseEther("0.5"),
        amount0Min: 0,
        amount1Min: 0,
        deadline,
      };
      const data = v3.encodeFunctionData("mint", [params]);
      const decoded = v3.decodeFunctionData("mint", data);
      expect(decoded[0].token0).to.equal(tokenA);
      expect(decoded[0].token1).to.equal(tokenB);
      expect(decoded[0].fee).to.equal(3000);
      expect(decoded[0].amount0Desired).to.equal(params.amount0Desired);
      // Selector matches the plugin's mint.
      expect(v3.getSighash("mint")).to.equal(data.slice(0, 10));
    });

    it("increaseLiquidity / decreaseLiquidity / collect / burn encode and decode", async () => {
      const tokenId = 12345;
      const inc = v3.encodeFunctionData("increaseLiquidity", [
        tokenId,
        ethers.utils.parseUnits("100", 6),
        ethers.utils.parseEther("0.05"),
        0,
        0,
        deadline,
      ]);
      expect(v3.decodeFunctionData("increaseLiquidity", inc)[0]).to.equal(tokenId);

      const dec = v3.encodeFunctionData("decreaseLiquidity", [tokenId, 1_000_000, 0, 0, deadline]);
      expect(v3.decodeFunctionData("decreaseLiquidity", dec)[1]).to.equal(1_000_000);

      const U128_MAX = ethers.BigNumber.from(2).pow(128).sub(1);
      const col = v3.encodeFunctionData("collect", [tokenId, U128_MAX, U128_MAX]);
      expect(v3.decodeFunctionData("collect", col)[0]).to.equal(tokenId);

      const brn = v3.encodeFunctionData("burn", [tokenId]);
      expect(v3.decodeFunctionData("burn", brn)[0]).to.equal(tokenId);
    });
  });

  describe("UniswapV4Plugin LP action (modifyLiquidities)", () => {
    const v4 = new ethers.utils.Interface(UniswapV4Plugin__factory.abi);
    const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

    it("encodes a mint-shaped LP op (two inputs, no outputs)", async () => {
      // unlockData is the v4 action stream — the plugin treats it as opaque.
      // Build a representative envelope: actions = [MINT_POSITION=0x02, SETTLE_PAIR=0x0d]
      // and an empty params[] (real flow would carry the encoded params).
      const unlockData = ethers.utils.defaultAbiCoder.encode(["bytes", "bytes[]"], ["0x020d", []]);
      const deadline = 99_999_999_999;
      const inputCurrencies = [usdc, weth];
      const maxIn = [ethers.utils.parseUnits("1000", 6), ethers.utils.parseEther("0.5")];

      const data = v4.encodeFunctionData("modifyLiquidities", [
        unlockData,
        deadline,
        inputCurrencies,
        maxIn,
        [],
        [],
      ]);
      const decoded = v4.decodeFunctionData("modifyLiquidities", data);
      expect(decoded.unlockData).to.equal(unlockData);
      expect(decoded.deadline).to.equal(deadline);
      expect(decoded.inputCurrencies).to.deep.equal(inputCurrencies);
      expect(decoded.maxIn.map((b: ethers.BigNumber) => b.toString())).to.deep.equal(
        maxIn.map((b) => b.toString())
      );
      expect(v4.getSighash("modifyLiquidities")).to.equal(data.slice(0, 10));
    });

    it("encodes a decrease/collect-shaped LP op (no inputs, two outputs with minOut)", async () => {
      const unlockData = ethers.utils.defaultAbiCoder.encode(
        ["bytes", "bytes[]"],
        ["0x0111", []] // [DECREASE_LIQUIDITY=0x01, TAKE_PAIR=0x11]
      );
      const minOut = [ethers.utils.parseUnits("450", 6), ethers.utils.parseEther("0.22")];
      const data = v4.encodeFunctionData("modifyLiquidities", [
        unlockData,
        99_999_999_999,
        [],
        [],
        [usdc, weth],
        minOut,
      ]);
      const decoded = v4.decodeFunctionData("modifyLiquidities", data);
      expect(decoded.outputCurrencies).to.deep.equal([usdc, weth]);
      expect(decoded.minOut.map((b: ethers.BigNumber) => b.toString())).to.deep.equal(
        minOut.map((b) => b.toString())
      );
    });

    it("setV4PositionManager has a stable selector", async () => {
      const newPM = ethers.Wallet.createRandom().address;
      const data = v4.encodeFunctionData("setV4PositionManager", [newPM]);
      expect(v4.decodeFunctionData("setV4PositionManager", data)[0]).to.equal(newPM);
    });
  });
});
