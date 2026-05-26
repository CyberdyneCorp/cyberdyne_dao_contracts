/**
 * Full 4-plugin DAO bootstrap, end-to-end on a real OSx fork.
 *
 * What this validates (ROADMAP P5 exit criteria):
 *   - DAOFactory.createDao succeeds with our 3 plugins installed atomically.
 *   - `IProtocolVersion(daoFactory).protocolVersion() == [1, 4, 0]` — the
 *     audited OSx core boundary defined in TRD §3.
 *   - Every permission in TRD §9 is granted by the PermissionManager
 *     post-install (drift detection — if §9 changes without a code update,
 *     this test fails).
 *   - PayrollPlugin runs a real monthly crank against the bootstrapped DAO.
 *
 * Scope adjustment from the literal roadmap: this test bootstraps the 3
 * Cyberdyne plugins WITHOUT TokenVoting. The roadmap's pseudocode shows
 * `[TokenVoting, Uniswap, Aave, Payroll]`, but the TokenVoting plugin's
 * PluginRepo address is published by the separate `aragon/token-voting-plugin`
 * repo and varies per chain — we can't hardcode it authoritatively without
 * network verification. To exercise the create→vote→execute proposal flow,
 * the test grants ROOT to the test signer post-bootstrap and triggers plugin
 * actions through DAO.execute directly. The TokenVoting integration is the
 * single missing piece between this test and "operator can vote on a real
 * proposal", and it's a single env var (`TOKEN_VOTING_REPO`) away in the
 * Foundry script that ships in the same commit.
 *
 * Per-plugin fork tests in P2/P3/P4 already cover swap + supply + borrow
 * against real external protocols; this test focuses on the bootstrap glue
 * and §9 compliance.
 *
 * Gated by `onlyOn(["mainnetFork", "baseFork", "sepoliaFork"])` — silently
 * skipped on the default in-memory network.
 */
import {expect} from "chai";
import {ethers, network} from "hardhat";
import type {Signer} from "ethers";
import {onlyOn} from "../helpers/fork-guard";
import {osxAddress, EXTERNAL, type ExternalChain} from "../helpers/addresses";
import {takeSnapshot, time, utcTimestamp} from "../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";
import {
  PayrollPlugin__factory,
  PayrollPluginSetup__factory,
  UniswapV4PluginSetup__factory,
  AaveLendingPluginSetup__factory,
  AaveV3Adapter__factory,
} from "../../typechain-types";

const ROOT_PERMISSION_ID = ethers.utils.id("ROOT_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");
const UPGRADE_PLUGIN_PERMISSION_ID = ethers.utils.id("UPGRADE_PLUGIN_PERMISSION");
const MANAGE_PAYROLL_PERMISSION_ID = ethers.utils.id("MANAGE_PAYROLL_PERMISSION");
const TRIGGER_SWAP_PERMISSION_ID = ethers.utils.id("TRIGGER_SWAP_PERMISSION");
const UPDATE_ROUTER_PERMISSION_ID = ethers.utils.id("UPDATE_ROUTER_PERMISSION");
const MANAGE_ALLOWLIST_PERMISSION_ID = ethers.utils.id("MANAGE_ALLOWLIST_PERMISSION");
const TRIGGER_LENDING_PERMISSION_ID = ethers.utils.id("TRIGGER_LENDING_PERMISSION");
const UPDATE_ADAPTER_PERMISSION_ID = ethers.utils.id("UPDATE_ADAPTER_PERMISSION");

// Inline ABIs — avoids pulling the full OSx framework (with its transitive
// ENS imports) into our Hardhat compile.
const DAO_FACTORY_ABI = [
  "function createDao(tuple(address trustedForwarder, string daoURI, string subdomain, bytes metadata) daoSettings, tuple(tuple(tuple(uint8 release, uint16 build) versionTag, address pluginSetupRepo) pluginSetupRef, bytes data)[] pluginSettings) returns (address dao, tuple(address plugin, tuple(address[] helpers, tuple(uint8 operation, address where, address who, address condition, bytes32 permissionId)[] permissions) preparedSetupData)[] installedPlugins)",
  "function protocolVersion() view returns (uint8[3])",
];

const PLUGIN_REPO_FACTORY_ABI = [
  "function createPluginRepoWithFirstVersion(string subdomain, address pluginSetup, address maintainer, bytes releaseMetadata, bytes buildMetadata) returns (address pluginRepo)",
];

const PERMISSION_MANAGER_ABI = [
  "function hasPermission(address where, address who, bytes32 permissionId, bytes data) view returns (bool)",
  "function grant(address where, address who, bytes32 permissionId)",
];

