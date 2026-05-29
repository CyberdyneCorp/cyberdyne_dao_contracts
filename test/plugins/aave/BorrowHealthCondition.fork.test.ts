/**
 * BorrowHealthCondition fork integration tests.
 *
 * Runs against the REAL AAVE v3 Pool + price oracle so the health-factor
 * projection is validated against AAVE's own math on a live DAO position.
 * Mirrors the AaveLendingPlugin fork harness (MinimalDAO + AaveV3Adapter).
 *
 * Skipped on non-fork networks via onlyOn(...).
 */
import {expect} from "chai";
import {ethers, network} from "hardhat";
import type {Signer} from "ethers";
import {
  AaveLendingPlugin,
  AaveLendingPlugin__factory,
  AaveV3Adapter__factory,
  BorrowHealthCondition,
  BorrowHealthCondition__factory,
  MinimalDAO,
  MinimalDAO__factory,
} from "../../../typechain-types";
import {onlyOn} from "../../helpers/fork-guard";
import {EXTERNAL, type ExternalChain} from "../../helpers/addresses";
import {fundFromWhale} from "../../helpers/impersonate";
import {takeSnapshot} from "../../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

const TRIGGER_LENDING_PERMISSION_ID = ethers.utils.id("TRIGGER_LENDING_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");
const VARIABLE_RATE = 2;
const FLOOR = ethers.utils.parseEther("1.5");

const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];

const WETH_WHALES: Record<ExternalChain, string> = {
  mainnet: "0x8EB8a3b98659Cce290402893d0123abb75E3ab28",
  base: "0x4200000000000000000000000000000000000006",
};

function chainKey(): ExternalChain {
  if (network.name === "mainnetFork") return "mainnet";
  if (network.name === "baseFork") return "base";
  throw new Error(`Unsupported fork network: ${network.name}`);
}

async function deployPlugin(
  signer: Signer,
  dao: string,
  adapter: string
): Promise<AaveLendingPlugin> {
  const impl = await new AaveLendingPlugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [dao, adapter, []]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await Proxy.deploy(impl.address, initData);
  await proxy.deployed();
  return AaveLendingPlugin__factory.connect(proxy.address, signer);
}

