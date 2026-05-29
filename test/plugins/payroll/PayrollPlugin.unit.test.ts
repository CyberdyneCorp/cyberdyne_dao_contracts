import {expect} from "chai";
import {ethers} from "hardhat";
import type {BigNumber, ContractTransaction, Signer} from "ethers";
import {
  MinimalDAO,
  MinimalDAO__factory,
  PayrollPlugin,
  PayrollPlugin__factory,
  RevertingRecipient__factory,
  TestERC20,
  TestERC20__factory,
} from "../../../typechain-types";
import {takeSnapshot, time, utcTimestamp} from "../../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

const MANAGE_PAYROLL_PERMISSION_ID = ethers.utils.id("MANAGE_PAYROLL_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");

const PAY_DAY = 15;
const SECONDS_PER_DAY = 86_400;

async function deployProxied(signer: Signer, dao: string, payDay: number): Promise<PayrollPlugin> {
  const impl = await new PayrollPlugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [dao, payDay]);
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await ProxyFactory.deploy(impl.address, initData);
  await proxy.deployed();
  return PayrollPlugin__factory.connect(proxy.address, signer);
}

async function fundDaoEth(dao: MinimalDAO, eth: BigNumber): Promise<void> {
  await ethers.provider.send("hardhat_setBalance", [dao.address, ethers.utils.hexValue(eth)]);
}

// Computes a unix timestamp landing on a specific day of a specific month at 12:00 UTC.
function payDayTs(year: number, month: number, day = PAY_DAY): number {
  return utcTimestamp(year, month, day, 12);
}

// Extracts a single `PayrollExecuted` event from a tx receipt.
async function readPayrollExecuted(
  tx: ContractTransaction
): Promise<{period: BigNumber; recipientCount: BigNumber; failureMap: BigNumber}> {
  const receipt = await tx.wait();
  const iface = new ethers.utils.Interface([
    "event PayrollExecuted(uint256 indexed period, uint256 recipientCount, uint256 failureMap)",
  ]);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === "PayrollExecuted") {
        return {
          period: parsed.args.period,
          recipientCount: parsed.args.recipientCount,
          failureMap: parsed.args.failureMap,
        };
      }
    } catch {
      /* not our event */
    }
  }
  throw new Error("PayrollExecuted not emitted");
}

