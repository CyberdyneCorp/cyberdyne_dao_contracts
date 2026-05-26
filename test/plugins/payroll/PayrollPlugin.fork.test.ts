/**
 * PayrollPlugin fork integration tests.
 *
 * Runs against a forked chain (mainnetFork or baseFork) so the DAO holds
 * REAL USDC seeded from a whale via hardhat_impersonateAccount. Validates
 * the calendar-math + per-recipient failure tolerance against real token
 * transfers + real timestamps.
 *
 * Scope deviation from ROADMAP P2: we use the MinimalDAO mock rather than
 * the live DAOFactory. End-to-end bootstrap via DAOFactory belongs to P5's
 * CustomDaoBootstrap.fork.test.ts; for P2 we want focused, fast tests of
 * Payroll behavior against real on-chain assets without the full
 * TokenVoting + PluginRepo dance.
 *
 * Skipped (describe block not registered) when running on a non-fork
 * network — see test/helpers/fork-guard.ts.
 */
import {expect} from "chai";
import {ethers, network} from "hardhat";
import type {BigNumber, Signer} from "ethers";
import {
  MinimalDAO,
  MinimalDAO__factory,
  PayrollPlugin,
  PayrollPlugin__factory,
  RevertingRecipient__factory,
} from "../../../typechain-types";
import {onlyOn} from "../../helpers/fork-guard";
import {EXTERNAL, type ExternalChain} from "../../helpers/addresses";
import {fundFromWhale, setEthBalance} from "../../helpers/impersonate";
import {takeSnapshot, time, utcTimestamp} from "../../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

const MANAGE_PAYROLL_PERMISSION_ID = ethers.utils.id("MANAGE_PAYROLL_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");
const PAY_DAY = 15;

// Known USDC whales on each fork target. Verified active as of the pinned blocks
// in CI — when those change, refresh from etherscan's "Holders" list.
const WHALES: Record<ExternalChain, string> = {
  mainnet: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf", // Polygon: bridged USDC
  base: "0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3", // Aave V3 USDC pool on Base
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function deployProxied(signer: Signer, dao: string, payDay: number): Promise<PayrollPlugin> {
  const impl = await new PayrollPlugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [dao, payDay]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await Proxy.deploy(impl.address, initData);
  await proxy.deployed();
  return PayrollPlugin__factory.connect(proxy.address, signer);
}

function chainKey(): ExternalChain {
  if (network.name === "mainnetFork") return "mainnet";
  if (network.name === "baseFork") return "base";
  throw new Error(`Unsupported fork network: ${network.name}`);
}

onlyOn(["mainnetFork", "baseFork"], () => {
  describe(`PayrollPlugin (fork: ${network.name}) [fork]`, () => {
    let deployer: Signer;
    let voter: Signer;
    let alice: Signer;
    let bob: Signer;
    let dao: MinimalDAO;
    let plugin: PayrollPlugin;
    let usdcAddress: string;
    let usdc: import("ethers").Contract;
    let snapshot: SnapshotRestorer;

    before(async () => {
      [deployer, voter, alice, bob] = await ethers.getSigners();
      usdcAddress = EXTERNAL[chainKey()].USDC;
      usdc = new ethers.Contract(usdcAddress, ERC20_ABI, ethers.provider);
    });

    beforeEach(async () => {
      dao = await new MinimalDAO__factory(deployer).deploy();
      await dao.deployed();
      plugin = await deployProxied(deployer, dao.address, PAY_DAY);
      await dao.grant(plugin.address, await voter.getAddress(), MANAGE_PAYROLL_PERMISSION_ID);
      await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);
      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      if (snapshot) await snapshot.restore();
    });

    it("pays a real USDC salary from DAO treasury", async () => {
      const aAddr = await alice.getAddress();
      const salary = ethers.utils.parseUnits("3000", 6); // 3000 USDC

      // Seed DAO with USDC from a real holder on the fork.
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, salary.mul(2));

      await plugin.connect(voter).addRecipient(aAddr, usdcAddress, salary);

      await time.setNextBlockTimestamp(utcTimestamp(2027, 6, PAY_DAY, 12));
      await plugin.executePayroll();

      expect(await usdc.balanceOf(aAddr)).to.equal(salary);
      expect(await usdc.balanceOf(dao.address)).to.equal(salary); // remaining
      expect(await plugin.lastPayoutPeriod()).to.equal(2027 * 12 + 6);
    });

    it("3-month scenario: month 1 paid, month 2 skipped, month 3 pays only March", async () => {
      const aAddr = await alice.getAddress();
      const salary = ethers.utils.parseUnits("1000", 6);

      // Enough for 3 months even though month 2 won't be drawn.
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, salary.mul(5));

      await plugin.connect(voter).addRecipient(aAddr, usdcAddress, salary);

      // Month 1 — Jan 2028.
      await time.setNextBlockTimestamp(utcTimestamp(2028, 1, PAY_DAY, 12));
      await plugin.executePayroll();
      expect(await usdc.balanceOf(aAddr)).to.equal(salary);

      // Month 2 — Feb 2028. NOBODY calls the crank. Payment for Feb is permanently skipped.

      // Month 3 — Mar 2028. Crank pays only March's salary (1x), NOT March + Feb back-pay (2x).
      await time.setNextBlockTimestamp(utcTimestamp(2028, 3, PAY_DAY, 12));
      await plugin.executePayroll();

      expect(await usdc.balanceOf(aAddr)).to.equal(salary.mul(2)); // 1 + 1, NOT 1 + 2
      expect(await plugin.lastPayoutPeriod()).to.equal(2028 * 12 + 3);
    });

    it("one reverting payee does not block the others (real ETH transfers)", async () => {
      const reverting = await new RevertingRecipient__factory(deployer).deploy();
      await reverting.deployed();
      const bAddr = await bob.getAddress();

      const ethSalary = ethers.utils.parseEther("0.5");

      await setEthBalance(dao.address, ethers.utils.parseEther("10"));

      // Bad recipient first → bit 0 will be set in failureMap.
      await plugin
        .connect(voter)
        .addRecipient(reverting.address, ethers.constants.AddressZero, ethSalary);
      await plugin.connect(voter).addRecipient(bAddr, ethers.constants.AddressZero, ethSalary);

      const bBefore = await ethers.provider.getBalance(bAddr);

      await time.setNextBlockTimestamp(utcTimestamp(2027, 9, PAY_DAY, 12));
      const tx = await plugin.executePayroll();
      const receipt = await tx.wait();

      const iface = new ethers.utils.Interface([
        "event PayrollExecuted(uint256 indexed period, uint256 recipientCount, uint256 failureMap)",
      ]);
      let failureMap: BigNumber | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed.name === "PayrollExecuted") failureMap = parsed.args.failureMap;
        } catch {
          /* not our event */
        }
      }
      expect(failureMap).to.not.be.undefined;
      expect(failureMap!).to.equal(1); // bit 0 = bad recipient failed
      expect(await ethers.provider.getBalance(bAddr)).to.equal(bBefore.add(ethSalary));
      expect(await ethers.provider.getBalance(reverting.address)).to.equal(0);
    });
  });
});