onlyOn(["mainnetFork", "baseFork"], () => {
  describe(`BorrowHealthCondition (fork: ${network.name}) [fork]`, function () {
    this.retries(2);

    let deployer: Signer;
    let voter: Signer;
    let dao: MinimalDAO;
    let plugin: AaveLendingPlugin;
    let cond: BorrowHealthCondition;
    let pool: import("ethers").Contract;
    let usdcAddress: string;
    let wethAddress: string;
    let poolAddress: string;
    let snapshot: SnapshotRestorer;

    before(async () => {
      [deployer, voter] = await ethers.getSigners();
      const chain = chainKey();
      usdcAddress = EXTERNAL[chain].USDC;
      wethAddress = EXTERNAL[chain].WETH;
      poolAddress = EXTERNAL[chain].AAVE_V3_POOL;
      pool = new ethers.Contract(poolAddress, POOL_ABI, ethers.provider);
    });

    beforeEach(async () => {
      dao = await new MinimalDAO__factory(deployer).deploy();
      await dao.deployed();
      const adapter = await new AaveV3Adapter__factory(deployer).deploy(poolAddress);
      await adapter.deployed();
      plugin = await deployPlugin(deployer, dao.address, adapter.address);
      await dao.grant(plugin.address, await voter.getAddress(), TRIGGER_LENDING_PERMISSION_ID);
      await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);

      // governor = deployer here so the retune test can call setMinHealthFactor
      // directly (in production it's the DAO, exercised via a vote).
      cond = await new BorrowHealthCondition__factory(deployer).deploy(
        poolAddress,
        await deployer.getAddress(),
        FLOOR
      );
      await cond.deployed();

      // Seed a real collateral position: 5 WETH supplied by the DAO.
      const collateral = ethers.utils.parseEther("5");
      await fundFromWhale(wethAddress, WETH_WHALES[chainKey()], dao.address, collateral);
      await plugin.connect(voter).supply(wethAddress, collateral);

      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      if (snapshot) await snapshot.restore();
    });

    it("projection matches AAVE's own post-borrow health factor", async () => {
      const amount = ethers.utils.parseUnits("2000", 6); // 2000 USDC
      const projected = await cond.projectedHealthFactorAfterBorrow(
        dao.address,
        usdcAddress,
        amount
      );

      await plugin.connect(voter).borrow(usdcAddress, amount, VARIABLE_RATE);
      const actual = (await pool.getUserAccountData(dao.address)).healthFactor;

      // Same collateral + oracle price; AAVE's debt == our projected debt, so
      // the projection should track AAVE's HF within ~1% (interest accrual).
      expect(actual).to.be.closeTo(projected, projected.div(100));
    });

    it("isGranted allows a conservative borrow", async () => {
      const small = ethers.utils.parseUnits("100", 6);
      expect(
        await cond.projectedHealthFactorAfterBorrow(dao.address, usdcAddress, small)
      ).to.be.gte(FLOOR);
      const data = AaveLendingPlugin__factory.createInterface().encodeFunctionData("borrow", [
        usdcAddress,
        small,
        VARIABLE_RATE,
      ]);
      expect(
        await cond.isGranted(plugin.address, dao.address, TRIGGER_LENDING_PERMISSION_ID, data)
      ).to.equal(true);
    });

    it("isGranted denies an over-borrow that breaches the floor", async () => {
      // Borrow ~2x the available headroom — projected HF drops well below 1.5.
      const acct = await pool.getUserAccountData(dao.address);
      const overBorrow = acct.availableBorrowsBase.mul(2).div(100); // 8-dec USD → 6-dec USDC, ×2
      expect(
        await cond.projectedHealthFactorAfterBorrow(dao.address, usdcAddress, overBorrow)
      ).to.be.lt(FLOOR);
      const data = AaveLendingPlugin__factory.createInterface().encodeFunctionData("borrow", [
        usdcAddress,
        overBorrow,
        VARIABLE_RATE,
      ]);
      expect(
        await cond.isGranted(plugin.address, dao.address, TRIGGER_LENDING_PERMISSION_ID, data)
      ).to.equal(false);
    });

    it("assertHealthFactor passes with no debt, reverts after a real over-leveraged borrow", async () => {
      // No debt yet → AAVE reports HF = max → passes.
      await cond.assertHealthFactor(dao.address);

      // Borrow ~85% of the LTV headroom: AAVE allows it, but it lands HF in the
      // (1.0, 1.5) band — below our floor — so the in-batch guard must revert.
      const acct = await pool.getUserAccountData(dao.address);
      const borrowUsdc = acct.availableBorrowsBase.mul(85).div(10000); // 8-dec USD → 6-dec USDC, ×0.85
      await plugin.connect(voter).borrow(usdcAddress, borrowUsdc, VARIABLE_RATE);

      const after = (await pool.getUserAccountData(dao.address)).healthFactor;
      expect(after).to.be.gt(ethers.utils.parseEther("1")); // AAVE accepted it
      expect(after).to.be.lt(FLOOR); // but it breaches our floor

      await expect(cond.assertHealthFactor(dao.address)).to.be.revertedWithCustomError(
        cond,
        "HealthFactorBelowFloor"
      );
    });

    it("a governance retune of the floor changes enforcement against the live pool", async () => {
      const small = ethers.utils.parseUnits("100", 6);
      const data = AaveLendingPlugin__factory.createInterface().encodeFunctionData("borrow", [
        usdcAddress,
        small,
        VARIABLE_RATE,
      ]);
      // Conservative borrow passes at the 1.5 floor.
      expect(
        await cond.isGranted(plugin.address, dao.address, TRIGGER_LENDING_PERMISSION_ID, data)
      ).to.equal(true);

      // Governor (the DAO in prod) raises the floor sky-high → same borrow now
      // denied; the projection is recomputed against the live position.
      await cond.connect(deployer).setMinHealthFactor(ethers.utils.parseEther("1000000"));
      expect(
        await cond.isGranted(plugin.address, dao.address, TRIGGER_LENDING_PERMISSION_ID, data)
      ).to.equal(false);
    });
  });
});
