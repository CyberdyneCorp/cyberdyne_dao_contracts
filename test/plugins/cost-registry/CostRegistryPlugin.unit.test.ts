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
  FalseReturningERC20__factory,
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

  describe("initializeV2 (upgrade migration)", () => {
    // _maxEntries is storage slot 303 (see docs/storage-layouts/CostRegistryPlugin.md).
    const MAX_ENTRIES_SLOT = "0x12f"; // 303

    it("re-seeds the default cap when _maxEntries was zeroed (upgrade-from-constant)", async () => {
      await ethers.provider.send("hardhat_setStorageAt", [
        plugin.address,
        MAX_ENTRIES_SLOT,
        ethers.constants.HashZero,
      ]);
      expect(await plugin.MAX_ENTRIES()).to.equal(0);

      await plugin.initializeV2();
      expect(await plugin.MAX_ENTRIES()).to.equal(300);
    });

    it("is permissionless and idempotent (no-op when already set)", async () => {
      await plugin.connect(stranger).initializeV2();
      expect(await plugin.MAX_ENTRIES()).to.equal(300);
    });

    it("cannot run twice", async () => {
      await plugin.initializeV2();
      await expect(plugin.initializeV2()).to.be.revertedWith(
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

  describe("setMaxEntries", () => {
    it("defaults to 300 with a 1000 ceiling", async () => {
      expect(await plugin.MAX_ENTRIES()).to.equal(300);
      expect(await plugin.MAX_ENTRIES_CEILING()).to.equal(1000);
    });

    it("raises the cap and emits MaxEntriesUpdated", async () => {
      await expect(plugin.connect(voter).setMaxEntries(500))
        .to.emit(plugin, "MaxEntriesUpdated")
        .withArgs(300, 500);
      expect(await plugin.MAX_ENTRIES()).to.equal(500);
    });

    it("enforces the new cap on registerEntry (lower, fill, raise, add)", async () => {
      await plugin.connect(voter).setMaxEntries(2);
      await plugin.connect(voter).registerEntry("a", "", usdc(1), 1, aws);
      await plugin.connect(voter).registerEntry("b", "", usdc(1), 1, aws);
      await expect(plugin.connect(voter).registerEntry("c", "", usdc(1), 1, aws))
        .to.be.revertedWithCustomError(plugin, "EntryLimitExceeded")
        .withArgs(2);
      await plugin.connect(voter).setMaxEntries(3);
      await expect(plugin.connect(voter).registerEntry("c", "", usdc(1), 1, aws)).to.emit(
        plugin,
        "EntryRegistered"
      );
    });

    it("reverts above the ceiling", async () => {
      await expect(plugin.connect(voter).setMaxEntries(1001))
        .to.be.revertedWithCustomError(plugin, "MaxEntriesOutOfRange")
        .withArgs(1001, 0, 1000);
    });

    it("reverts below the current slot count", async () => {
      await plugin.connect(voter).registerEntry("a", "", usdc(1), 1, aws);
      await plugin.connect(voter).registerEntry("b", "", usdc(1), 1, aws);
      await expect(plugin.connect(voter).setMaxEntries(1))
        .to.be.revertedWithCustomError(plugin, "MaxEntriesOutOfRange")
        .withArgs(1, 2, 1000);
    });

    it("reverts when caller lacks MANAGE_COSTS", async () => {
      await expect(plugin.connect(stranger).setMaxEntries(400)).to.be.reverted;
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

    // H-03 regression: a transfer that fails must NOT advance any entry's clock
    // nor emit CostPaid. Pre-fix this "isolated" the failure via the allow-all
    // failure map and marked BOTH entries paid; now the whole batch reverts.
    it("H-03: an underfunded batch reverts entirely — nothing marked paid", async () => {
      await plugin.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      await plugin.connect(voter).registerEntry("OpenAI", "", usdc(500), 10, openai);
      await fundDao(usdc(500)); // covers only the first transfer
      await time.increase(11 * DAY);

      await expect(plugin.processDue(0, 50)).to.be.reverted;

      // No funds moved, both entries still due, no clocks advanced.
      expect(await token.balanceOf(aws)).to.equal(0);
      expect(await token.balanceOf(openai)).to.equal(0);
      expect(await plugin.isDue(0)).to.equal(true);
      expect(await plugin.isDue(1)).to.equal(true);

      // After the DAO is fully funded, the same crank settles everything.
      await fundDao(usdc(500));
      await expect(plugin.processDue(0, 50)).to.emit(plugin, "CostsProcessed").withArgs(0, 2, 0);
      expect(await token.balanceOf(aws)).to.equal(usdc(500));
      expect(await token.balanceOf(openai)).to.equal(usdc(500));
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

  // ---------------------------------------------------------------------------
  // External-audit remediation regressions (issue #3). Each test pins a finding
  // and fails if the vulnerable behavior is reintroduced.
  // ---------------------------------------------------------------------------
  describe("external audit regressions", () => {
    async function fundDao(amount: BigNumber): Promise<void> {
      await token.mint(dao.address, amount);
    }

    it("deploys a SafeERC20 transfer helper at install", async () => {
      const helper = await plugin.transferHelper();
      expect(helper).to.not.equal(ethers.constants.AddressZero);
    });

    it("CR-M-01/M-06: a false-returning token reverts the batch, nothing paid", async () => {
      // Stand up a fresh registry whose payment token returns false on transfer.
      const falseToken = await new FalseReturningERC20__factory(deployer).deploy(6);
      await falseToken.deployed();
      const p = await deployProxied(deployer, dao.address, falseToken.address);
      await dao.grant(p.address, await voter.getAddress(), MANAGE_COSTS_PERMISSION_ID);
      await dao.grant(dao.address, p.address, EXECUTE_PERMISSION_ID);

      await p.connect(voter).registerEntry("AWS", "", usdc(500), 10, aws);
      await falseToken.mint(dao.address, usdc(10_000));
      await time.increase(11 * DAY);

      // SafeERC20 rejects the false return → batch reverts → entry still due.
      await expect(p.processDue(0, 50)).to.be.reverted;
      expect(await p.isDue(0)).to.equal(true);
    });

    it("CR-M-02/M-07: setPaymentToken rejects a token with different decimals", async () => {
      const token18 = await new TestERC20__factory(deployer).deploy("DAI", "DAI", 18);
      await token18.deployed();
      await dao.grant(plugin.address, await voter.getAddress(), UPDATE_PAYMENT_TOKEN_PERMISSION_ID);

      await expect(plugin.connect(voter).setPaymentToken(token18.address))
        .to.be.revertedWithCustomError(plugin, "PaymentTokenDecimalsMismatch")
        .withArgs(6, 18);

      // A same-decimals migration is still allowed.
      const usdc2 = await new TestERC20__factory(deployer).deploy("USD2", "USD2", 6);
      await usdc2.deployed();
      await expect(plugin.connect(voter).setPaymentToken(usdc2.address)).to.emit(
        plugin,
        "PaymentTokenUpdated"
      );
    });

    it("CR-L-02/L-05: processAllDue reverts when the registry exceeds one page", async () => {
      await plugin.connect(voter).setMaxEntries(1000);
      // 101 slots > MAX_PER_PAGE(100): a single page cannot cover everything.
      for (let i = 0; i < 101; i++) {
        await plugin.connect(voter).registerEntry(`c${i}`, "", usdc(1), 10, aws);
      }
      await expect(plugin.processAllDue()).to.be.revertedWithCustomError(
        plugin,
        "RegistryExceedsSinglePage"
      );
      // Paginated processing still works.
      await fundDao(usdc(10_000));
      await time.increase(11 * DAY);
      await plugin.processDue(0, 100);
      await plugin.processDue(100, 100);
      expect(await token.balanceOf(aws)).to.equal(usdc(101));
    });

    it("CR-L-03/L-06: processDueFromCursor round-robins across pages", async () => {
      await plugin.connect(voter).setMaxEntries(1000);
      for (let i = 0; i < 150; i++) {
        await plugin.connect(voter).registerEntry(`c${i}`, "", usdc(1), 10, aws);
      }
      await fundDao(usdc(10_000));
      await time.increase(11 * DAY);

      expect(await plugin.dueCursor()).to.equal(0);
      await plugin.processDueFromCursor(100); // entries [0,100)
      expect(await plugin.dueCursor()).to.equal(100);
      expect(await token.balanceOf(aws)).to.equal(usdc(100));

      await plugin.processDueFromCursor(100); // entries [100,150) then wraps
      expect(await plugin.dueCursor()).to.equal(0); // wrapped past the end
      expect(await token.balanceOf(aws)).to.equal(usdc(150)); // all 150 covered

      await expect(plugin.processDueFromCursor(0)).to.be.revertedWithCustomError(
        plugin,
        "PageSizeZero"
      );
    });

    it("CR-I-01: initializeV3 is permissionless but idempotent (no-op when set)", async () => {
      // Helper is already set by initialize. A stranger may call the migration,
      // but it cannot change the already-set helper and cannot run twice.
      const helper = await plugin.transferHelper();
      await plugin.connect(stranger).initializeV3(); // succeeds, no-op
      expect(await plugin.transferHelper()).to.equal(helper);
      await expect(plugin.connect(stranger).initializeV3()).to.be.reverted; // v3 consumed
    });

    it("CR-I-02: duplicate (payee, name) entries are intentionally allowed", async () => {
      await plugin.connect(voter).registerEntry("AWS", "acct-1", usdc(100), 10, aws);
      await plugin.connect(voter).registerEntry("AWS", "acct-2", usdc(200), 10, aws);
      expect(await plugin.entryCount()).to.equal(2);
      const e0 = await plugin.getEntry(0);
      const e1 = await plugin.getEntry(1);
      expect(e0.payee).to.equal(aws);
      expect(e1.payee).to.equal(aws);
      expect(e0.costUsdc).to.not.equal(e1.costUsdc);
    });
  });
});
