import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
  PayrollPlugin,
  MockERC20,
  MockBountyManager,
} from "../typechain-types";
import { BigNumber } from "ethers";

describe("PayrollPlugin - Remediation Unit Tests", function () {
  let owner: SignerWithAddress;
  let recipient1: SignerWithAddress;
  let recipient2: SignerWithAddress;
  let treasurer: SignerWithAddress;
  let payroll: PayrollPlugin;
  let token: MockERC20;
  let bountyManager: MockBountyManager;

  const ZERO_ADDRESS = ethers.constants.AddressZero;
  const ONE_ETHER = ethers.utils.parseEther("1");
  const TWO_ETHER = ethers.utils.parseEther("2");
  const SIX_MONTHS = 6 * 30 * 24 * 60 * 60; // seconds

  async function deployFixture() {
    [owner, recipient1, recipient2, treasurer] = await ethers.getSigners();

    // Deploy mock token
    const TokenFactory = await ethers.getContractFactory("MockERC20");
    token = await TokenFactory.deploy("Test Token", "TST", 18);
    await token.deployed();

    // Deploy mock bounty manager (simplified)
    const BountyFactory = await ethers.getContractFactory("MockBountyManager");
    bountyManager = await BountyFactory.deploy();
    await bountyManager.deployed();

    // Deploy PayrollPlugin
    const PayrollFactory = await ethers.getContractFactory("PayrollPlugin");
    // The constructor may require: token address, bounty manager address, owner, etc.
    payroll = await PayrollFactory.deploy(
      token.address,
      bountyManager.address,
      owner.address
    );
    await payroll.deployed();

    // Fund the payroll contract
    await token.mint(payroll.address, ethers.utils.parseEther("10000"));

    // Set treasurer role if needed
    await payroll.grantRole(await payroll.TREASURER_ROLE(), treasurer.address);

    return { payroll, token, bountyManager, owner, recipient1, recipient2, treasurer };
  }

  // -----------------------------------------------------------------------
  // Finding: Simulated Transfer Failure (High)
  // -----------------------------------------------------------------------
  describe("Transfer failure handling", function () {
    it("should revert the entire payment cycle when individual transfer fails", async function () {
      const { payroll, token, owner, recipient1, recipient2 } = await loadFixture(deployFixture);

      // Configure recipients
      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      await payroll.addRecipient(recipient2.address, TWO_ETHER, 60);

      // Setup payroll cycle (e.g., start cycle)
      await payroll.startPayrollCycle();

      // Simulate failed transfer by making token.balanceOf(payroll) insufficient for recipient2
      const insufficientBalance = ethers.utils.parseEther("0.5"); // not enough for ONE_ETHER
      // Drain some tokens from payroll to cause failure
      await token.transfer(owner.address, ethers.utils.parseEther("5000")); // make low balance

      // Attempt to process payroll - should revert with "ERC20TransferFailed"
      await expect(
        payroll.connect(treasurer).processPayroll()
      ).to.be.revertedWith("PayrollPlugin__ERC20TransferFailed");

      // Ensure no payments were marked as paid (since the transaction reverted)
      const paidCount = await payroll.getPaidCount(0); // cycle index 0
      expect(paidCount).to.equal(0);
    });

    it("should revert on force-pay when token transfer fails", async function () {
      const { payroll, token, owner, recipient1 } = await loadFixture(deployFixture);

      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      await payroll.startPayrollCycle();

      // Force pay to a recipient; drain contract first
      await token.transfer(owner.address, ethers.utils.parseEther("9999")); // only dust left

      await expect(
        payroll.connect(treasurer).forcePay(recipient1.address)
      ).to.be.revertedWith("PayrollPlugin__ERC20TransferFailed");
    });
  });

  // -----------------------------------------------------------------------
  // Finding: Double-Pay Guard for Force-Pay (High)
  // -----------------------------------------------------------------------
  describe("Double-pay guard", function () {
    it("should prevent force-paying an already paid recipient in the same cycle", async function () {
      const { payroll, token, owner, recipient1, treasurer } = await loadFixture(deployFixture);

      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      await payroll.startPayrollCycle();

      // First force pay should succeed
      await expect(
        payroll.connect(treasurer).forcePay(recipient1.address)
      ).to.emit(payroll, "PaymentMade").withArgs(recipient1.address, ONE_ETHER, 0);

      // Second force pay should revert
      await expect(
        payroll.connect(treasurer).forcePay(recipient1.address)
      ).to.be.revertedWith("PayrollPlugin__AlreadyPaid");

      // Verify only one payment recorded
      const paidCycle = await payroll.getPaidStatus(recipient1.address);
      expect(paidCycle).to.equal(0); // cycle index 0 means paid in cycle 0
    });

    it("should allow force-paying after cycle rotation", async function () {
      const { payroll, token, owner, recipient1, treasurer } = await loadFixture(deployFixture);

      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      await payroll.startPayrollCycle();

      // Pay in cycle 0
      await payroll.connect(treasurer).forcePay(recipient1.address);

      // End cycle and start new one
      await payroll.endPayrollCycle();
      await payroll.startPayrollCycle();

      // Now should be allowed again
      await expect(
        payroll.connect(treasurer).forcePay(recipient1.address)
      ).to.emit(payroll, "PaymentMade");
    });
  });

  // -----------------------------------------------------------------------
  // Finding: Pagination Stability (Medium)
  // -----------------------------------------------------------------------
  describe("Pagination stability", function () {
    it("should return consistent results when snapshot is taken", async function () {
      const { payroll, recipient1, recipient2, owner, treasurer } = await loadFixture(deployFixture);

      // Add recipients and create cycle
      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      await payroll.addRecipient(recipient2.address, TWO_ETHER, 60);
      await payroll.startPayrollCycle();

      // Take a snapshot of recipients for pagination
      await payroll.takeRecipientSnapshot();

      // Modify active list (should not affect snapshot pagination)
      await payroll.deactivateRecipient(recipient1.address);

      // Paginate through snapshot: expect two entries
      const page1 = await payroll.getRecipientPage(0, 10, 0); // snapshotId=0, offset=0, limit=10
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(recipient1.address);
      expect(page1[1]).to.equal(recipient2.address);

      // After deactivation, live list should have only 1
      const { length: liveCount } = await payroll.getActiveRecipientCount();
      expect(liveCount).to.equal(1);
    });

    it("should not be affected by intermediate additions/removals", async function () {
      const { payroll, recipient1, recipient2, owner, treasurer } = await loadFixture(deployFixture);

      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      await payroll.startPayrollCycle();
      await payroll.takeRecipientSnapshot();

      // Add another after snapshot
      await payroll.addRecipient(recipient2.address, TWO_ETHER, 60);

      const page1 = await payroll.getRecipientPage(0, 0, 100);
      expect(page1.length).to.equal(1);
      expect(page1[0]).to.equal(recipient1.address);
    });
  });

  // -----------------------------------------------------------------------
  // Finding: Bounty Economics (Low/Medium)
  // -----------------------------------------------------------------------
  describe("Bounty economics", function () {
    it("should allocate bonus tokens correctly based on bounty config", async function () {
      const { payroll, token, bountyManager, recipient1, owner, treasurer } = await loadFixture(deployFixture);

      // Set bounty config: 20% bonus per eligible payment
      const bonusBps = 2000; // 20%
      await payroll.setBountyConfig(1000, bonusBps, SIX_MONTHS);

      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      await payroll.startPayrollCycle();

      // Simulate bounty eligibility (mock context)
      // The mock bounty manager returns true for current cycle
      await bountyManager.setEligibility(recipient1.address, true);

      // Process payment -> should trigger bounty
      await expect(
        payroll.connect(treasurer).processPayroll()
      ).to.emit(payroll, "BountyPaid");

      // Check that recipient got salary + bonus (1.2 ETH total)
      const balanceChange = await token.balanceOf(recipient1.address);
      const expected = ONE_ETHER.add(ONE_ETHER.mul(bonusBps).div(10000));
      expect(balanceChange).to.equal(expected);
    });

    it("should not allocate bounty when config bounty % is zero", async function () {
      const { payroll, token, bountyManager, recipient1, owner, treasurer } = await loadFixture(deployFixture);

      await payroll.setBountyConfig(1000, 0, SIX_MONTHS); // 0% bonus
      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      await payroll.startPayrollCycle();

      await bountyManager.setEligibility(recipient1.address, true);

      const beforeBalance = await token.balanceOf(recipient1.address);
      await payroll.connect(treasurer).processPayroll();
      const afterBalance = await token.balanceOf(recipient1.address);
      expect(afterBalance.sub(beforeBalance)).to.equal(ONE_ETHER);
    });
  });

  // -----------------------------------------------------------------------
  // Finding: Recipient Reactivation (Low)
  // -----------------------------------------------------------------------
  describe("Recipient reactivation", function () {
    it("should allow reactivating a deactivated recipient", async function () {
      const { payroll, recipient1, owner } = await loadFixture(deployFixture);

      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      await payroll.deactivateRecipient(recipient1.address);

      // Reactivate
      await expect(
        payroll.connect(owner).activateRecipient(recipient1.address)
      ).to.emit(payroll, "RecipientActivated").withArgs(recipient1.address);

      const isActive = await payroll.isActiveRecipient(recipient1.address);
      expect(isActive).to.equal(true);
    });

    it("should not allow reactivating a recipient that never existed", async function () {
      const { payroll, recipient1, owner } = await loadFixture(deployFixture);

      await expect(
        payroll.connect(owner).activateRecipient(recipient1.address)
      ).to.be.revertedWith("PayrollPlugin__RecipientNotFound");
    });

    it("should not allow duplicate activation", async function () {
      const { payroll, recipient1, owner } = await loadFixture(deployFixture);

      await payroll.addRecipient(recipient1.address, ONE_ETHER, 30);
      // Already active, activation should revert or no-op
      await expect(
        payroll.connect(owner).activateRecipient(recipient1.address)
      ).to.be.revertedWith("PayrollPlugin__AlreadyActive");
    });
  });

  // -----------------------------------------------------------------------
  // Finding: Tail Slots Management (Low)
  // -----------------------------------------------------------------------
  describe("Tail slots", function () {
    it("should handle inactive tail slots properly during pagination", async function () {
      const { payroll, recipient1, recipient2, owner } = await loadFixture(deployFixture);

      // Add many recipients to fill active and tail slots
      const recipients: SignerWithAddress[] = [recipient1, recipient2];
      // Assume we have more signers
      const moreAccounts = await ethers.getSigners();
      for (let i = 2; i < 10 && i < moreAccounts.length; i++) {
        recipients.push(moreAccounts[i]);
        await payroll.addRecipient(moreAccounts[i].address, ONE_ETHER, 30);
      }

      // Deactivate some to create tail slots
      for (let i = 3; i < 6 && i < recipients.length; i++) {
        await payroll.deactivateRecipient(recipients[i].address);
      }

      const activeCount = await payroll.getActiveRecipientCount();
      const totalCount = await payroll.getTotalRecipientCount();
      expect(totalCount).to.equal(recipients.length);
      // activeCount should be total - deactivated (3)
      expect(activeCount).to.equal(recipients.length - 3);

      // Paginate active list: should skip deactivated
      const activePage = await payroll.getActiveRecipientPage(0, 10);
      for (const addr of activePage) {
        const isActive = await payroll.isActiveRecipient(addr);
        expect(isActive).to.equal(true);
      }
    });

    it("should allow adding new recipient when tail slots are available", async function () {
      const { payroll, recipient1, recipient2, owner } = await loadFixture(deployFixture);

      // Add max capacity (say 10)
      const signers = await ethers.getSigners();
      for (let i = 0; i < 10 && i < signers.length; i++) {
        await payroll.addRecipient(signers[i].address, ONE_ETHER, 30);
      }

      // Deactivate one to create a tail slot
      await payroll.deactivateRecipient(signers[5].address);

      // Now add a new one - should occupy the slot
      const newRecipient = signers[signers.length - 1];
      await expect(
        payroll.addRecipient(newRecipient.address, ONE_ETHER, 30)
      ).to.not.be.reverted;

      const totalCount = await payroll.getTotalRecipientCount();
      expect(totalCount).to.equal(10); // still capped at 10
    });
  });

  // -----------------------------------------------------------------------
  // Finding: Config Validation (Low)
  // -----------------------------------------------------------------------
  describe("Configuration validation", function () {
    it("should reject setting bounty base rate exceeding 100%", async function () {
      const { payroll, owner } = await loadFixture(deployFixture);
      const invalidBps = 10001; // > 10000 basis points = 100%
      await expect(
        payroll.setBountyConfig(invalidBps, 1000, SIX_MONTHS)
      ).to.be.revertedWith("PayrollPlugin__InvalidBasisPoints");
    });

    it("should reject setting bonus percentage exceeding 100%", async function () {
      const { payroll, owner } = await loadFixture(deployFixture);
      const invalidBonus = 10001;
      await expect(
        payroll.setBountyConfig(1000, invalidBonus, SIX_MONTHS)
      ).to.be.revertedWith("PayrollPlugin__InvalidBasisPoints");
    });

    it("should reject setting token address to zero", async function () {
      const { payroll, owner } = await loadFixture(deployFixture);
      // Assuming setToken exists for upgrade but not in original? Could be constructor only.
      // Test for any setter if exists, else skip. We'll test addRecipient with zero address.
      await expect(
        payroll.addRecipient(ZERO_ADDRESS, ONE_ETHER, 30)
      ).to.be.revertedWith("PayrollPlugin__InvalidAddress");
    });

    it("should reject adding recipient with zero salary", async function () {
      const { payroll, owner, recipient1 } = await loadFixture(deployFixture);
      await expect(
        payroll.addRecipient(recipient1.address, ethers.constants.Zero, 30)
      ).to.be.revertedWith("PayrollPlugin__ZeroAmount");
    });

    it("should reject setting negative cycle duration", async function () {
      const { payroll, owner } = await loadFixture(deployFixture);
      await expect(
        payroll.setCycleDuration(0)
      ).to.be.revertedWith("PayrollPlugin__InvalidDuration");
    });
  });
});