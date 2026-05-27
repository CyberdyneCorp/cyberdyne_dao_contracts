/**
 * UniswapV3Plugin fork integration test.
 *
 * Runs against a forked mainnet so the DAO mints a REAL Uniswap V3 USDC/WETH
 * position via the canonical NonfungiblePositionManager, funded with real
 * tokens from whales. Mirrors the by-hand demo (position NFT owned by the DAO).
 *
 * Skipped on non-fork networks via the onlyOn(...) guard.
 */
import {ethers, network} from "hardhat";
import {expect} from "chai";
import type {Signer} from "ethers";
import {
  MinimalDAO,
  MinimalDAO__factory,
  UniswapV3Plugin,
  UniswapV3Plugin__factory,
} from "../../../typechain-types";
import {onlyOn} from "../../helpers/fork-guard";
import {EXTERNAL} from "../../helpers/addresses";
import {fundFromWhale} from "../../helpers/impersonate";

// Uniswap V3 NonfungiblePositionManager (mainnet).
const NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const USDC_WHALE = "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf";
const WETH_WHALE = "0x8EB8a3b98659Cce290402893d0123abb75E3ab28";
const FEE = 3000;
const FULL_RANGE_LOWER = -887220;
const FULL_RANGE_UPPER = 887220;
const FUTURE = 99_999_999_999;

const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const NPM_ABI = ["function ownerOf(uint256) view returns (address)"];

async function deployProxied(signer: Signer, dao: string): Promise<UniswapV3Plugin> {
  const impl = await new UniswapV3Plugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [dao, NPM, []]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await Proxy.deploy(impl.address, initData);
  await proxy.deployed();
  return UniswapV3Plugin__factory.connect(proxy.address, signer);
}

onlyOn(["mainnetFork"], () => {
  describe(`UniswapV3Plugin (fork: ${network.name}) [fork]`, function () {
    // Retry transient public-RPC zero-reads (see AAVE fork test for rationale).
    this.retries(2);

    let deployer: Signer;
    let voter: Signer;
    let dao: MinimalDAO;
    let plugin: UniswapV3Plugin;
    let usdc: string;
    let weth: string;
    let token0: string;
    let token1: string;

    const MANAGE = ethers.utils.id("MANAGE_POSITIONS_PERMISSION");
    const EXECUTE = ethers.utils.id("EXECUTE_PERMISSION");

    before(() => {
      usdc = EXTERNAL.mainnet.USDC;
      weth = EXTERNAL.mainnet.WETH;
      // V3 requires token0 < token1 by address.
      [token0, token1] = usdc.toLowerCase() < weth.toLowerCase() ? [usdc, weth] : [weth, usdc];
    });

    beforeEach(async () => {
      [deployer, voter] = await ethers.getSigners();
      dao = await new MinimalDAO__factory(deployer).deploy();
      await dao.deployed();
      plugin = await deployProxied(deployer, dao.address);
      await dao.grant(plugin.address, await voter.getAddress(), MANAGE);
      await dao.grant(dao.address, plugin.address, EXECUTE);
      // Seed the DAO with both tokens.
      await fundFromWhale(usdc, USDC_WHALE, dao.address, ethers.utils.parseUnits("3000", 6));
      await fundFromWhale(weth, WETH_WHALE, dao.address, ethers.utils.parseEther("1"));
    });

    it("mints a real V3 USDC/WETH position owned by the DAO", async () => {
      const amount0 =
        token0.toLowerCase() === usdc.toLowerCase()
          ? ethers.utils.parseUnits("1000", 6)
          : ethers.utils.parseEther("0.5");
      const amount1 =
        token1.toLowerCase() === weth.toLowerCase()
          ? ethers.utils.parseEther("0.5")
          : ethers.utils.parseUnits("1000", 6);

      await expect(
        plugin.connect(voter).mint({
          token0,
          token1,
          fee: FEE,
          tickLower: FULL_RANGE_LOWER,
          tickUpper: FULL_RANGE_UPPER,
          amount0Desired: amount0,
          amount1Desired: amount1,
          amount0Min: 0,
          amount1Min: 0,
          deadline: FUTURE,
        })
      ).to.emit(plugin, "PositionMinted");

      // The position NFT is owned by the DAO; the plugin custodies nothing.
      const npm = new ethers.Contract(NPM, NPM_ABI, ethers.provider);
      const erc20In = (a: string) => new ethers.Contract(a, ERC20, ethers.provider);
      expect(await erc20In(usdc).balanceOf(plugin.address)).to.equal(0);
      expect(await erc20In(weth).balanceOf(plugin.address)).to.equal(0);

      // The new tokenId comes from the PositionMinted event.
      const ev = (await plugin.queryFilter(plugin.filters.PositionMinted())).pop();
      const tokenId = ev?.args?.tokenId;
      expect(tokenId).to.not.be.undefined;
      expect(await npm.ownerOf(tokenId)).to.equal(dao.address);
    });

    it("decreaseLiquidity + collect returns underlying to the DAO", async () => {
      const amount0 =
        token0.toLowerCase() === usdc.toLowerCase()
          ? ethers.utils.parseUnits("1000", 6)
          : ethers.utils.parseEther("0.5");
      const amount1 =
        token1.toLowerCase() === weth.toLowerCase()
          ? ethers.utils.parseEther("0.5")
          : ethers.utils.parseUnits("1000", 6);

      await plugin.connect(voter).mint({
        token0,
        token1,
        fee: FEE,
        tickLower: FULL_RANGE_LOWER,
        tickUpper: FULL_RANGE_UPPER,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0,
        amount1Min: 0,
        deadline: FUTURE,
      });
      const ev = (await plugin.queryFilter(plugin.filters.PositionMinted())).pop();
      const tokenId = ev!.args!.tokenId;

      const npmRead = new ethers.Contract(
        NPM,
        [
          "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
        ],
        ethers.provider
      );
      const liquidity = (await npmRead.positions(tokenId))[7];

      const usdcC = new ethers.Contract(usdc, ERC20, ethers.provider);
      const daoUsdcBefore = await usdcC.balanceOf(dao.address);

      await plugin.connect(voter).decreaseLiquidity(tokenId, liquidity, 0, 0, FUTURE);
      const U128_MAX = ethers.BigNumber.from(2).pow(128).sub(1);
      await expect(plugin.connect(voter).collect(tokenId, U128_MAX, U128_MAX)).to.emit(
        plugin,
        "FeesCollected"
      );

      // The DAO got its USDC back (recipient forced to DAO).
      expect(await usdcC.balanceOf(dao.address)).to.be.gt(daoUsdcBefore);
    });
  });
});