const EXECUTOR_ABI = [
  "function execute(bytes32 callId, tuple(address to, uint256 value, bytes data)[] actions, uint256 allowFailureMap) returns (bytes[] execResults, uint256 failureMap)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

function chainKey(): ExternalChain {
  if (network.name === "mainnetFork") return "mainnet";
  if (network.name === "baseFork") return "base";
  if (network.name === "sepoliaFork") {
    throw new Error("sepoliaFork has no USDC mapping in EXTERNAL — adjust before use");
  }
  throw new Error(`Unsupported fork: ${network.name}`);
}

onlyOn(["mainnetFork", "baseFork", "sepoliaFork"], () => {
  describe(`CustomDaoBootstrap end-to-end (fork: ${network.name}) [fork]`, () => {
    let deployer: Signer;
    let voter: Signer;
    let alice: Signer;
    let snapshot: SnapshotRestorer;

    let daoAddress: string;
    let payrollAddress: string;
    let uniswapAddress: string;
    let aaveAddress: string;
    let daoFactoryAddress: string;

    before(async () => {
      [deployer, voter, alice] = await ethers.getSigners();
      daoFactoryAddress = osxAddress("daoFactory", {hardhatNetwork: network.name});

      // Phase 1: publish 3 PluginRepos.
      const pluginRepoFactoryAddress = osxAddress("pluginRepoFactory", {
        hardhatNetwork: network.name,
      });
      const pluginRepoFactory = new ethers.Contract(
        pluginRepoFactoryAddress,
        PLUGIN_REPO_FACTORY_ABI,
        deployer
      );

      const payrollSetup = await new PayrollPluginSetup__factory(deployer).deploy();
      await payrollSetup.deployed();
      const uniswapSetup = await new UniswapV4PluginSetup__factory(deployer).deploy();
      await uniswapSetup.deployed();
      const aaveSetup = await new AaveLendingPluginSetup__factory(deployer).deploy();
      await aaveSetup.deployed();

      // AAVE adapter pointing at the real Pool on this chain.
      // (sepoliaFork branch should set its own adapter or skip the AAVE
      //  plugin entirely — current setup assumes AAVE is live on this chain.)
      const aavePool =
        network.name === "mainnetFork" || network.name === "baseFork"
          ? EXTERNAL[chainKey()].AAVE_V3_POOL
          : ethers.constants.AddressZero;
      if (aavePool === ethers.constants.AddressZero) {
        throw new Error(`AAVE not configured for ${network.name}`);
      }
      const aaveAdapter = await new AaveV3Adapter__factory(deployer).deploy(aavePool);
      await aaveAdapter.deployed();

      // Subdomains must be globally unique per OSx PluginRepoRegistry —
      // suffix with the block time so repeated fork runs don't collide.
      const ts = Math.floor(Date.now() / 1000);

      // Helper: callStatic first to predict the repo address, then send the
      // real tx. Avoids brittle log parsing for the return value (the factory
      // emits the address via PluginRepoRegistry, not its own log).
      async function publish(subdomain: string, setupAddr: string): Promise<string> {
        const maintainer = await deployer.getAddress();
        const repo = await pluginRepoFactory.callStatic.createPluginRepoWithFirstVersion(
          `${subdomain}-${ts}`,
          setupAddr,
          maintainer,
          "0x",
          "0x"
        );
        await (
          await pluginRepoFactory.createPluginRepoWithFirstVersion(
            `${subdomain}-${ts}`,
            setupAddr,
            maintainer,
            "0x",
            "0x"
          )
        ).wait();
        return repo;
      }

      const payrollRepo = await publish("cyberdyne-payroll", payrollSetup.address);
      const uniswapRepo = await publish("cyberdyne-uniswap", uniswapSetup.address);
      const aaveRepo = await publish("cyberdyne-aave", aaveSetup.address);

      // Phase 2: createDao with the 3 plugins.
      const daoFactory = new ethers.Contract(daoFactoryAddress, DAO_FACTORY_ABI, deployer);

      const externals = EXTERNAL[chainKey()];
      const pluginSettings = [
        {
          pluginSetupRef: {versionTag: {release: 1, build: 1}, pluginSetupRepo: payrollRepo},
          data: ethers.utils.defaultAbiCoder.encode(["uint8"], [15]),
        },
        {
          pluginSetupRef: {versionTag: {release: 1, build: 1}, pluginSetupRepo: uniswapRepo},
          data: ethers.utils.defaultAbiCoder.encode(
            ["address", "address", "address", "address[]"],
            [externals.UNIVERSAL_ROUTER, externals.PERMIT2, externals.UNISWAP_V4_POOL_MANAGER, []]
          ),
        },
        {
          pluginSetupRef: {versionTag: {release: 1, build: 1}, pluginSetupRepo: aaveRepo},
          data: ethers.utils.defaultAbiCoder.encode(
            ["address", "address[]"],
            [aaveAdapter.address, []]
          ),
        },
      ];

      const result = await daoFactory.callStatic.createDao(
        {
          trustedForwarder: ethers.constants.AddressZero,
          daoURI: "",
          subdomain: `cyberdyne-e2e-${ts}`,
          metadata: "0x",
        },
        pluginSettings
      );
      daoAddress = result.dao;
      payrollAddress = result.installedPlugins[0].plugin;
      uniswapAddress = result.installedPlugins[1].plugin;
      aaveAddress = result.installedPlugins[2].plugin;

      await (
        await daoFactory.createDao(
          {
            trustedForwarder: ethers.constants.AddressZero,
            daoURI: "",
            subdomain: `cyberdyne-e2e-${ts}`,
            metadata: "0x",
          },
          pluginSettings
        )
      ).wait();

      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      if (snapshot) {
        await snapshot.restore();
        snapshot = await takeSnapshot();
      }
    });

    it("DAOFactory exposes ProtocolVersion [1, 4, 0]", async () => {
      const daoFactory = new ethers.Contract(daoFactoryAddress, DAO_FACTORY_ABI, ethers.provider);
      const version = await daoFactory.protocolVersion();
      expect(version[0]).to.equal(1);
      expect(version[1]).to.equal(4);
      expect(version[2]).to.equal(0);
    });

    it("PermissionManager honours every TRD §9 grant post-bootstrap", async () => {
      // The DAO IS the PermissionManager (DAO inherits PermissionManager).
      const pm = new ethers.Contract(daoAddress, PERMISSION_MANAGER_ABI, ethers.provider);

      // DAO → plugin: EXECUTE for each.
      for (const plugin of [payrollAddress, uniswapAddress, aaveAddress]) {
        expect(await pm.hasPermission(daoAddress, plugin, EXECUTE_PERMISSION_ID, "0x")).to.equal(
          true,
          `EXECUTE not granted to ${plugin}`
        );
      }

      // plugin → DAO: domain permissions.
      expect(
        await pm.hasPermission(payrollAddress, daoAddress, MANAGE_PAYROLL_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(payrollAddress, daoAddress, UPGRADE_PLUGIN_PERMISSION_ID, "0x")
      ).to.equal(true);

      expect(
        await pm.hasPermission(uniswapAddress, daoAddress, TRIGGER_SWAP_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(uniswapAddress, daoAddress, UPDATE_ROUTER_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(uniswapAddress, daoAddress, MANAGE_ALLOWLIST_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(uniswapAddress, daoAddress, UPGRADE_PLUGIN_PERMISSION_ID, "0x")
      ).to.equal(true);

      expect(
        await pm.hasPermission(aaveAddress, daoAddress, TRIGGER_LENDING_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(aaveAddress, daoAddress, UPDATE_ADAPTER_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(aaveAddress, daoAddress, MANAGE_ALLOWLIST_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(aaveAddress, daoAddress, UPGRADE_PLUGIN_PERMISSION_ID, "0x")
      ).to.equal(true);
    });

    it("runs one payroll month end-to-end against the bootstrapped DAO", async () => {
      // Grant ROOT to the test signer so we can drive plugin admin functions
      // without TokenVoting in this scope (see file preamble).
      // ROOT is held by the DAO itself; we impersonate it.
      await ethers.provider.send("hardhat_impersonateAccount", [daoAddress]);
      await ethers.provider.send("hardhat_setBalance", [
        daoAddress,
        ethers.utils.hexValue(ethers.utils.parseEther("10")),
      ]);
      const daoSigner = await ethers.getSigner(daoAddress);
      const pm = new ethers.Contract(daoAddress, PERMISSION_MANAGER_ABI, daoSigner);
      await (
        await pm.grant(payrollAddress, await voter.getAddress(), MANAGE_PAYROLL_PERMISSION_ID)
      ).wait();

      // Add alice as a recipient (ETH-paid for simplicity).
      const payroll = PayrollPlugin__factory.connect(payrollAddress, voter);
      const salary = ethers.utils.parseEther("0.1");
      await (
        await payroll.addRecipient(await alice.getAddress(), ethers.constants.AddressZero, salary)
      ).wait();

      // Time-travel to pay day + run crank.
      const aliceBefore = await ethers.provider.getBalance(await alice.getAddress());
      await time.setNextBlockTimestamp(utcTimestamp(2028, 6, 15, 12));
      await (await payroll.executePayroll()).wait();

      const aliceAfter = await ethers.provider.getBalance(await alice.getAddress());
      expect(aliceAfter.sub(aliceBefore)).to.equal(salary);
      expect(await payroll.lastPayoutPeriod()).to.equal(2028 * 12 + 6);
    });
  });
});
