import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer, BigNumberish } from "ethers";
import { parseUnits } from "ethers/lib/utils";

// =============================================================================
// CostRegistryPlugin.fix.test.ts
// Purpose: Unit tests for CostRegistry accounting fix (CR-H-01), event emission,
//          token migration, and pagination.
// Context: Part of ROADMAP Phase 10 – remediation of external audit findings.
// Coverage: All critical paths after applying SafeERC20 and atomic payment.
// =============================================================================

// -----------------------------------------------------------------------------
// Helper: deploy a mock ERC20 that can be configured to fail transfer
// -----------------------------------------------------------------------------
async function deployMockERC20(
  failTransfer: boolean,
  decimals: number = 18
): Promise<Contract> {
  const factory = await ethers.getContractFactory("MockERC20");
  const token = await factory.deploy("MockToken", "MTK", decimals);
  await token.deployed();

  // Once deployed, configure failure behavior if needed
  await token.setFailTransfer(failTransfer);
  return token;
}

// -----------------------------------------------------------------------------
// Helper: deploy the CostRegistryPlugin with default settings
// -----------------------------------------------------------------------------
async function deployCostRegistryPlugin(
  governance: Signer,
  initialToken: Contract
): Promise<Contract> {
  const factory = await ethers.getContractFactory("CostRegistryPlugin");
  const plugin = await factory.deploy(
    await governance.getAddress(),
    initialToken.address
  );
  await plugin.deployed();
  return plugin;
}

// -----------------------------------------------------------------------------
// Main test suite
// -----------------------------------------------------------------------------
describe("CostRegistryPlugin – Accounting Fix (CR-H-01)", function () {
  let governance: Signer;
  let user: Signer;
  let token: Contract;
  let plugin: Contract;
  let costId: BigNumberish;

  const COST_AMOUNT = parseUnits("1000", 18);
  const RECIPIENT_ADDR = "0x0000000000000000000000000000000000000002";

  beforeEach(async function () {
    [governance, user] = await ethers.getSigners();

    // Deploy a token that succeeds transfer by default
    token = await deployMockERC20(false);

    // Deploy the plugin
    plugin = await deployCostRegistryPlugin(governance, token);

    // Mint tokens to the plugin so it can pay
    await token.mint(plugin.address, parseUnits("10000", 18));

    // Create a cost entry (assume a function like addCost)
    const tx = await plugin.connect(governance).addCost(
      RECIPIENT_ADDR,
      COST_AMOUNT,
      token.address
    );
    const receipt = await tx.wait();

    // Extract cost ID from the CostAdded event
    const event = receipt.events?.find((e: any) => e.event === "CostAdded");
    costId = event?.args?.costId;
    if (costId === undefined) {
      throw new Error("Failed to extract costId from CostAdded event");
    }
  });

  // -------------------------------------------------------------------------
  // Accounting fix: transaction must REVERT when ERC20 transfer fails
  // -------------------------------------------------------------------------
  it("should revert on failed ERC20 transfer (markedPaid prevented)", async function () {
    // Reconfigure token to fail transfers
    await token.setFailTransfer(true);

    // Attempt to pay the cost – must revert
    await expect(
      plugin.connect(governance).payCost(costId)
    ).to.be.revertedWith("SafeERC20: low-level call failed");

    // Verify that the cost entry is NOT marked as paid
    const costEntry = await plugin.getCost(costId);
    expect(costEntry.paid).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // Event emission: CostPaid must be emitted with correct params on success
  // -------------------------------------------------------------------------
  it("should emit CostPaid event on successful payment", async function () {
    // Token succeeds by default
    const tx = await plugin.connect(governance).payCost(costId);
    const receipt = await tx.wait();

    const event = receipt.events?.find(
      (e: any) => e.event === "CostPaid"
    ) as any;
    expect(event).to.not.be.undefined;
    expect(event.args.costId).to.equal(costId);
    expect(event.args.recipient).to.equal(RECIPIENT_ADDR);
    expect(event.args.amount).to.equal(COST_AMOUNT);
    expect(event.args.token).to.equal(token.address);
  });

  // -------------------------------------------------------------------------
  // Token migration
  // -------------------------------------------------------------------------
  describe("Token migration", function () {
    let newToken: Contract;

    beforeEach(async function () {
      newToken = await deployMockERC20(false);
      await newToken.mint(plugin.address, parseUnits("5000", 18));
    });

    it("should migrate token reference and update storage", async function () {
      await plugin.connect(governance).migrateCostToken(costId, newToken.address);

      const costEntry = await plugin.getCost(costId);
      expect(costEntry.token).to.equal(newToken.address);
    });

    it("should emit TokenMigrated event", async function () {
      const tx = await plugin.connect(governance).migrateCostToken(costId, newToken.address);
      const receipt = await tx.wait();

      const event = receipt.events?.find(
        (e: any) => e.event === "TokenMigrated"
      ) as any;
      expect(event).to.not.be.undefined;
      expect(event.args.costId).to.equal(costId);
      expect(event.args.oldToken).to.equal(token.address);
      expect(event.args.newToken).to.equal(newToken.address);
    });

    it("should revert if new token address is zero", async function () {
      await expect(
        plugin.connect(governance).migrateCostToken(costId, ethers.constants.AddressZero)
      ).to.be.revertedWith("CostRegistryPlugin: invalid token address");
    });
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------
  describe("Pagination", function () {
    const NUM_COSTS = 15;

    beforeEach(async function () {
      // Add more costs for pagination testing
      for (let i = 0; i < NUM_COSTS - 1; i++) {
        await plugin.connect(governance).addCost(
          RECIPIENT_ADDR,
          parseUnits("100", 18),
          token.address
        );
      }
    });

    it("should return correct slice given offset and limit", async function () {
      const offset = 5;
      const limit = 3;
      const [costs, total] = await plugin.getCostsPaginated(offset, limit);

      expect(costs.length).to.equal(limit);
      // Cost IDs start at 1, so offset 5 should give IDs 6,7,8
      expect(costs[0].costId).to.equal(5);  // costId might be 1-indexed, adjust accordingly
      expect(costs[1].costId).to.equal(6);
      expect(costs[2].costId).to.equal(7);
      expect(total).to.equal(NUM_COSTS);
    });

    it("should handle empty offset (return from start)", async function () {
      const [costs, total] = await plugin.getCostsPaginated(0, 2);
      expect(costs.length).to.equal(2);
      expect(costs[0].costId).to.equal(1);
      expect(total).to.equal(NUM_COSTS);
    });

    it("should handle limit larger than remaining items", async function () {
      const [costs, total] = await plugin.getCostsPaginated(14, 10);
      expect(costs.length).to.equal(1); // only the last cost remains
      expect(total).to.equal(NUM_COSTS);
    });
  });
});

// -----------------------------------------------------------------------------
// Mock contract (minimal) – in practice this would be compiled alongside
// -----------------------------------------------------------------------------
// Note: The mock contract MockERC20 must be available in the Hardhat project.
// Example:
//   contract MockERC20 is ERC20 {
//     bool private _failTransfer;
//     constructor(...) ERC20(name, symbol) {}
//     function setFailTransfer(bool f) external { _failTransfer = f; }
//     function transfer(...) public override returns (bool) {
//       if (_failTransfer) return false;
//       return super.transfer(...);
//     }
//   }
//   Also ensure transferFrom is mocked similarly if used.