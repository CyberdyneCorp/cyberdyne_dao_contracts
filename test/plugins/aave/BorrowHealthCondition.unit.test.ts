import {expect} from "chai";
import {ethers} from "hardhat";
import type {Signer} from "ethers";
import {
  AaveLendingPlugin__factory,
  BorrowHealthCondition,
  BorrowHealthCondition__factory,
  MockAaveForHealthCondition,
  MockAaveForHealthCondition__factory,
  TestERC20,
  TestERC20__factory,
} from "../../../typechain-types";

const FLOOR = ethers.utils.parseEther("1.5"); // 1.5e18 health-factor floor
const MAX_UINT = ethers.constants.MaxUint256;
// Base currency is 8-decimal USD on AAVE v3.
const usd = (n: number) => ethers.BigNumber.from(10).pow(8).mul(n);

// borrow(address,uint256,uint256) calldata, via the real plugin interface.
function borrowData(asset: string, amount: ethers.BigNumber, rateMode = 2): string {
  return AaveLendingPlugin__factory.createInterface().encodeFunctionData("borrow", [
    asset,
    amount,
    rateMode,
  ]);
}

describe("BorrowHealthCondition", () => {
  let deployer: Signer;
  let governor: Signer; // stands in for the DAO that may retune the floor
  let stranger: Signer;
  let dao: string; // the borrower account passed as `who`
  let mock: MockAaveForHealthCondition;
  let asset: TestERC20; // 6-decimal asset, $1 each
  let cond: BorrowHealthCondition;

  const PERM = ethers.utils.id("TRIGGER_LENDING_PERMISSION");
  const amt = (whole: number) => ethers.BigNumber.from(10).pow(6).mul(whole); // 6-dec units

  beforeEach(async () => {
    [deployer, governor, stranger] = await ethers.getSigners();
    dao = ethers.Wallet.createRandom().address;

    mock = await new MockAaveForHealthCondition__factory(deployer).deploy();
    await mock.deployed();
    asset = await new TestERC20__factory(deployer).deploy("USD Coin", "USDC", 6);
    await asset.deployed();

    cond = await new BorrowHealthCondition__factory(deployer).deploy(
      mock.address,
      await governor.getAddress(),
      FLOOR
    );
    await cond.deployed();

    // $2000 collateral, no debt yet, 80% liquidation threshold; asset = $1.
    await mock.setHealthData(usd(2000), 0, 8000, MAX_UINT);
    await mock.setPrice(asset.address, usd(1));
  });

  describe("constructor guards", () => {
    it("rejects a zero pool or zero governor", async () => {
      const gov = await governor.getAddress();
      await expect(
        new BorrowHealthCondition__factory(deployer).deploy(
          ethers.constants.AddressZero,
          gov,
          FLOOR
        )
      ).to.be.revertedWithCustomError(cond, "ZeroAddress");
      await expect(
        new BorrowHealthCondition__factory(deployer).deploy(
          mock.address,
          ethers.constants.AddressZero,
          FLOOR
        )
      ).to.be.revertedWithCustomError(cond, "ZeroAddress");
    });

    it("rejects a floor below 1e18 (liquidation)", async () => {
      await expect(
        new BorrowHealthCondition__factory(deployer).deploy(
          mock.address,
          await governor.getAddress(),
          ethers.utils.parseEther("0.9")
        )
      ).to.be.revertedWithCustomError(cond, "InvalidMinHealthFactor");
    });
  });

  describe("setMinHealthFactor (governance-settable floor)", () => {
    it("lets the governor retune the floor and emits", async () => {
      const newFloor = ethers.utils.parseEther("2");
      await expect(cond.connect(governor).setMinHealthFactor(newFloor))
        .to.emit(cond, "MinHealthFactorUpdated")
        .withArgs(FLOOR, newFloor);
      expect(await cond.minHealthFactor()).to.equal(newFloor);
    });

    it("applies the new floor to isGranted immediately", async () => {
      // $1000 borrow → projected HF 1.6e18. Passes at 1.5 floor…
      const data = borrowData(asset.address, amt(1000));
      expect(await cond.isGranted(asset.address, dao, PERM, data)).to.equal(true);
      // …raise floor to 1.7 → same borrow now denied.
      await cond.connect(governor).setMinHealthFactor(ethers.utils.parseEther("1.7"));
      expect(await cond.isGranted(asset.address, dao, PERM, data)).to.equal(false);
    });

    it("reverts NotGovernor for anyone else", async () => {
      await expect(
        cond.connect(stranger).setMinHealthFactor(ethers.utils.parseEther("2"))
      ).to.be.revertedWithCustomError(cond, "NotGovernor");
    });

    it("reverts InvalidMinHealthFactor below 1e18", async () => {
      await expect(
        cond.connect(governor).setMinHealthFactor(ethers.utils.parseEther("0.99"))
      ).to.be.revertedWithCustomError(cond, "InvalidMinHealthFactor");
    });
  });

  describe("projectedHealthFactorAfterBorrow", () => {
    it("computes HF = collateral·LT / projectedDebt (1e18)", async () => {
      // 2000·0.8 / 1000 = 1.6 → 1.6e18
      const hf = await cond.projectedHealthFactorAfterBorrow(dao, asset.address, amt(1000));
      expect(hf).to.equal(ethers.utils.parseEther("1.6"));
    });

    it("returns max when there is no resulting debt", async () => {
      const hf = await cond.projectedHealthFactorAfterBorrow(dao, asset.address, 0);
      expect(hf).to.equal(MAX_UINT);
    });

    it("accounts for pre-existing debt", async () => {
      await mock.setHealthData(usd(2000), usd(500), 8000, MAX_UINT);
      // 2000·0.8 / (500 + 500) = 1.6 → 1.6e18
      const hf = await cond.projectedHealthFactorAfterBorrow(dao, asset.address, amt(500));
      expect(hf).to.equal(ethers.utils.parseEther("1.6"));
    });
  });

  describe("isGranted (direct borrow path)", () => {
    it("allows a borrow that stays at/above the floor", async () => {
      // borrow $1000 → projected HF 1.6e18 ≥ 1.5e18
      expect(
        await cond.isGranted(asset.address, dao, PERM, borrowData(asset.address, amt(1000)))
      ).to.equal(true);
    });

    it("denies a borrow that would breach the floor", async () => {
      // borrow $1100 → 2000·0.8/1100 = 1.4545e18 < 1.5e18
      expect(
        await cond.isGranted(asset.address, dao, PERM, borrowData(asset.address, amt(1100)))
      ).to.equal(false);
    });

    it("allows the exact-floor borrow boundary", async () => {
      // Need projected HF == 1.5e18: debt = 2000·0.8/1.5 = 1066.66… → use $1066.6 (slightly under)
      // borrow that yields HF just ≥ floor passes; just-over-debt fails (covered above).
      // collateral·LT / floor = 2000e8·8000 / (1e4·1.5e18/1e18) = exact-debt boundary.
      // Use $1066 → HF = 1600/1066 = 1.5009e18 ≥ floor.
      expect(
        await cond.isGranted(asset.address, dao, PERM, borrowData(asset.address, amt(1066)))
      ).to.equal(true);
    });

    it("ignores non-borrow selectors (supply/withdraw/repay/etc.)", async () => {
      const supplyData = AaveLendingPlugin__factory.createInterface().encodeFunctionData("supply", [
        asset.address,
        amt(999999),
      ]);
      expect(await cond.isGranted(asset.address, dao, PERM, supplyData)).to.equal(true);
    });

    it("ignores empty / short calldata", async () => {
      expect(await cond.isGranted(asset.address, dao, PERM, "0x")).to.equal(true);
      expect(await cond.isGranted(asset.address, dao, PERM, "0x1234")).to.equal(true);
    });

    it("fails closed if the oracle reverts", async () => {
      await mock.setOracleReverts(true);
      await expect(cond.isGranted(asset.address, dao, PERM, borrowData(asset.address, amt(1)))).to
        .be.reverted;
    });
  });

  describe("assertHealthFactor (in-batch governance guard)", () => {
    it("passes when the current HF is at/above the floor", async () => {
      await mock.setHealthData(usd(2000), usd(500), 8000, ethers.utils.parseEther("2"));
      await cond.assertHealthFactor(dao); // does not revert
    });

    it("passes when there is no debt (HF = max)", async () => {
      await mock.setHealthData(usd(2000), 0, 8000, MAX_UINT);
      await cond.assertHealthFactor(dao);
    });

    it("reverts HealthFactorBelowFloor when below the floor", async () => {
      await mock.setHealthData(usd(2000), usd(1300), 8000, ethers.utils.parseEther("1.23"));
      await expect(cond.assertHealthFactor(dao))
        .to.be.revertedWithCustomError(cond, "HealthFactorBelowFloor")
        .withArgs(dao, ethers.utils.parseEther("1.23"), FLOOR);
    });
  });

  it("exposes pool + minHealthFactor + BORROW_SELECTOR", async () => {
    expect(await cond.pool()).to.equal(mock.address);
    expect(await cond.minHealthFactor()).to.equal(FLOOR);
    expect(await cond.BORROW_SELECTOR()).to.equal(
      AaveLendingPlugin__factory.createInterface().getSighash("borrow")
    );
  });
});
