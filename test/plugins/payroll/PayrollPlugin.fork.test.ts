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
import type {Signer} from "ethers";
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
  describe(`PayrollPlugin (fork: ${network.name}) [fork]`, function () {
    // Retry transient public-RPC zero-reads (see AAVE fork test for rationale).
    this.retries(2);

    let deployer: Signer;
    let voter: Signer;
    let alice: Signer;
    let dao: MinimalDAO;
    let plugin: PayrollPlugin;
    let usdcAddress: string;
    let usdc: import("ethers").Contract;
    let snapshot: SnapshotRestorer;

    before(async () => {
      [deployer, voter, alice] = await ethers.getSigners();
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

      await plugin.connect(voter).addRecipient(aAddr, usdcAddress, salary, "");

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

      await plugin.connect(voter).addRecipient(aAddr, usdcAddress, salary, "");

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

    // H-01 regression on a real fork: salary transfers are mandatory, so one
    // reverting payee aborts the WHOLE crank — nobody is paid and the period is
    // not locked (retryable once the bad payee is corrected). Pre-fix the batch
    // "tolerated" the reverting payee and locked the period.
    it("H-01: one reverting payee reverts the whole crank (real ETH)", async () => {
      const reverting = await new RevertingRecipient__factory(deployer).deploy();
      await reverting.deployed();
      const bAddr = ethers.Wallet.createRandom().address;
      const ethSalary = ethers.utils.parseEther("0.5");

      await setEthBalance(dao.address, ethers.utils.parseEther("10"));

      await plugin
        .connect(voter)
        .addRecipient(reverting.address, ethers.constants.AddressZero, ethSalary, "");
      await plugin.connect(voter).addRecipient(bAddr, ethers.constants.AddressZero, ethSalary, "");

      await time.setNextBlockTimestamp(utcTimestamp(2027, 9, PAY_DAY, 12));
      await expect(plugin.executePayroll()).to.be.reverted;

      // Neither payee received anything; the period stayed open.
      expect(await ethers.provider.getBalance(bAddr)).to.equal(0);
      expect(await ethers.provider.getBalance(reverting.address)).to.equal(0);
      expect(await plugin.lastPayoutPeriod()).to.equal(0);
    });

    it("previewForcePayPeriodActions recovers a skipped month with real USDC", async () => {
      const aAddr = await alice.getAddress();
      const salary = ethers.utils.parseUnits("1000", 6);
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, salary.mul(5));
      await plugin.connect(voter).addRecipient(aAddr, usdcAddress, salary, "");

      // Pay January 2030 → lastPayoutPeriod = 2030*12+1.
      await time.setNextBlockTimestamp(utcTimestamp(2030, 1, PAY_DAY, 12));
      await plugin.executePayroll();
      expect(await usdc.balanceOf(aAddr)).to.equal(salary);

      // March 2030 (February skipped). Build the Feb recovery batch via the
      // preview view (needs a mined block at the new time so the view reads it).
      await time.increaseTo(utcTimestamp(2030, 3, PAY_DAY, 12));
      const period = 2030 * 12 + 2; // Feb 2030
      const raw = await plugin.previewForcePayPeriodActions(period);
      const actions = raw.map((a) => ({to: a.to, value: a.value, data: a.data}));
      // M-04: the ERC20 leg is now a SafeERC20 pair (approve + helper.safeTransfer).
      expect(actions.length).to.equal(2);

      // Governance carries the batch; the DAO runs it top-level via execute.
      await dao.execute(ethers.utils.id("force-2030-02"), actions, 0);
      expect(await usdc.balanceOf(aAddr)).to.equal(salary.mul(2)); // Jan + recovered Feb
    });

    // Gas benchmark for the SafeERC20-helper change (M-04): a full page of ERC20
    // recipients is now 2 actions each (approve + helper.safeTransfer) = 200
    // actions, vs. 1 each (100) for native ETH. This measures a worst-case
    // first-ever payroll to 100 fresh payees (all cold balance writes) on real
    // USDC and asserts it stays well under the mainnet block gas limit (~30M)
    // and the OSx 256-action cap. Tune-down signal if this ever creeps up.
    it("gas: full 100-recipient ERC20 page stays within block limits", async function () {
      this.timeout(300_000);
      const PAGE = (await plugin.MAX_RECIPIENTS_PER_PAGE()).toNumber(); // 100
      const salary = ethers.utils.parseUnits("10", 6);
      const base = ethers.BigNumber.from("0x1000000000000000000000000000000000000000");

      // Fund the DAO for the whole page from a real USDC whale.
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, salary.mul(PAGE));

      // 100 fresh ERC20 payees → cold balance writes (worst case).
      for (let i = 0; i < PAGE; i++) {
        await plugin
          .connect(voter)
          .addRecipient(ethers.utils.getAddress(base.add(i).toHexString()), usdcAddress, salary, "");
      }

      await time.setNextBlockTimestamp(utcTimestamp(2031, 1, PAY_DAY, 12));
      const tx = await plugin.connect(voter).executePayrollPage(PAGE);
      const rcpt = await tx.wait();
      const gas = rcpt.gasUsed;

      // eslint-disable-next-line no-console
      console.log(
        `\n      [gas] executePayrollPage(${PAGE}) ERC20, 200 actions: ${gas.toString()} ` +
          `(~${gas.div(PAGE).toString()}/recipient)`
      );

      // Period settled and the DAO paid out its entire funded balance (it was
      // funded with exactly salary*PAGE), proving all 100 transfers landed —
      // robust against fresh payees that already hold dust on the real fork.
      expect(await plugin.lastPayoutPeriod()).to.equal(2031 * 12 + 1);
      expect(await usdc.balanceOf(dao.address)).to.equal(0);

      // Regression guard: comfortably under a 30M mainnet block (and far under
      // the 256-action OSx cap, which 200 actions already satisfies).
      expect(gas.lt(ethers.BigNumber.from("28000000"))).to.equal(true);
    });
  });
});