describe("PayrollPlugin", () => {
  let deployer: Signer;
  let voter: Signer; // stands in for the DAO-authorized governance caller
  let alice: Signer;
  let bob: Signer;
  let stranger: Signer;
  let dao: MinimalDAO;
  let plugin: PayrollPlugin;
  let token: TestERC20;
  let snapshot: SnapshotRestorer;

  // Each test gets a fresh chain state so block.timestamp resets — important
  // for the calendar-math tests that jump to different (year, month, day).
  afterEach(async () => {
    if (snapshot) await snapshot.restore();
  });

  beforeEach(async () => {
    [deployer, voter, alice, bob, stranger] = await ethers.getSigners();

    dao = await new MinimalDAO__factory(deployer).deploy();
    await dao.deployed();

    plugin = await deployProxied(deployer, dao.address, PAY_DAY);

    // Vote-gated admin = `voter` (proxies for "calls coming via DAO.execute").
    await dao.grant(plugin.address, await voter.getAddress(), MANAGE_PAYROLL_PERMISSION_ID);
    // Plugin needs EXECUTE on the DAO to run its monthly crank.
    await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);

    // Default ERC20 used by ERC20-payment tests.
    token = await new TestERC20__factory(deployer).deploy("Test USDC", "tUSDC", 6);
    await token.deployed();

    snapshot = await takeSnapshot();
  });

  describe("initialize", () => {
    it("sets payDayOfMonth and disables initializer on the impl", async () => {
      expect(await plugin.payDayOfMonth()).to.equal(PAY_DAY);
      expect(await plugin.lastPayoutPeriod()).to.equal(0);
      expect(await plugin.MAX_RECIPIENTS()).to.equal(300);
      expect(await plugin.MAX_RECIPIENTS_PER_PAGE()).to.equal(100);
      expect(await plugin.cursorPeriod()).to.equal(0);
      expect(await plugin.payoutCursor()).to.equal(0);
    });

    it("rejects payDayOfMonth = 0 or > 28", async () => {
      const impl = await new PayrollPlugin__factory(deployer).deploy();
      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);

      for (const bad of [0, 29, 31, 100]) {
        const initData = impl.interface.encodeFunctionData("initialize", [dao.address, bad]);
        await expect(ProxyFactory.deploy(impl.address, initData))
          .to.be.revertedWithCustomError(plugin, "InvalidPayDayOfMonth")
          .withArgs(bad);
      }
    });

    it("cannot be initialized twice", async () => {
      await expect(plugin.initialize(dao.address, 10)).to.be.revertedWith(
        "Initializable: contract is already initialized"
      );
    });
  });

  describe("initializeV2 (upgrade migration)", () => {
    // _maxRecipients is storage slot 312 (see docs/storage-layouts/PayrollPlugin.md).
    const MAX_RECIPIENTS_SLOT = "0x138"; // 312

    it("re-seeds the default cap when _maxRecipients was zeroed (upgrade-from-constant)", async () => {
      // Simulate an instance upgraded from a build where MAX_RECIPIENTS was a
      // `constant`: the new storage slot reads 0, which would brick addRecipient.
      await ethers.provider.send("hardhat_setStorageAt", [
        plugin.address,
        MAX_RECIPIENTS_SLOT,
        ethers.constants.HashZero,
      ]);
      expect(await plugin.MAX_RECIPIENTS()).to.equal(0);

      await plugin.initializeV2();
      expect(await plugin.MAX_RECIPIENTS()).to.equal(300);
    });

    it("is permissionless and idempotent (no-op when already set)", async () => {
      await plugin.connect(stranger).initializeV2();
      expect(await plugin.MAX_RECIPIENTS()).to.equal(300);
    });

    it("cannot run twice", async () => {
      await plugin.initializeV2();
      await expect(plugin.initializeV2()).to.be.revertedWith(
        "Initializable: contract is already initialized"
      );
    });
  });

  describe("setPayDayOfMonth", () => {
    it("updates and emits PayDayUpdated when caller has MANAGE_PAYROLL", async () => {
      await expect(plugin.connect(voter).setPayDayOfMonth(20))
        .to.emit(plugin, "PayDayUpdated")
        .withArgs(PAY_DAY, 20);
      expect(await plugin.payDayOfMonth()).to.equal(20);
    });

    it("reverts on day 0 or > 28", async () => {
      for (const bad of [0, 29, 99]) {
        await expect(plugin.connect(voter).setPayDayOfMonth(bad))
          .to.be.revertedWithCustomError(plugin, "InvalidPayDayOfMonth")
          .withArgs(bad);
      }
    });

    it("reverts when caller lacks MANAGE_PAYROLL", async () => {
      await expect(plugin.connect(stranger).setPayDayOfMonth(20)).to.be.reverted;
    });
  });

  describe("setMaxRecipients", () => {
    it("defaults to 300 with a 1000 ceiling", async () => {
      expect(await plugin.MAX_RECIPIENTS()).to.equal(300);
      expect(await plugin.MAX_RECIPIENTS_CEILING()).to.equal(1000);
    });

    it("raises the cap and emits MaxRecipientsUpdated", async () => {
      await expect(plugin.connect(voter).setMaxRecipients(500))
        .to.emit(plugin, "MaxRecipientsUpdated")
        .withArgs(300, 500);
      expect(await plugin.MAX_RECIPIENTS()).to.equal(500);
    });

    it("enforces the new cap on addRecipient (lower, fill, raise, add)", async () => {
      const a = (i: number) =>
        ethers.utils.getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`);
      // Lower to 2 (no slots yet), fill it, then the 3rd add trips the cap.
      await plugin.connect(voter).setMaxRecipients(2);
      await plugin.connect(voter).addRecipient(a(0, ""), token.address, 100, "");
      await plugin.connect(voter).addRecipient(a(1, ""), token.address, 100, "");
      await expect(plugin.connect(voter).addRecipient(a(2, ""), token.address, 100, ""))
        .to.be.revertedWithCustomError(plugin, "RecipientLimitExceeded")
        .withArgs(2);
      // Raise to 3 and the previously-blocked add now succeeds.
      await plugin.connect(voter).setMaxRecipients(3);
      await expect(plugin.connect(voter).addRecipient(a(2, ""), token.address, 100, "")).to.emit(
        plugin,
        "RecipientAdded"
      );
    });

    it("reverts above the ceiling", async () => {
      await expect(plugin.connect(voter).setMaxRecipients(1001))
        .to.be.revertedWithCustomError(plugin, "MaxRecipientsOutOfRange")
        .withArgs(1001, 0, 1000);
    });

    it("reverts below the current slot count", async () => {
      const a = (i: number) =>
        ethers.utils.getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`);
      await plugin.connect(voter).addRecipient(a(0, ""), token.address, 100, "");
      await plugin.connect(voter).addRecipient(a(1, ""), token.address, 100, "");
      await expect(plugin.connect(voter).setMaxRecipients(1))
        .to.be.revertedWithCustomError(plugin, "MaxRecipientsOutOfRange")
        .withArgs(1, 2, 1000);
    });

    it("reverts when caller lacks MANAGE_PAYROLL", async () => {
      await expect(plugin.connect(stranger).setMaxRecipients(400)).to.be.reverted;
    });
  });

  describe("addRecipient", () => {
    it("adds and emits RecipientAdded (incl. description)", async () => {
      const addr = await alice.getAddress();
      await expect(
        plugin.connect(voter).addRecipient(addr, token.address, 1000, "Senior dev monthly salary")
      )
        .to.emit(plugin, "RecipientAdded")
        .withArgs(addr, token.address, 1000, "Senior dev monthly salary");
      expect(await plugin.recipientCount()).to.equal(1);
      expect(await plugin.indexOfPayee(addr)).to.equal(1);
      const stored = await plugin.getRecipientAt(0);
      expect(stored.description).to.equal("Senior dev monthly salary");

      const r = await plugin.getRecipientAt(0);
      expect(r.payee).to.equal(addr);
      expect(r.token).to.equal(token.address);
      expect(r.amount).to.equal(1000);
      expect(r.active).to.equal(true);
    });

    it("rejects duplicate payee", async () => {
      const addr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(addr, token.address, 1000, "");
      await expect(plugin.connect(voter).addRecipient(addr, token.address, 5000, ""))
        .to.be.revertedWithCustomError(plugin, "RecipientAlreadyExists")
        .withArgs(addr);
    });

    it("rejects zero payee or zero amount", async () => {
      await expect(
        plugin.connect(voter).addRecipient(ethers.constants.AddressZero, token.address, 100, "")
      ).to.be.revertedWithCustomError(plugin, "ZeroAddress");
      await expect(
        plugin.connect(voter).addRecipient(await alice.getAddress(), token.address, 0, "")
      ).to.be.revertedWithCustomError(plugin, "ZeroAmount");
    });

    it("reverts when MAX_RECIPIENTS reached", async () => {
      // Fill to the cap. Done in a loop deliberately to test the boundary.
      // This is slow; we cap loops elsewhere.
      const cap = (await plugin.MAX_RECIPIENTS()).toNumber();
      for (let i = 0; i < cap; i++) {
        await plugin
          .connect(voter)
          .addRecipient(
            ethers.utils.getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
            token.address,
            100,
            ""
          );
      }
      const oneMore = ethers.utils.getAddress(`0x${(cap + 1).toString(16).padStart(40, "0")}`);
      await expect(plugin.connect(voter).addRecipient(oneMore, token.address, 100, ""))
        .to.be.revertedWithCustomError(plugin, "RecipientLimitExceeded")
        .withArgs(cap);
    }).timeout(180_000);

    it("reverts when caller lacks MANAGE_PAYROLL", async () => {
      await expect(
        plugin.connect(stranger).addRecipient(await alice.getAddress(), token.address, 100, "")
      ).to.be.reverted;
    });
  });

  describe("removeRecipient (soft delete)", () => {
    it("flips active=false but keeps the slot for history", async () => {
      const addr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(addr, token.address, 1000, "");
      await expect(plugin.connect(voter).removeRecipient(addr))
        .to.emit(plugin, "RecipientRemoved")
        .withArgs(addr);

      expect(await plugin.recipientCount()).to.equal(1); // slot preserved
      const r = await plugin.getRecipientAt(0);
      expect(r.active).to.equal(false);
      expect(r.amount).to.equal(1000);

      const active = await plugin.allActiveRecipients();
      expect(active.length).to.equal(0);
    });

    it("reverts on unknown payee or already-removed", async () => {
      await expect(
        plugin.connect(voter).removeRecipient(await alice.getAddress())
      ).to.be.revertedWithCustomError(plugin, "RecipientNotFound");

      await plugin.connect(voter).addRecipient(await alice.getAddress(), token.address, 1, "");
      await plugin.connect(voter).removeRecipient(await alice.getAddress());
      await expect(
        plugin.connect(voter).removeRecipient(await alice.getAddress())
      ).to.be.revertedWithCustomError(plugin, "RecipientNotFound");
    });

    it("reverts when caller lacks MANAGE_PAYROLL", async () => {
      await plugin.connect(voter).addRecipient(await alice.getAddress(), token.address, 1, "");
      await expect(plugin.connect(stranger).removeRecipient(await alice.getAddress())).to.be
        .reverted;
    });
  });

  describe("setAmount", () => {
    it("updates amount and emits", async () => {
      const addr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(addr, token.address, 1000, "");
      await expect(plugin.connect(voter).setAmount(addr, 2500))
        .to.emit(plugin, "RecipientAmountUpdated")
        .withArgs(addr, 1000, 2500);
      expect((await plugin.getRecipientAt(0)).amount).to.equal(2500);
    });

    it("rejects zero amount", async () => {
      const addr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(addr, token.address, 1000, "");
      await expect(plugin.connect(voter).setAmount(addr, 0)).to.be.revertedWithCustomError(
        plugin,
        "ZeroAmount"
      );
    });

    it("rejects unknown or soft-deleted payee", async () => {
      await expect(
        plugin.connect(voter).setAmount(await alice.getAddress(), 100)
      ).to.be.revertedWithCustomError(plugin, "RecipientNotFound");

      await plugin.connect(voter).addRecipient(await alice.getAddress(), token.address, 1, "");
      await plugin.connect(voter).removeRecipient(await alice.getAddress());
      await expect(
        plugin.connect(voter).setAmount(await alice.getAddress(), 50)
      ).to.be.revertedWithCustomError(plugin, "RecipientNotFound");
    });
  });

  describe("setRecipientDescription", () => {
    it("updates description and emits RecipientDescriptionSet with old + new", async () => {
      const addr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(addr, token.address, 100, "old label");
      await expect(plugin.connect(voter).setRecipientDescription(addr, "Senior dev monthly salary"))
        .to.emit(plugin, "RecipientDescriptionSet")
        .withArgs(addr, "old label", "Senior dev monthly salary");
      const r = await plugin.getRecipientAt(0);
      expect(r.description).to.equal("Senior dev monthly salary");
    });

    it("accepts the empty string (clearing the label)", async () => {
      const addr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(addr, token.address, 100, "Senior dev");
      await plugin.connect(voter).setRecipientDescription(addr, "");
      expect((await plugin.getRecipientAt(0)).description).to.equal("");
    });

    it("reverts RecipientNotFound for an unknown payee", async () => {
      await expect(
        plugin.connect(voter).setRecipientDescription(await alice.getAddress(), "nope")
      ).to.be.revertedWithCustomError(plugin, "RecipientNotFound");
    });

    it("still works on a soft-deleted recipient (lets the DAO correct history)", async () => {
      const addr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(addr, token.address, 100, "before");
      await plugin.connect(voter).removeRecipient(addr);
      await expect(plugin.connect(voter).setRecipientDescription(addr, "after"))
        .to.emit(plugin, "RecipientDescriptionSet")
        .withArgs(addr, "before", "after");
      expect((await plugin.getRecipientAt(0)).description).to.equal("after");
    });

    it("gated on MANAGE_PAYROLL", async () => {
      const addr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(addr, token.address, 100, "");
      await expect(plugin.connect(stranger).setRecipientDescription(addr, "nope")).to.be.reverted;
    });
  });

  describe("allActiveRecipients", () => {
    it("returns only active entries in storage order", async () => {
      const a = await alice.getAddress();
      const b = await bob.getAddress();
      const c = await stranger.getAddress();
      await plugin.connect(voter).addRecipient(a, token.address, 100, "");
      await plugin.connect(voter).addRecipient(b, token.address, 200, "");
      await plugin.connect(voter).addRecipient(c, token.address, 300, "");
      await plugin.connect(voter).removeRecipient(b);

      const active = await plugin.allActiveRecipients();
      expect(active.length).to.equal(2);
      expect(active[0].payee).to.equal(a);
      expect(active[1].payee).to.equal(c);
    });
  });

  describe("executePayroll: revert paths", () => {
    it("reverts NotYetDueThisMonth when called before payDayOfMonth", async () => {
      await plugin.connect(voter).addRecipient(await alice.getAddress(), token.address, 100, "");
      await token.mint(dao.address, ethers.utils.parseUnits("1000", 6));

      // Day 10 of some month — before pay day 15.
      await time.setNextBlockTimestamp(utcTimestamp(2027, 1, 10, 12));
      await expect(plugin.executePayroll())
        .to.be.revertedWithCustomError(plugin, "NotYetDueThisMonth")
        .withArgs(10, PAY_DAY);
    });

    it("reverts AlreadyPaidThisPeriod on the second crank within a month", async () => {
      await plugin.connect(voter).addRecipient(await alice.getAddress(), token.address, 100, "");
      await token.mint(dao.address, ethers.utils.parseUnits("1000", 6));

      await time.setNextBlockTimestamp(payDayTs(2027, 1));
      await plugin.executePayroll();

      // Same month, day after pay day.
      await time.setNextBlockTimestamp(payDayTs(2027, 1, 20));
      await expect(plugin.executePayroll()).to.be.revertedWithCustomError(
        plugin,
        "AlreadyPaidThisPeriod"
      );
    });

    it("reverts NoActiveRecipients when all are soft-deleted", async () => {
      await plugin.connect(voter).addRecipient(await alice.getAddress(), token.address, 100, "");
      await plugin.connect(voter).removeRecipient(await alice.getAddress());

      await time.setNextBlockTimestamp(payDayTs(2027, 1));
      await expect(plugin.executePayroll()).to.be.revertedWithCustomError(
        plugin,
        "NoActiveRecipients"
      );
    });
  });

  describe("executePayroll: happy paths", () => {
    it("pays a single ERC20 recipient and locks the period", async () => {
      const aAddr = await alice.getAddress();
      await plugin
        .connect(voter)
        .addRecipient(aAddr, token.address, ethers.utils.parseUnits("500", 6), "");
      await token.mint(dao.address, ethers.utils.parseUnits("10000", 6));

      await time.setNextBlockTimestamp(payDayTs(2027, 3));
      const tx = await plugin.executePayroll();
      const evt = await readPayrollExecuted(tx);

      expect(evt.period).to.equal(2027 * 12 + 3);
      expect(evt.recipientCount).to.equal(1);
      expect(evt.failureMap).to.equal(0);
      expect(await token.balanceOf(aAddr)).to.equal(ethers.utils.parseUnits("500", 6));
      expect(await plugin.lastPayoutPeriod()).to.equal(2027 * 12 + 3);
    });

    it("pays mixed ETH + ERC20 recipients in one crank", async () => {
      const aAddr = await alice.getAddress();
      const bAddr = await bob.getAddress();
      const ethAmt = ethers.utils.parseEther("1");
      const tokAmt = ethers.utils.parseUnits("250", 6);

      await plugin.connect(voter).addRecipient(aAddr, ethers.constants.AddressZero, ethAmt, "");
      await plugin.connect(voter).addRecipient(bAddr, token.address, tokAmt, "");

      await fundDaoEth(dao, ethers.utils.parseEther("100"));
      await token.mint(dao.address, ethers.utils.parseUnits("10000", 6));

      const aBefore = await ethers.provider.getBalance(aAddr);

      await time.setNextBlockTimestamp(payDayTs(2027, 4));
      const tx = await plugin.executePayroll();
      const evt = await readPayrollExecuted(tx);

      expect(evt.failureMap).to.equal(0);
      expect(evt.recipientCount).to.equal(2);
      expect(await ethers.provider.getBalance(aAddr)).to.equal(aBefore.add(ethAmt));
      expect(await token.balanceOf(bAddr)).to.equal(tokAmt);
    });

    it("skips missed months — no back-pay", async () => {
      const aAddr = await alice.getAddress();
      const monthly = ethers.utils.parseUnits("100", 6);
      await plugin.connect(voter).addRecipient(aAddr, token.address, monthly, "");
      await token.mint(dao.address, ethers.utils.parseUnits("10000", 6));

      // Month 1 (Jan 2028) — pay.
      await time.setNextBlockTimestamp(payDayTs(2028, 1));
      await plugin.executePayroll();
      expect(await token.balanceOf(aAddr)).to.equal(monthly);

      // Month 2 — nobody calls the crank. Skipped permanently.

      // Month 3 (Mar 2028) — crank pays only March (NOT Feb).
      await time.setNextBlockTimestamp(payDayTs(2028, 3));
      const tx = await plugin.executePayroll();
      const evt = await readPayrollExecuted(tx);
      expect(evt.period).to.equal(2028 * 12 + 3);
      expect(await token.balanceOf(aAddr)).to.equal(monthly.mul(2)); // 1 + 1, not 1 + 2
    });

    it("allows anyone to call the crank (permissionless)", async () => {
      await plugin.connect(voter).addRecipient(await alice.getAddress(), token.address, 100, "");
      await token.mint(dao.address, 10_000);

      await time.setNextBlockTimestamp(payDayTs(2027, 5));
      // `stranger` has no DAO permissions whatsoever.
      await expect(plugin.connect(stranger).executePayroll()).to.emit(plugin, "PayrollExecuted");
    });
  });

  describe("executePayrollPage: pagination", () => {
    // Adds `n` ERC20 recipients with deterministic addresses (0x..01, 0x..02, …).
    async function addManyRecipients(n: number, amount = 100): Promise<string[]> {
      const addrs: string[] = [];
      for (let i = 0; i < n; i++) {
        const addr = ethers.utils.getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`);
        await plugin.connect(voter).addRecipient(addr, token.address, amount, "");
        addrs.push(addr);
      }
      return addrs;
    }

    it("pays across pages and locks the period only on the final page", async () => {
      const addrs = await addManyRecipients(3, 100);
      await token.mint(dao.address, 1_000_000);

      await time.setNextBlockTimestamp(payDayTs(2027, 7));
      const period = 2027 * 12 + 7;

      // Page 1 — pay 2 of 3. Period NOT yet locked.
      const tx1 = await plugin.executePayrollPage(2);
      const e1 = await readPayrollExecuted(tx1);
      expect(e1.period).to.equal(period);
      expect(e1.recipientCount).to.equal(2);
      expect(await plugin.lastPayoutPeriod()).to.equal(0);
      expect(await plugin.cursorPeriod()).to.equal(period);
      expect(await plugin.payoutCursor()).to.equal(2);
      expect(await token.balanceOf(addrs[0])).to.equal(100);
      expect(await token.balanceOf(addrs[1])).to.equal(100);
      expect(await token.balanceOf(addrs[2])).to.equal(0);

      // Page 2 — pay the last one. Period locks + completion event fires.
      const tx2 = await plugin.executePayrollPage(2);
      const e2 = await readPayrollExecuted(tx2);
      expect(e2.recipientCount).to.equal(1);
      await expect(tx2).to.emit(plugin, "PayrollPeriodCompleted").withArgs(period);
      expect(await plugin.lastPayoutPeriod()).to.equal(period);
      expect(await plugin.payoutCursor()).to.equal(0);
      expect(await token.balanceOf(addrs[2])).to.equal(100);
    });

    it("reverts AlreadyPaidThisPeriod once the period is complete", async () => {
      await addManyRecipients(2, 50);
      await token.mint(dao.address, 1_000_000);

      await time.setNextBlockTimestamp(payDayTs(2027, 8));
      await plugin.executePayrollPage(10); // pays both, completes
      expect(await plugin.lastPayoutPeriod()).to.equal(2027 * 12 + 8);

      await time.setNextBlockTimestamp(payDayTs(2027, 8, 20));
      await expect(plugin.executePayrollPage(10)).to.be.revertedWithCustomError(
        plugin,
        "AlreadyPaidThisPeriod"
      );
    });

    it("resets the cursor across periods", async () => {
      const addrs = await addManyRecipients(3, 100);
      await token.mint(dao.address, 10_000_000);

      // Period 1 — paginate to completion.
      await time.setNextBlockTimestamp(payDayTs(2028, 1));
      await plugin.executePayrollPage(2);
      await plugin.executePayrollPage(2);
      expect(await plugin.lastPayoutPeriod()).to.equal(2028 * 12 + 1);

      // Period 2 — cursor starts fresh from the top.
      await time.setNextBlockTimestamp(payDayTs(2028, 2));
      const tx = await plugin.executePayrollPage(2);
      expect((await readPayrollExecuted(tx)).recipientCount).to.equal(2);
      expect(await plugin.payoutCursor()).to.equal(2);
      // Each recipient paid twice total (once per period).
      await plugin.executePayrollPage(2);
      for (const a of addrs) expect(await token.balanceOf(a)).to.equal(200);
    });

    it("completes a period whose tail is all soft-deleted", async () => {
      const addrs = await addManyRecipients(3, 100);
      await token.mint(dao.address, 1_000_000);
      // Remove the last two — only recipient 0 is active.
      await plugin.connect(voter).removeRecipient(addrs[1]);
      await plugin.connect(voter).removeRecipient(addrs[2]);

      await time.setNextBlockTimestamp(payDayTs(2028, 3));
      const period = 2028 * 12 + 3;

      // Page size 1: page 1 pays recipient 0 and stops at cursor 1 (not end).
      const tx1 = await plugin.executePayrollPage(1);
      expect((await readPayrollExecuted(tx1)).recipientCount).to.equal(1);
      expect(await plugin.lastPayoutPeriod()).to.equal(0);
      expect(await plugin.payoutCursor()).to.equal(1);

      // Page 2: scans the inactive tail, finds nothing, completes with no batch.
      const tx2 = await plugin.executePayrollPage(1);
      await expect(tx2).to.emit(plugin, "PayrollPeriodCompleted").withArgs(period);
      await expect(tx2).to.not.emit(plugin, "PayrollExecuted");
      expect(await plugin.lastPayoutPeriod()).to.equal(period);
      expect(await token.balanceOf(addrs[0])).to.equal(100);
    });

    it("skips recipients removed mid-period before they are paid", async () => {
      const addrs = await addManyRecipients(3, 100);
      await token.mint(dao.address, 1_000_000);

      await time.setNextBlockTimestamp(payDayTs(2028, 4));
      await plugin.executePayrollPage(1); // pays addrs[0], cursor=1

      // Remove addrs[1] before it is reached.
      await plugin.connect(voter).removeRecipient(addrs[1]);

      await plugin.executePayrollPage(10); // pays only addrs[2], completes
      expect(await plugin.lastPayoutPeriod()).to.equal(2028 * 12 + 4);
      expect(await token.balanceOf(addrs[0])).to.equal(100);
      expect(await token.balanceOf(addrs[1])).to.equal(0); // removed, never paid
      expect(await token.balanceOf(addrs[2])).to.equal(100);
    });

    it("isolates a reverting recipient within a page", async () => {
      const good = await alice.getAddress();
      const reverting = await new RevertingRecipient__factory(deployer).deploy();
      await reverting.deployed();
      await plugin
        .connect(voter)
        .addRecipient(
          reverting.address,
          ethers.constants.AddressZero,
          ethers.utils.parseEther("1"),
          ""
        );
      await plugin
        .connect(voter)
        .addRecipient(good, ethers.constants.AddressZero, ethers.utils.parseEther("2"), "");
      await fundDaoEth(dao, ethers.utils.parseEther("100"));

      const before = await ethers.provider.getBalance(good);
      await time.setNextBlockTimestamp(payDayTs(2028, 5));
      const tx = await plugin.executePayrollPage(10);
      const evt = await readPayrollExecuted(tx);

      expect(evt.failureMap).to.equal(1); // bit 0 = reverting recipient
      expect(evt.recipientCount).to.equal(2);
      expect(await ethers.provider.getBalance(good)).to.equal(
        before.add(ethers.utils.parseEther("2"))
      );
      expect(await plugin.lastPayoutPeriod()).to.equal(2028 * 12 + 5);
    });

    it("reverts PageSizeZero on executePayrollPage(0)", async () => {
      await addManyRecipients(1);
      await time.setNextBlockTimestamp(payDayTs(2028, 6));
      await expect(plugin.executePayrollPage(0)).to.be.revertedWithCustomError(
        plugin,
        "PageSizeZero"
      );
    });

    it("respects timing guards (NotYetDueThisMonth / NoActiveRecipients)", async () => {
      await time.setNextBlockTimestamp(utcTimestamp(2028, 7, 10, 12)); // before pay day
      await addManyRecipients(1);
      await expect(plugin.executePayrollPage(5))
        .to.be.revertedWithCustomError(plugin, "NotYetDueThisMonth")
        .withArgs(10, PAY_DAY);

      // Remove the only recipient, jump to pay day → empty payroll.
      const addr = ethers.utils.getAddress(`0x${(1).toString(16).padStart(40, "0")}`);
      await plugin.connect(voter).removeRecipient(addr);
      await time.setNextBlockTimestamp(payDayTs(2028, 7));
      await expect(plugin.executePayrollPage(5)).to.be.revertedWithCustomError(
        plugin,
        "NoActiveRecipients"
      );
    });
  });

  describe("executePayroll: single-pass guard", () => {
    it("reverts PayrollExceedsSinglePage when active set exceeds one page", async () => {
      // One more than a full page of active recipients.
      const perPage = (await plugin.MAX_RECIPIENTS_PER_PAGE()).toNumber();
      for (let i = 0; i < perPage + 1; i++) {
        await plugin
          .connect(voter)
          .addRecipient(
            ethers.utils.getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
            token.address,
            10,
            ""
          );
      }
      await token.mint(dao.address, 10_000_000);

      await time.setNextBlockTimestamp(payDayTs(2029, 1));
      await expect(plugin.executePayroll())
        .to.be.revertedWithCustomError(plugin, "PayrollExceedsSinglePage")
        .withArgs(perPage);

      // The paginated crank handles it: page 1 (100) then page 2 (1) completes.
      const tx1 = await plugin.executePayrollPage(perPage);
      expect((await readPayrollExecuted(tx1)).recipientCount).to.equal(perPage);
      expect(await plugin.lastPayoutPeriod()).to.equal(0);
      const tx2 = await plugin.executePayrollPage(perPage);
      expect((await readPayrollExecuted(tx2)).recipientCount).to.equal(1);
      expect(await plugin.lastPayoutPeriod()).to.equal(2029 * 12 + 1);
    }).timeout(120_000);
  });

  describe("executePayroll: per-recipient failure tolerance", () => {
    it("pays the good recipients and surfaces the bad ones via failureMap", async () => {
      const goodAddr = await alice.getAddress();
      const reverting = await new RevertingRecipient__factory(deployer).deploy();
      await reverting.deployed();

      // Recipient 0 = ETH to a reverting contract (this one fails).
      // Recipient 1 = ETH to alice (this one succeeds).
      await plugin
        .connect(voter)
        .addRecipient(
          reverting.address,
          ethers.constants.AddressZero,
          ethers.utils.parseEther("1"),
          ""
        );
      await plugin
        .connect(voter)
        .addRecipient(goodAddr, ethers.constants.AddressZero, ethers.utils.parseEther("2"), "");

      await fundDaoEth(dao, ethers.utils.parseEther("100"));

      const aliceBefore = await ethers.provider.getBalance(goodAddr);

      await time.setNextBlockTimestamp(payDayTs(2027, 6));
      const tx = await plugin.executePayroll();
      const evt = await readPayrollExecuted(tx);

      // Bit 0 = recipient 0 failed.
      expect(evt.failureMap).to.equal(1);
      expect(evt.recipientCount).to.equal(2);
      // Good recipient still received their pay.
      expect(await ethers.provider.getBalance(goodAddr)).to.equal(
        aliceBefore.add(ethers.utils.parseEther("2"))
      );
      // Reverting contract received nothing.
      expect(await ethers.provider.getBalance(reverting.address)).to.equal(0);
      // Period still locked.
      expect(await plugin.lastPayoutPeriod()).to.equal(2027 * 12 + 6);
    });
  });

  describe("keeper bounty", () => {
    const UPDATE_BOUNTY_PERMISSION_ID = ethers.utils.id("UPDATE_BOUNTY_PERMISSION");

    async function grantBountyPermissionAndConfigure(
      token: string,
      perCrank: ethers.BigNumberish,
      maxPerPeriod: ethers.BigNumberish
    ): Promise<void> {
      await dao.grant(plugin.address, await voter.getAddress(), UPDATE_BOUNTY_PERMISSION_ID);
      await plugin.connect(voter).setKeeperBounty(token, perCrank, maxPerPeriod);
    }

    it("setKeeperBounty: emits + stores + requires UPDATE_BOUNTY_PERMISSION", async () => {
      // Unauthorized → revert.
      await expect(
        plugin.connect(stranger).setKeeperBounty(ethers.constants.AddressZero, 100, 1000)
      ).to.be.reverted;
      // Authorized → state + event.
      await dao.grant(plugin.address, await voter.getAddress(), UPDATE_BOUNTY_PERMISSION_ID);
      await expect(plugin.connect(voter).setKeeperBounty(ethers.constants.AddressZero, 100, 1000))
        .to.emit(plugin, "KeeperBountyConfigured")
        .withArgs(ethers.constants.AddressZero, 100, 1000);
      expect(await plugin.bountyToken()).to.equal(ethers.constants.AddressZero);
      expect(await plugin.bountyPerCrank()).to.equal(100);
      expect(await plugin.bountyMaxPerPeriod()).to.equal(1000);
    });

    it("pays an ETH bounty to msg.sender on a successful executePayroll", async () => {
      const aAddr = await alice.getAddress();
      await plugin
        .connect(voter)
        .addRecipient(aAddr, token.address, ethers.utils.parseUnits("500", 6), "");
      await token.mint(dao.address, ethers.utils.parseUnits("10000", 6));
      const bounty = ethers.utils.parseEther("0.01");
      await grantBountyPermissionAndConfigure(ethers.constants.AddressZero, bounty, bounty.mul(10));
      // Fund the DAO so it can pay the ETH bounty.
      await fundDaoEth(dao, ethers.utils.parseEther("1"));

      const keeperAddr = await stranger.getAddress();
      const daoEthBefore = await ethers.provider.getBalance(dao.address);

      await time.setNextBlockTimestamp(payDayTs(2027, 7));
      await expect(plugin.connect(stranger).executePayroll())
        .to.emit(plugin, "KeeperBountyPaid")
        .withArgs(keeperAddr, ethers.constants.AddressZero, bounty, 2027 * 12 + 7);

      // The DAO's ETH balance must drop by exactly `bounty` (no other ETH
      // recipients on this crank — only the ERC20 transfer to alice).
      const daoEthAfter = await ethers.provider.getBalance(dao.address);
      expect(daoEthBefore.sub(daoEthAfter)).to.equal(bounty);
      expect(await plugin.bountyPaidThisPeriod()).to.equal(bounty);
    });

    it("pays an ERC20 bounty on a successful crank", async () => {
      const aAddr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(aAddr, token.address, 100, "");
      await token.mint(dao.address, 1_000_000);
      const bounty = 7000;
      await grantBountyPermissionAndConfigure(token.address, bounty, bounty * 10);

      const keeperAddr = await stranger.getAddress();
      await time.setNextBlockTimestamp(payDayTs(2027, 8));
      await plugin.connect(stranger).executePayroll();

      expect(await token.balanceOf(keeperAddr)).to.equal(bounty);
    });

    it("rolling per-period cap clips additional payouts within the same period", async () => {
      // Need a paginated payroll so two cranks land in the same period.
      const a = ethers.utils.getAddress(`0x${"01".padStart(40, "0")}`);
      const b = ethers.utils.getAddress(`0x${"02".padStart(40, "0")}`);
      await plugin.connect(voter).addRecipient(a, token.address, 100, "");
      await plugin.connect(voter).addRecipient(b, token.address, 100, "");
      await token.mint(dao.address, 1_000_000);
      const bounty = 10_000;
      // Cap = 1.5x — second crank's bounty gets clipped to half.
      const cap = 15_000;
      await grantBountyPermissionAndConfigure(token.address, bounty, cap);

      const keeperAddr = await stranger.getAddress();
      await time.setNextBlockTimestamp(payDayTs(2027, 9));
      // Page 1 → full bounty.
      await plugin.connect(stranger).executePayrollPage(1);
      expect(await token.balanceOf(keeperAddr)).to.equal(bounty);
      // Page 2 → clipped to remainder (cap - first payout = 5000).
      await plugin.connect(stranger).executePayrollPage(1);
      expect(await token.balanceOf(keeperAddr)).to.equal(cap);
      expect(await plugin.bountyPaidThisPeriod()).to.equal(cap);
    });

    it("cap resets on a new period", async () => {
      const a = ethers.utils.getAddress(`0x${"01".padStart(40, "0")}`);
      await plugin.connect(voter).addRecipient(a, token.address, 100, "");
      await token.mint(dao.address, 1_000_000);
      const bounty = 1000;
      await grantBountyPermissionAndConfigure(token.address, bounty, bounty);

      const keeperAddr = await stranger.getAddress();
      await time.setNextBlockTimestamp(payDayTs(2027, 10));
      await plugin.connect(stranger).executePayroll();
      expect(await token.balanceOf(keeperAddr)).to.equal(bounty);

      await time.setNextBlockTimestamp(payDayTs(2027, 11));
      await plugin.connect(stranger).executePayroll();
      expect(await token.balanceOf(keeperAddr)).to.equal(bounty * 2);
      expect(await plugin.bountyPaidThisPeriod()).to.equal(bounty);
      expect(await plugin.bountyAccumPeriod()).to.equal(2027 * 12 + 11);
    });

    it("disabled bounty (perCrank=0 or cap=0) emits no KeeperBountyPaid", async () => {
      const aAddr = await alice.getAddress();
      await plugin.connect(voter).addRecipient(aAddr, token.address, 100, "");
      await token.mint(dao.address, 1_000_000);
      // perCrank=0 → no bounty.
      await grantBountyPermissionAndConfigure(token.address, 0, 1000);

      await time.setNextBlockTimestamp(payDayTs(2027, 12));
      const tx = await plugin.connect(stranger).executePayroll();
      const receipt = await tx.wait();
      const found = receipt.logs.some((l) => {
        try {
          return plugin.interface.parseLog(l).name === "KeeperBountyPaid";
        } catch {
          return false;
        }
      });
      expect(found).to.equal(false);
    });
  });

  describe("previewForcePayPeriodActions", () => {
    const P = (y: number, m: number) => y * 12 + m;

    async function setupPaidJan(): Promise<string> {
      const aAddr = await alice.getAddress();
      await plugin
        .connect(voter)
        .addRecipient(aAddr, token.address, ethers.utils.parseUnits("500", 6), "");
      await token.mint(dao.address, ethers.utils.parseUnits("100000", 6));
      // Regular run for Jan 2027 → lastPayoutPeriod = 2027*12+1.
      await time.setNextBlockTimestamp(payDayTs(2027, 1));
      await plugin.executePayroll();
      return aAddr;
    }

    it("returns the active-recipient transfer batch, executable top-level by the DAO", async () => {
      const aAddr = await setupPaidJan();
      const before = await token.balanceOf(aAddr);
      // Now it's April; Feb + Mar were skipped. Preview Feb recovery.
      await time.increaseTo(payDayTs(2027, 4));
      const actions = await plugin.previewForcePayPeriodActions(P(2027, 2));
      expect(actions.length).to.equal(1);
      expect(actions[0].to).to.equal(token.address);
      expect(actions[0].value).to.equal(0);

      // Governance carries these actions and runs them at the top level via
      // DAO.execute — no nested execute. Simulate that here.
      await dao.execute(
        ethers.utils.id("force-2027-02"),
        actions.map((a) => ({to: a.to, value: a.value, data: a.data})),
        0
      );
      expect(await token.balanceOf(aAddr)).to.equal(before.add(ethers.utils.parseUnits("500", 6)));
      // The view never mutates plugin state.
      expect(await plugin.lastPayoutPeriod()).to.equal(P(2027, 1));
    });

    it("reverts for the current or a future period", async () => {
      await setupPaidJan();
      await time.increaseTo(payDayTs(2027, 4));
      await expect(plugin.previewForcePayPeriodActions(P(2027, 4)))
        .to.be.revertedWithCustomError(plugin, "ForcePeriodNotPast")
        .withArgs(P(2027, 4), P(2027, 4));
      await expect(plugin.previewForcePayPeriodActions(P(2027, 5)))
        .to.be.revertedWithCustomError(plugin, "ForcePeriodNotPast")
        .withArgs(P(2027, 5), P(2027, 4));
    });

    it("reverts at or before the last regular run (already settled)", async () => {
      await setupPaidJan();
      await time.increaseTo(payDayTs(2027, 4));
      await expect(plugin.previewForcePayPeriodActions(P(2027, 1)))
        .to.be.revertedWithCustomError(plugin, "ForcePeriodAlreadySettled")
        .withArgs(P(2027, 1));
      await expect(plugin.previewForcePayPeriodActions(P(2026, 12)))
        .to.be.revertedWithCustomError(plugin, "ForcePeriodAlreadySettled")
        .withArgs(P(2026, 12));
    });

    it("reverts beyond MAX_FORCE_BACK_MONTHS", async () => {
      await setupPaidJan();
      // Jump far ahead so a forcible (>lastPayoutPeriod) period is still >12mo back.
      await time.increaseTo(payDayTs(2028, 6)); // current = 2028*12+6
      await expect(plugin.previewForcePayPeriodActions(P(2027, 2))) // 16 months back
        .to.be.revertedWithCustomError(plugin, "ForcePeriodTooOld")
        .withArgs(P(2027, 2));
    });

    it("reverts NoActiveRecipients when none are active", async () => {
      // Never ran a regular crank (lastPayoutPeriod = 0); no recipients.
      await time.increaseTo(payDayTs(2027, 4));
      await expect(plugin.previewForcePayPeriodActions(P(2027, 3))).to.be.revertedWithCustomError(
        plugin,
        "NoActiveRecipients"
      );
    });
  });
});
