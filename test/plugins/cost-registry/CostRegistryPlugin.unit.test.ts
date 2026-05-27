import {expect} from "chai";
import {ethers} from "hardhat";
import type {BigNumber, Signer} from "ethers";
import {
  MinimalDAO,
  MinimalDAO__factory,
  CostRegistryPlugin,
  CostRegistryPlugin__factory,
  TestERC20,
  TestERC20__factory,
} from "../../../typechain-types";
import {takeSnapshot, time} from "../../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

const MANAGE_COSTS_PERMISSION_ID = ethers.utils.id("MANAGE_COSTS_PERMISSION");
const UPDATE_PAYMENT_TOKEN_PERMISSION_ID = ethers.utils.id("UPDATE_PAYMENT_TOKEN_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");
const DAY = 86_400;

// USDC-like 6-decimal amounts.
const usdc = (n: number): BigNumber => ethers.utils.parseUnits(n.toString(), 6);

async function deployProxied(
  signer: Signer,
  dao: string,
  token: string
): Promise<CostRegistryPlugin> {
  const impl = await new CostRegistryPlugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [dao, token]);
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await ProxyFactory.deploy(impl.address, initData);
  await proxy.deployed();
  return CostRegistryPlugin__factory.connect(proxy.address, signer);
}

describe("CostRegistryPlugin", () => {
  let deployer: Signer;
  let voter: Signer;
  let stranger: Signer;
  let aws: string;
  let openai: string;
  let dao: MinimalDAO;
  let plugin: CostRegistryPlugin;
  let token: TestERC20;
  let snapshot: SnapshotRestorer;

  afterEach(async () => {
    if (snapshot) await snapshot.restore();
  });

  beforeEach(async () => {
    [deployer, voter, stranger] = await ethers.getSigners();
    aws = ethers.Wallet.createRandom().address;
    openai = ethers.Wallet.createRandom().address;

    dao = await new MinimalDAO__factory(deployer).deploy();
    await dao.deployed();
    token = await new TestERC20__factory(deployer).deploy("USD Coin", "USDC", 6);
    await token.deployed();

    plugin = await deployProxied(deployer, dao.address, token.address);

    await dao.grant(plugin.address, await voter.getAddress(), MANAGE_COSTS_PERMISSION_ID);
    await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);

    snapshot = await takeSnapshot();
  });

  describe("initialize", () => {
    it("sets paymentToken + caps and disables the impl initializer", async () => {
      expect(await plugin.paymentToken()).to.equal(token.address);
      expect(await plugin.MAX_ENTRIES()).to.equal(300);
      expect(await plugin.MAX_PER_PAGE()).to.equal(100);
      expect(await plugin.entryCount()).to.equal(0);
    });

    it("rejects a zero payment token", async () => {
      const impl = await new CostRegistryPlugin__factory(deployer).deploy();
      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
      const initData = impl.interface.encodeFunctionData("initialize", [
        dao.address,
        ethers.constants.AddressZero,
      ]);
      await expect(ProxyFactory.deploy(impl.address, initData)).to.be.revertedWithCustomError(
        plugin,
        "ZeroAddress"
      );
    });

    it("cannot be initialized twice", async () => {
      await expect(plugin.initialize(dao.address, token.address)).to.be.revertedWith(
        "Initializable: contract is already initialized"
      );
    });
  });

  describe("registerEntry", () => {
    it("registers and emits, returns the new id, stores fields", async () => {
      const id = await plugin
        .connect(voter)
        .callStatic.registerEntry("AWS", "cloud bill", usdc(500), 30, aws);
      expect(id).to.equal(0);

      await expect(plugin.connect(voter).registerEntry("AWS", "cloud bill", usdc(500), 30, aws))
        .to.emit(plugin, "EntryRegistered")
        .withArgs(0, aws, usdc(500), 30, "AWS");

      expect(await plugin.entryCount()).to.equal(1);
      const e = await plugin.getEntry(0);
      expect(e.payee).to.equal(aws);
      expect(e.costUsdc).to.equal(usdc(500));
      expect(e.frequencyDays).to.equal(30);
      expect(e.active).to.equal(true);
      expect(e.name).to.equal("AWS");
      expect(e.description).to.equal("cloud bill");
      // First payment due one period after registration.
      expect(await plugin.isDue(0)).to.equal(false);
    });

    it("rejects zero payee / amount / frequency / empty name / oversized cost", async () => {
      await expect(
        plugin.connect(voter).registerEntry("X", "", usdc(1), 1, ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(plugin, "ZeroAddress");
      await expect(
        plugin.connect(voter).registerEntry("X", "", 0, 1, aws)
      ).to.be.revertedWithCustomError(plugin, "ZeroAmount");
      await expect(
        plugin.connect(voter).registerEntry("X", "", usdc(1), 0, aws)
      ).to.be.revertedWithCustomError(plugin, "ZeroFrequency");
      await expect(
        plugin.connect(voter).registerEntry("", "", usdc(1), 1, aws)
      ).to.be.revertedWithCustomError(plugin, "EmptyName");
      const tooBig = ethers.BigNumber.from(2).pow(96); // > uint96 max
      await expect(
        plugin.connect(voter).registerEntry("X", "", tooBig, 1, aws)
      ).to.be.revertedWithCustomError(plugin, "CostTooLarge");
    });

    it("trips MAX_COST_USDC at MAX + 1 (defense-in-depth cap on cost)", async () => {
      const max = await plugin.MAX_COST_USDC();
      // MAX itself is allowed — the cap is `costUsdc > MAX_COST_USDC`.
      await expect(plugin.connect(voter).registerEntry("X", "", max, 1, aws)).to.emit(
        plugin,
        "EntryRegistered"
      );
      // MAX + 1 reverts CostTooLarge.
      await expect(plugin.connect(voter).registerEntry("X", "", max.add(1), 1, aws))
        .to.be.revertedWithCustomError(plugin, "CostTooLarge")
        .withArgs(max.add(1));
    });

    it("reverts when caller lacks MANAGE_COSTS", async () => {
      await expect(plugin.connect(stranger).registerEntry("X", "", usdc(1), 1, aws)).to.be.reverted;
    });

    it("reverts when MAX_ENTRIES reached", async () => {
      const cap = (await plugin.MAX_ENTRIES()).toNumber();
      for (let i = 0; i < cap; i++) {
        await plugin.connect(voter).registerEntry("c", "", usdc(1), 1, aws);
      }
      await expect(plugin.connect(voter).registerEntry("c", "", usdc(1), 1, aws))
        .to.be.revertedWithCustomError(plugin, "EntryLimitExceeded")
        .withArgs(cap);
    }).timeout(180_000);
  });

  describe("updateEntry", () => {
    beforeEach(async () => {
      await plugin.connect(voter).registerEntry("AWS", "cloud", usdc(500), 30, aws);
    });

    it("overwrites fields, emits, preserves lastPaidAt", async () => {
      const before = (await plugin.getEntry(0)).lastPaidAt;
      await expect(
        plugin.connect(voter).updateEntry(0, "AWS-prod", "bigger", usdc(900), 15, openai)
      )
        .to.emit(plugin, "EntryUpdated")
        .withArgs(0, openai, usdc(900), 15);
      const e = await plugin.getEntry(0);
      expect(e.payee).to.equal(openai);
      expect(e.costUsdc).to.equal(usdc(900));
      expect(e.frequencyDays).to.equal(15);
      expect(e.name).to.equal("AWS-prod");
      expect(e.lastPaidAt).to.equal(before); // schedule preserved
    });

    it("reverts EntryNotFound for bad id or soft-deleted", async () => {
      await expect(
        plugin.connect(voter).updateEntry(9, "X", "", usdc(1), 1, aws)
      ).to.be.revertedWithCustomError(plugin, "EntryNotFound");
      await plugin.connect(voter).removeEntry(0);
      await expect(
        plugin.connect(voter).updateEntry(0, "X", "", usdc(1), 1, aws)
      ).to.be.revertedWithCustomError(plugin, "EntryNotFound");
    });

    it("re-validates inputs", async () => {
      await expect(
        plugin.connect(voter).updateEntry(0, "X", "", 0, 1, aws)
      ).to.be.revertedWithCustomError(plugin, "ZeroAmount");
    });
  });

  describe("setPaymentToken", () => {
    let usdt: TestERC20;
    beforeEach(async () => {
      usdt = await new TestERC20__factory(deployer).deploy("Tether USD", "USDT", 6);
      await usdt.deployed();
      await dao.grant(plugin.address, await voter.getAddress(), UPDATE_PAYMENT_TOKEN_PERMISSION_ID);
    });

    it("vote-gated swap emits PaymentTokenUpdated and updates paymentToken()", async () => {
      const prev = await plugin.paymentToken();
      expect(prev).to.equal(token.address);
      await expect(plugin.connect(voter).setPaymentToken(usdt.address))
        .to.emit(plugin, "PaymentTokenUpdated")
        .withArgs(prev, usdt.address);
      expect(await plugin.paymentToken()).to.equal(usdt.address);
    });

    it("rejects address(0)", async () => {
      await expect(
        plugin.connect(voter).setPaymentToken(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(plugin, "ZeroAddress");
    });

    it("reverts when caller lacks UPDATE_PAYMENT_TOKEN_PERMISSION", async () => {
      await expect(plugin.connect(stranger).setPaymentToken(usdt.address)).to.be.reverted;
    });

    it("subsequent processDue uses the new token", async () => {
      // Register, fast-forward, swap token, fund DAO in NEW token, crank.
      await plugin.connect(voter).registerEntry("AWS", "", usdc(100), 1, aws);
      await time.increase(2 * DAY);
      await plugin.connect(voter).setPaymentToken(usdt.address);
      // DAO still holds the old token, none of the new — crank reverts the
      // single transfer via failureMap and pays nothing in old token.
      await usdt.mint(dao.address, usdc(100));
      await plugin.processDue(0, 10);
      expect(await usdt.balanceOf(aws)).to.equal(usdc(100));
      // Old token DAO balance unchanged.
      expect(await token.balanceOf(aws)).to.equal(0);
    });
  });

  describe("removeEntry (soft delete)", () => {
    it("flips active=false, keeps the slot, emits", async () => {
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 30, aws);
      await expect(plugin.connect(voter).removeEntry(0))
        .to.emit(plugin, "EntryRemoved")
        .withArgs(0);
      expect(await plugin.entryCount()).to.equal(1);
      expect((await plugin.getEntry(0)).active).to.equal(false);
      expect(await plugin.isDue(0)).to.equal(false);
    });

    it("reverts on unknown or already-removed", async () => {
      await expect(plugin.connect(voter).removeEntry(0)).to.be.revertedWithCustomError(
        plugin,
        "EntryNotFound"
      );
      await plugin.connect(voter).registerEntry("AWS", "", usdc(1), 1, aws);
      await plugin.connect(voter).removeEntry(0);
      await expect(plugin.connect(voter).removeEntry(0)).to.be.revertedWithCustomError(
        plugin,
        "EntryNotFound"
      );
    });
  });

  describe("getEntries (pagination)", () => {
    beforeEach(async () => {
      for (let i = 0; i < 5; i++) {
        await plugin.connect(voter).registerEntry(`c${i}`, "", usdc(i + 1), 10, aws);
      }
    });

    it("returns the requested slice + total", async () => {
      const [page, total] = await plugin.getEntries(1, 2);
      expect(total).to.equal(5);
      expect(page.length).to.equal(2);
      expect(page[0].name).to.equal("c1");
      expect(page[1].name).to.equal("c2");
    });

    it("clamps the tail and returns empty past the end", async () => {
      const [tail, total] = await plugin.getEntries(3, 100);
      expect(total).to.equal(5);
      expect(tail.length).to.equal(2); // c3, c4
      const [empty, total2] = await plugin.getEntries(99, 10);
      expect(total2).to.equal(5);
      expect(empty.length).to.equal(0);
    });

    it("clamps limit above MAX_PER_PAGE", async () => {
      // 1000 > MAX_PER_PAGE(100): exercises the clamp branch (only 5 entries here).
      const [page, total] = await plugin.getEntries(0, 1000);
      expect(total).to.equal(5);
      expect(page.length).to.equal(5);
    });

    it("getEntry reverts past the end", async () => {
      await expect(plugin.getEntry(5)).to.be.revertedWithCustomError(plugin, "EntryNotFound");
    });
  });

  describe("isDue / nextPaymentAt", () => {
    it("computes due-ness from lastPaidAt + frequency", async () => {
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      const next = await plugin.nextPaymentAt(0);
      expect(await plugin.isDue(0)).to.equal(false);
      await time.increaseTo(next.toNumber());
      expect(await plugin.isDue(0)).to.equal(true);
    });
  });

  describe("processDue", () => {
    async function fundDao(amount: BigNumber): Promise<void> {
      await token.mint(dao.address, amount);
    }

    it("pays a due entry, advances its clock, emits", async () => {
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      await fundDao(usdc(10_000));
      await time.increase(10 * DAY + 1);

      // limit 1000 > MAX_PER_PAGE(100) also exercises the clamp branch.
      await expect(plugin.connect(stranger).processDue(0, 1000))
        .to.emit(plugin, "CostPaid")
        .and.to.emit(plugin, "CostsProcessed");

      expect(await token.balanceOf(aws)).to.equal(usdc(500));
      expect(await plugin.isDue(0)).to.equal(false); // clock reset
    });

    it("pays nothing when no entry is due", async () => {
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      await fundDao(usdc(10_000));
      await plugin.processDue(0, 50); // immediately after register → not due
      expect(await token.balanceOf(aws)).to.equal(0);
    });

    it("processAllDue() pays the whole (sub-page) registry without an offset", async () => {
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      await plugin.connect(voter).registerEntry("OpenAI", "", usdc(300), 10, openai);
      await fundDao(usdc(10_000));
      await time.increase(11 * DAY);

      await expect(plugin.connect(stranger).processAllDue())
        .to.emit(plugin, "CostsProcessed")
        .withArgs(0, 2, 0); // offset 0, 2 paid, no failures
      expect(await token.balanceOf(aws)).to.equal(usdc(500));
      expect(await token.balanceOf(openai)).to.equal(usdc(300));
    });

    it("skips inactive (removed) entries", async () => {
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      await plugin.connect(voter).removeEntry(0);
      await fundDao(usdc(10_000));
      await time.increase(20 * DAY);
      await plugin.processDue(0, 50);
      expect(await token.balanceOf(aws)).to.equal(0);
    });

    it("no back-pay: 3 missed periods pay only once", async () => {
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      await fundDao(usdc(10_000));
      await time.increase(35 * DAY); // 3.5 periods elapsed
      await plugin.processDue(0, 50);
      expect(await token.balanceOf(aws)).to.equal(usdc(500)); // one payment, not three
    });

    it("isolates a failing transfer via the failure map", async () => {
      // Two due entries; fund the DAO for only one. The first transfer drains
      // the balance, the second reverts (insufficient balance) but is tolerated.
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      await plugin.connect(voter).registerEntry("OpenAI", "", usdc(500), 10, openai);
      await fundDao(usdc(500)); // covers exactly one
      await time.increase(11 * DAY);

      await expect(plugin.processDue(0, 50)).to.emit(plugin, "CostsProcessed").withArgs(0, 2, 2); // count=2, failureMap bit1 set (second entry failed)

      expect(await token.balanceOf(aws)).to.equal(usdc(500));
      expect(await token.balanceOf(openai)).to.equal(0);
      // Both clocks advanced (failed one waits a period — documented).
      expect(await plugin.isDue(0)).to.equal(false);
      expect(await plugin.isDue(1)).to.equal(false);
    });

    it("respects the index window", async () => {
      for (let i = 0; i < 4; i++) {
        await plugin.connect(voter).registerEntry(`c${i}`, "", usdc(100), 10, aws);
      }
      await fundDao(usdc(10_000));
      await time.increase(11 * DAY);

      await plugin.processDue(0, 2); // pays entries 0,1 only
      expect(await token.balanceOf(aws)).to.equal(usdc(200));
      await plugin.processDue(2, 2); // pays entries 2,3
      expect(await token.balanceOf(aws)).to.equal(usdc(400));
    });

    it("reverts PageSizeZero on limit 0 and no-ops past the end", async () => {
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      await expect(plugin.processDue(0, 0)).to.be.revertedWithCustomError(plugin, "PageSizeZero");
      await time.increase(11 * DAY);
      await fundDao(usdc(10_000));
      await plugin.processDue(99, 10); // offset past end → no-op, no revert
      expect(await token.balanceOf(aws)).to.equal(0);
    });
  });
});
