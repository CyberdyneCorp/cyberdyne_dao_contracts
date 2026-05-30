/**
 * CostRegistryPlugin fork integration tests.
 *
 * Runs against a forked chain (mainnetFork or baseFork) so the DAO pays REAL
 * USDC seeded from a whale. Validates the day-based recurring crank against
 * real token transfers + real timestamps.
 *
 * Skipped (describe block not registered) on non-fork networks — see
 * test/helpers/fork-guard.ts.
 */
import {ethers, network} from "hardhat";
import {expect} from "chai";
import type {Signer} from "ethers";
import {
  MinimalDAO,
  MinimalDAO__factory,
  CostRegistryPlugin,
  CostRegistryPlugin__factory,
} from "../../../typechain-types";
import {onlyOn} from "../../helpers/fork-guard";
import {EXTERNAL, type ExternalChain} from "../../helpers/addresses";
import {fundFromWhale} from "../../helpers/impersonate";
import {takeSnapshot, time} from "../../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

const MANAGE_COSTS_PERMISSION_ID = ethers.utils.id("MANAGE_COSTS_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");
const DAY = 86_400;

const WHALES: Record<ExternalChain, string> = {
  mainnet: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
  base: "0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3",
};

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function deployProxied(
  signer: Signer,
  dao: string,
  token: string
): Promise<CostRegistryPlugin> {
  const impl = await new CostRegistryPlugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [dao, token]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await Proxy.deploy(impl.address, initData);
  await proxy.deployed();
  return CostRegistryPlugin__factory.connect(proxy.address, signer);
}

function chainKey(): ExternalChain {
  if (network.name === "mainnetFork") return "mainnet";
  if (network.name === "baseFork") return "base";
  throw new Error(`Unsupported fork network: ${network.name}`);
}

onlyOn(["mainnetFork", "baseFork"], () => {
  describe(`CostRegistryPlugin (fork: ${network.name}) [fork]`, function () {
    // Retry transient public-RPC zero-reads (see AAVE fork test for rationale).
    this.retries(2);

    let deployer: Signer;
    let voter: Signer;
    let dao: MinimalDAO;
    let plugin: CostRegistryPlugin;
    let usdcAddress: string;
    let usdc: import("ethers").Contract;
    let payee: string;
    let snapshot: SnapshotRestorer;

    before(async () => {
      [deployer, voter] = await ethers.getSigners();
      usdcAddress = EXTERNAL[chainKey()].USDC;
      usdc = new ethers.Contract(usdcAddress, ERC20_ABI, ethers.provider);
    });

    beforeEach(async () => {
      payee = ethers.Wallet.createRandom().address;
      dao = await new MinimalDAO__factory(deployer).deploy();
      await dao.deployed();
      plugin = await deployProxied(deployer, dao.address, usdcAddress);
      await dao.grant(plugin.address, await voter.getAddress(), MANAGE_COSTS_PERMISSION_ID);
      await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);
      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      if (snapshot) await snapshot.restore();
    });

    it("pays a real USDC cost from the DAO treasury once the period elapses", async () => {
      const cost = ethers.utils.parseUnits("250", 6); // 250 USDC every 10 days
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, cost.mul(4));
      await plugin.connect(voter).registerEntry("AWS", "cloud bill", cost, 10, payee);

      // Not due yet.
      await plugin.processDue(0, 10);
      expect(await usdc.balanceOf(payee)).to.equal(0);

      // After 10 days it's due.
      await time.increase(10 * DAY + 1);
      await expect(plugin.processDue(0, 10)).to.emit(plugin, "CostPaid");
      expect(await usdc.balanceOf(payee)).to.equal(cost);
      expect(await plugin.isDue(0)).to.equal(false);
    });

    it("no back-pay: several elapsed periods pay only once", async () => {
      const cost = ethers.utils.parseUnits("100", 6);
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, cost.mul(5));
      await plugin.connect(voter).registerEntry("OpenAI", "API", cost, 7, payee);

      await time.increase(30 * DAY); // ~4 periods elapsed
      await plugin.processDue(0, 10);
      expect(await usdc.balanceOf(payee)).to.equal(cost); // one payment, not four
    });

    it("pays only the due entries in a multi-frequency registry", async () => {
      const p5 = ethers.Wallet.createRandom().address;
      const p10 = ethers.Wallet.createRandom().address;
      const p30 = ethers.Wallet.createRandom().address;
      const cost = ethers.utils.parseUnits("100", 6);
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, cost.mul(10));

      await plugin.connect(voter).registerEntry("fast", "", cost, 5, p5);
      await plugin.connect(voter).registerEntry("mid", "", cost, 10, p10);
      await plugin.connect(voter).registerEntry("slow", "", cost, 30, p30);

      await time.increase(12 * DAY); // 5d + 10d due; 30d not yet
      await plugin.processDue(0, 10);

      expect(await usdc.balanceOf(p5)).to.equal(cost);
      expect(await usdc.balanceOf(p10)).to.equal(cost);
      expect(await usdc.balanceOf(p30)).to.equal(0); // 30d entry not due
      expect(await plugin.isDue(2)).to.equal(false);
    });

    // H-03 regression on real USDC: an underfunded batch must revert wholesale
    // and leave NOTHING marked paid (pre-fix it "isolated" the failure and
    // advanced both clocks).
    it("H-03: an underfunded batch reverts on real USDC — nothing marked paid", async () => {
      const payee2 = ethers.Wallet.createRandom().address;
      const cost = ethers.utils.parseUnits("100", 6);
      // Fund the DAO for exactly ONE payment — the second transfer can't settle.
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, cost);

      await plugin.connect(voter).registerEntry("first", "", cost, 10, payee);
      await plugin.connect(voter).registerEntry("second", "", cost, 10, payee2);

      await time.increase(11 * DAY);
      await expect(plugin.processDue(0, 10)).to.be.reverted;

      // No funds moved, both entries still due (no clock advanced).
      expect(await usdc.balanceOf(payee)).to.equal(0);
      expect(await usdc.balanceOf(payee2)).to.equal(0);
      expect(await plugin.isDue(0)).to.equal(true);
      expect(await plugin.isDue(1)).to.equal(true);

      // Fully fund → the same crank settles both on real USDC.
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, cost);
      await expect(plugin.processDue(0, 10)).to.emit(plugin, "CostsProcessed");
      expect(await usdc.balanceOf(payee)).to.equal(cost);
      expect(await usdc.balanceOf(payee2)).to.equal(cost);
    });

    it("reflects update + remove in subsequent cranks (real USDC)", async () => {
      const cost = ethers.utils.parseUnits("100", 6);
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, cost.mul(10));
      await plugin.connect(voter).registerEntry("svc", "", cost, 10, payee);

      // Period 1 — pay the original amount.
      await time.increase(11 * DAY);
      await plugin.processDue(0, 10);
      expect(await usdc.balanceOf(payee)).to.equal(cost);

      // Raise the cost; next due payment uses the new amount.
      const cost2 = ethers.utils.parseUnits("250", 6);
      await plugin.connect(voter).updateEntry(0, "svc", "raised", cost2, 10, payee);
      await time.increase(11 * DAY);
      await plugin.processDue(0, 10);
      expect(await usdc.balanceOf(payee)).to.equal(cost.add(cost2));

      // Remove it; no further payments even after another period.
      await plugin.connect(voter).removeEntry(0);
      await time.increase(11 * DAY);
      await plugin.processDue(0, 10);
      expect(await usdc.balanceOf(payee)).to.equal(cost.add(cost2)); // unchanged
    });
  });
});
