/**
 * Full 5-plugin DAO bootstrap, end-to-end on a real OSx fork.
 *
 * What this validates (ROADMAP P5 exit criteria):
 *   - DAOFactory.createDao succeeds with all 5 plugins (Payroll, UniswapV4,
 *     UniswapV3, AAVE, CostRegistry) installed atomically in one tx.
 *   - `IProtocolVersion(daoFactory).protocolVersion() == [1, 4, 0]` — the
 *     audited OSx core boundary defined in TRD §3.
 *   - Every permission in TRD §9 is granted by the PermissionManager
 *     post-install (drift detection — if §9 changes without a code update,
 *     this test fails).
 *   - PayrollPlugin runs a real monthly crank against the bootstrapped DAO.
 *
 * TokenVoting: when `TOKEN_VOTING_REPO` is set to a verified repo address for
 * this fork, the bootstrap installs TokenVoting as plugins[0] (minting a fresh
 * GovernanceERC20 fully allocated to the deployer) and the
 * "runs a proposal through TokenVoting end-to-end" test exercises a real
 * create → vote → execute round-trip. Without the env var, that test
 * self-skips and the payroll test falls back to ROOT-impersonation (the DAO
 * is self-sovereign, so impersonating it lets us drive plugin admin functions
 * directly). The only thing blocking the default-on path is a verified
 * per-chain TokenVoting repo address — see OsxAddresses.tokenVotingRepo and
 * ROADMAP P11.
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
  UniswapV3PluginSetup__factory,
  AaveLendingPlugin__factory,
  AaveLendingPluginSetup__factory,
  AaveV3Adapter__factory,
  CostRegistryPlugin__factory,
  CostRegistryPluginSetup__factory,
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
const MANAGE_POSITIONS_PERMISSION_ID = ethers.utils.id("MANAGE_POSITIONS_PERMISSION");
const UPDATE_POSITION_MANAGER_PERMISSION_ID = ethers.utils.id("UPDATE_POSITION_MANAGER_PERMISSION");
const MANAGE_COSTS_PERMISSION_ID = ethers.utils.id("MANAGE_COSTS_PERMISSION");
const UPDATE_PAYMENT_TOKEN_PERMISSION_ID = ethers.utils.id("UPDATE_PAYMENT_TOKEN_PERMISSION");

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

const AAVE_POOL_ABI = [
  "function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress)",
];

// Known USDC whale for funding the DAO treasury in the governance fund-move test.
const USDC_WHALE: Record<string, string> = {
  mainnet: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
  base: "0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3",
};

// Minimal TokenVoting surface for the create → vote → execute round-trip.
// Matches the build pinned in lib/osx-commons token-voting ABIs.
const TOKEN_VOTING_ABI = [
  "function createProposal(bytes _metadata, tuple(address to, uint256 value, bytes data)[] _actions, uint256 _allowFailureMap, uint64 _startDate, uint64 _endDate, uint8 _voteOption, bool _tryEarlyExecution) returns (uint256 proposalId)",
  "function vote(uint256 _proposalId, uint8 _voteOption, bool _tryEarlyExecution)",
  "function execute(uint256 _proposalId)",
  "function getProposal(uint256 _proposalId) view returns (bool open, bool executed, tuple(uint8 votingMode, uint32 supportThreshold, uint32 startDate, uint32 endDate, uint32 snapshotBlock, uint256 minVotingPower) parameters, tuple(uint256 abstain, uint256 yes, uint256 no) tally, tuple(address to, uint256 value, bytes data)[] actions, uint256 allowFailureMap)",
  "function getVotingToken() view returns (address)",
];

// VoteOption enum: 0 None, 1 Abstain, 2 Yes, 3 No.
const VOTE_YES = 2;

// Canonical mainnet TokenVoting PluginRepo (build 1 is PUSH0-free → works on
// a cancun fork). On a mainnet-state fork we default to it so the governance
// round-trip tests run by default; an explicit env var still overrides.
const TOKEN_VOTING_REPO_MAINNET = "0xb7401cD221ceAFC54093168B814Cc3d42579287f";
function resolveTokenVotingRepo(): string | undefined {
  if (process.env.TOKEN_VOTING_REPO) return process.env.TOKEN_VOTING_REPO;
  // Default-on ONLY for localFork — a developer-controlled anvil fork of
  // mainnet started with `--hardfork cancun` (just fork-local), where the
  // pinned repo + its PUSH0-using impl are guaranteed to run. CI's
  // mainnetFork/baseFork keep the governance round-trips env-gated (unchanged
  // behaviour) because we can't assume the CI fork's hardfork; the 5-plugin
  // bootstrap + §9 matrix below need no TokenVoting and run on every fork.
  if (network.name === "localFork") return TOKEN_VOTING_REPO_MAINNET;
  return undefined;
}
const TOKEN_VOTING_REPO = resolveTokenVotingRepo();
// Build 1 for the pinned mainnet repo (7-arg createProposal, PUSH0-free).
const TOKEN_VOTING_BUILD = Number(
  process.env.TOKEN_VOTING_BUILD ?? (TOKEN_VOTING_REPO === TOKEN_VOTING_REPO_MAINNET ? 1 : 3)
);

function chainKey(): ExternalChain {
  if (network.name === "mainnetFork" || network.name === "localFork") return "mainnet";
  if (network.name === "baseFork") return "base";
  if (network.name === "sepoliaFork") {
    throw new Error("sepoliaFork has no USDC mapping in EXTERNAL — adjust before use");
  }
  throw new Error(`Unsupported fork: ${network.name}`);
}

onlyOn(["mainnetFork", "baseFork", "sepoliaFork", "localFork"], () => {
  describe(`CustomDaoBootstrap end-to-end (fork: ${network.name}) [fork]`, function () {
    // Retry transient public-RPC zero-reads (see AAVE fork test for rationale).
    this.retries(2);

    let deployer: Signer;
    let voter: Signer;
    let alice: Signer;
    let snapshot: SnapshotRestorer;

    let daoAddress: string;
    let payrollAddress: string;
    let uniswapAddress: string;
    let uniswapV3Address: string;
    let aaveAddress: string;
    let costRegistryAddress: string;
    let daoFactoryAddress: string;
    let tokenVotingAddress: string | undefined; // set only if TOKEN_VOTING_REPO provided

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
      const uniswapV3Setup = await new UniswapV3PluginSetup__factory(deployer).deploy();
      await uniswapV3Setup.deployed();
      const aaveSetup = await new AaveLendingPluginSetup__factory(deployer).deploy();
      await aaveSetup.deployed();
      const costSetup = await new CostRegistryPluginSetup__factory(deployer).deploy();
      await costSetup.deployed();

      // AAVE adapter pointing at the real Pool on this chain. chainKey()
      // resolves mainnetFork/localFork → mainnet and baseFork → base; sepolia
      // throws earlier (no USDC mapping), so AAVE is always live here.
      const aavePool = EXTERNAL[chainKey()].AAVE_V3_POOL;
      if (!aavePool || aavePool === ethers.constants.AddressZero) {
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
      // Release + build metadata must be NON-EMPTY — the current mainnet
      // PluginRepoFactory reverts EmptyReleaseMetadata() on "0x". Our Foundry
      // deploy scripts already pass bytes("ipfs://"); mirror that here.
      const META = ethers.utils.toUtf8Bytes("ipfs://");
      async function publish(subdomain: string, setupAddr: string): Promise<string> {
        const maintainer = await deployer.getAddress();
        const repo = await pluginRepoFactory.callStatic.createPluginRepoWithFirstVersion(
          `${subdomain}-${ts}`,
          setupAddr,
          maintainer,
          META,
          META
        );
        await (
          await pluginRepoFactory.createPluginRepoWithFirstVersion(
            `${subdomain}-${ts}`,
            setupAddr,
            maintainer,
            META,
            META
          )
        ).wait();
        return repo;
      }

      const payrollRepo = await publish("cyberdyne-payroll", payrollSetup.address);
      const uniswapRepo = await publish("cyberdyne-uniswap", uniswapSetup.address);
      const uniswapV3Repo = await publish("cyberdyne-uniswap-v3", uniswapV3Setup.address);
      const aaveRepo = await publish("cyberdyne-aave", aaveSetup.address);
      const costRepo = await publish("cyberdyne-cost-registry", costSetup.address);

      // Phase 2: createDao with all 5 plugins.
      const daoFactory = new ethers.Contract(daoFactoryAddress, DAO_FACTORY_ABI, deployer);

      const externals = EXTERNAL[chainKey()];

      // Optionally prepend TokenVoting as plugins[0] when a verified repo is
      // provided. Mints a fresh GovernanceERC20 fully allocated to the
      // deployer so it controls 100% of voting power for the round-trip test.
      const pluginSettings: unknown[] = [];
      if (TOKEN_VOTING_REPO) {
        const tvBuild = TOKEN_VOTING_BUILD;
        const votingSettings = {
          votingMode: 1, // EarlyExecution — lets the 100%-power holder execute immediately
          supportThreshold: 500000, // 50%
          minParticipation: 100000, // 10%
          minDuration: 3600, // 1 hour (OSx floor)
          minProposerVotingPower: 0,
        };
        const tokenSettings = {
          addr: ethers.constants.AddressZero,
          name: "Cyberdyne Gov",
          symbol: "CYBR",
        };
        const mintSettings = {
          receivers: [await deployer.getAddress()],
          amounts: [ethers.utils.parseEther("1000000")],
        };
        const tvData = ethers.utils.defaultAbiCoder.encode(
          [
            "tuple(uint8 votingMode, uint32 supportThreshold, uint32 minParticipation, uint64 minDuration, uint256 minProposerVotingPower)",
            "tuple(address addr, string name, string symbol)",
            "tuple(address[] receivers, uint256[] amounts)",
          ],
          [votingSettings, tokenSettings, mintSettings]
        );
        pluginSettings.push({
          pluginSetupRef: {
            versionTag: {release: 1, build: tvBuild},
            pluginSetupRepo: TOKEN_VOTING_REPO,
          },
          data: tvData,
        });
      }

      pluginSettings.push(
        {
          pluginSetupRef: {versionTag: {release: 1, build: 1}, pluginSetupRepo: payrollRepo},
          data: ethers.utils.defaultAbiCoder.encode(["uint8"], [15]),
        },
        {
          pluginSetupRef: {versionTag: {release: 1, build: 1}, pluginSetupRepo: uniswapRepo},
          data: ethers.utils.defaultAbiCoder.encode(
            ["address", "address", "address", "address", "address[]"],
            [
              externals.UNIVERSAL_ROUTER,
              externals.PERMIT2,
              externals.UNISWAP_V4_POOL_MANAGER,
              ethers.constants.AddressZero, // v4PositionManager — set later via vote if used
              [],
            ]
          ),
        },
        {
          pluginSetupRef: {versionTag: {release: 1, build: 1}, pluginSetupRepo: uniswapV3Repo},
          data: ethers.utils.defaultAbiCoder.encode(
            ["address", "address[]"],
            [externals.UNISWAP_V3_NPM, []]
          ),
        },
        {
          pluginSetupRef: {versionTag: {release: 1, build: 1}, pluginSetupRepo: aaveRepo},
          data: ethers.utils.defaultAbiCoder.encode(
            ["address", "address[]"],
            [aaveAdapter.address, []]
          ),
        },
        {
          pluginSetupRef: {versionTag: {release: 1, build: 1}, pluginSetupRepo: costRepo},
          data: ethers.utils.defaultAbiCoder.encode(["address"], [externals.USDC]),
        }
      );

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
      // Plugin order in installedPlugins mirrors pluginSettings order:
      // [TokenVoting?] payroll, uniswapV4, uniswapV3, aave, costRegistry.
      const base = TOKEN_VOTING_REPO ? 1 : 0;
      if (TOKEN_VOTING_REPO) tokenVotingAddress = result.installedPlugins[0].plugin;
      payrollAddress = result.installedPlugins[base + 0].plugin;
      uniswapAddress = result.installedPlugins[base + 1].plugin;
      uniswapV3Address = result.installedPlugins[base + 2].plugin;
      aaveAddress = result.installedPlugins[base + 3].plugin;
      costRegistryAddress = result.installedPlugins[base + 4].plugin;

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

      // DAO → plugin: EXECUTE for each (all 5).
      for (const plugin of [
        payrollAddress,
        uniswapAddress,
        uniswapV3Address,
        aaveAddress,
        costRegistryAddress,
      ]) {
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

      // UniswapV3: MANAGE_POSITIONS, UPDATE_POSITION_MANAGER, MANAGE_ALLOWLIST, UPGRADE.
      expect(
        await pm.hasPermission(uniswapV3Address, daoAddress, MANAGE_POSITIONS_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(
          uniswapV3Address,
          daoAddress,
          UPDATE_POSITION_MANAGER_PERMISSION_ID,
          "0x"
        )
      ).to.equal(true);
      expect(
        await pm.hasPermission(uniswapV3Address, daoAddress, MANAGE_ALLOWLIST_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(uniswapV3Address, daoAddress, UPGRADE_PLUGIN_PERMISSION_ID, "0x")
      ).to.equal(true);

      // CostRegistry: MANAGE_COSTS, UPDATE_PAYMENT_TOKEN, UPGRADE.
      expect(
        await pm.hasPermission(costRegistryAddress, daoAddress, MANAGE_COSTS_PERMISSION_ID, "0x")
      ).to.equal(true);
      expect(
        await pm.hasPermission(
          costRegistryAddress,
          daoAddress,
          UPDATE_PAYMENT_TOKEN_PERMISSION_ID,
          "0x"
        )
      ).to.equal(true);
      expect(
        await pm.hasPermission(costRegistryAddress, daoAddress, UPGRADE_PLUGIN_PERMISSION_ID, "0x")
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

      // Add a FRESH zero-balance payee (a node-prefunded signer reads its
      // genesis balance oddly on a fork after receiving ETH — use a clean
      // address so the +salary assertion is unambiguous).
      const payee = ethers.Wallet.createRandom().address;
      const payroll = PayrollPlugin__factory.connect(payrollAddress, voter);
      const salary = ethers.utils.parseEther("0.1");
      await (await payroll.addRecipient(payee, ethers.constants.AddressZero, salary)).wait();

      // Time-travel to pay day + run crank.
      const payeeBefore = await ethers.provider.getBalance(payee);
      await time.setNextBlockTimestamp(utcTimestamp(2028, 6, 15, 12));
      await (await payroll.executePayroll()).wait();

      const payeeAfter = await ethers.provider.getBalance(payee);
      expect(payeeAfter.sub(payeeBefore)).to.equal(salary);
      expect(await payroll.lastPayoutPeriod()).to.equal(2028 * 12 + 6);
    });

    // Real governance round-trip — only runs when TokenVoting was installed
    // (TOKEN_VOTING_REPO provided). This is the path that replaces the
    // ROOT-impersonation shortcut above with an actual create → vote → execute.
    it("runs a proposal through TokenVoting end-to-end (create → vote → execute)", async function () {
      if (!TOKEN_VOTING_REPO || !tokenVotingAddress) {
        this.skip(); // no verified TokenVoting repo for this fork
        return;
      }

      const tv = new ethers.Contract(tokenVotingAddress, TOKEN_VOTING_ABI, deployer);

      // The deployer holds 100% of the freshly-minted governance token. Voting
      // power is snapshotted at proposal creation, so the token must be
      // self-delegated first. GovernanceERC20 auto-delegates on mint in recent
      // builds; if your build doesn't, delegate explicitly before this point.

      // Build the action: add a payroll recipient (a vote-gated admin action).
      const payrollIface = PayrollPlugin__factory.createInterface();
      const newPayee = await alice.getAddress();
      const action = {
        to: payrollAddress,
        value: 0,
        data: payrollIface.encodeFunctionData("addRecipient", [
          newPayee,
          ethers.constants.AddressZero,
          ethers.utils.parseEther("0.05"),
        ]),
      };

      // Create the proposal. endDate = 0 lets the plugin use minDuration.
      const createTx = await tv.createProposal(
        ethers.utils.toUtf8Bytes("ipfs://e2e-test-proposal"),
        [action],
        0, // allowFailureMap
        0, // startDate (0 = now)
        0, // endDate (0 = now + minDuration)
        VOTE_YES, // vote yes at creation
        true // tryEarlyExecution
      );
      const receipt = await createTx.wait();

      // Extract proposalId from the ProposalCreated event (topic[1]).
      const created = receipt.logs.find(
        (l: {topics: string[]}) =>
          l.topics[0] ===
          ethers.utils.id(
            "ProposalCreated(uint256,address,uint64,uint64,bytes,(address,uint256,bytes)[],uint256)"
          )
      );
      // Fall back to proposalId 0 if the topic shape differs across builds —
      // EarlyExecution + 100% power means the proposal likely already executed.
      const proposalId = created
        ? ethers.BigNumber.from(created.topics[1])
        : ethers.BigNumber.from(0);

      // With EarlyExecution + 100% YES, tryEarlyExecution should have executed
      // at creation. If not, advance past minDuration and execute explicitly.
      let proposal = await tv.getProposal(proposalId);
      if (!proposal.executed) {
        await time.increase(3600 + 1); // past minDuration
        await (await tv.execute(proposalId)).wait();
        proposal = await tv.getProposal(proposalId);
      }

      expect(proposal.executed).to.equal(true);

      // The executed action added a recipient — verify the payroll plugin state.
      const payroll = PayrollPlugin__factory.connect(payrollAddress, ethers.provider);
      const recipients = await payroll.allActiveRecipients();
      expect(recipients.some((r) => r.payee.toLowerCase() === newPayee.toLowerCase())).to.equal(
        true
      );
    });

    // THE product promise: governance moving real treasury funds. A vote
    // executes an AAVE supply built via the plugin's `previewSupplyActions`
    // multi-action pattern — proving the full preview…Actions → proposal →
    // vote → execute path works end-to-end against the real AAVE Pool, not
    // just via a direct plugin call. Gated on TokenVoting being installed.
    it("governance moves treasury: AAVE supply via vote → execute (preview…Actions)", async function () {
      if (!TOKEN_VOTING_REPO || !tokenVotingAddress) {
        this.skip();
        return;
      }
      this.timeout(600_000);

      const externals = EXTERNAL[chainKey()];
      const usdc = new ethers.Contract(externals.USDC, ERC20_ABI, ethers.provider);
      const amount = ethers.utils.parseUnits("1000", 6); // 1000 USDC

      // Fund the DAO treasury with USDC from a whale.
      const whale = USDC_WHALE[chainKey()];
      await ethers.provider.send("hardhat_impersonateAccount", [whale]);
      await ethers.provider.send("hardhat_setBalance", [
        whale,
        ethers.utils.hexValue(ethers.utils.parseEther("10")),
      ]);
      const whaleSigner = await ethers.getSigner(whale);
      await (await usdc.connect(whaleSigner).transfer(daoAddress, amount)).wait();

      // Resolve the AAVE aToken for USDC to assert the supply landed in the DAO.
      const pool = new ethers.Contract(externals.AAVE_V3_POOL, AAVE_POOL_ABI, ethers.provider);
      const reserve = await pool.getReserveData(externals.USDC);
      const aToken = new ethers.Contract(reserve.aTokenAddress, ERC20_ABI, ethers.provider);
      const aBefore = await aToken.balanceOf(daoAddress);
      const daoUsdcBefore = await usdc.balanceOf(daoAddress);

      // Build the governance-safe action batch via the plugin's view helper.
      // Returns [approve(pool, amount), pool.supply(asset, amount, onBehalfOf=DAO)].
      const aave = AaveLendingPlugin__factory.connect(aaveAddress, ethers.provider);
      const raw = await aave.previewSupplyActions(externals.USDC, amount);
      const actions = raw.map((a) => ({to: a.to, value: a.value, data: a.data}));
      expect(actions.length).to.be.greaterThan(1); // multi-action batch (approve + supply)

      const tv = new ethers.Contract(tokenVotingAddress, TOKEN_VOTING_ABI, deployer);
      const createTx = await tv.createProposal(
        ethers.utils.toUtf8Bytes("ipfs://e2e-aave-supply"),
        actions,
        0, // allowFailureMap — every action must succeed
        0,
        0,
        VOTE_YES,
        true // tryEarlyExecution (deployer holds 100% power)
      );
      const receipt = await createTx.wait();
      const created = receipt.logs.find(
        (l: {topics: string[]}) =>
          l.topics[0] ===
          ethers.utils.id(
            "ProposalCreated(uint256,address,uint64,uint64,bytes,(address,uint256,bytes)[],uint256)"
          )
      );
      const proposalId = created
        ? ethers.BigNumber.from(created.topics[1])
        : ethers.BigNumber.from(0);

      let proposal = await tv.getProposal(proposalId);
      if (!proposal.executed) {
        await time.increase(3600 + 1);
        await (await tv.execute(proposalId)).wait();
        proposal = await tv.getProposal(proposalId);
      }
      expect(proposal.executed).to.equal(true);

      // Treasury moved: DAO spent its USDC and received aUSDC 1:1 (minus dust).
      expect(daoUsdcBefore.sub(await usdc.balanceOf(daoAddress))).to.equal(amount);
      const aGained = (await aToken.balanceOf(daoAddress)).sub(aBefore);
      expect(aGained).to.be.gte(amount.sub(2)); // aToken is ~1:1, allow rounding dust
      // The plugin never custodies — aTokens are the DAO's.
      expect(await usdc.balanceOf(aaveAddress)).to.equal(0);
    });

    // The v1.1 cap setters are auth-gated by MANAGE_PAYROLL / MANAGE_COSTS,
    // which the bootstrap grants to the DAO. This proves they actually move
    // through real governance (create → vote → execute), exercising the
    // permission wiring for the new functions — a single proposal carrying
    // both setters as a multi-action batch.
    it("governance updates caps: setMaxRecipients + setMaxEntries via vote → execute", async function () {
      if (!TOKEN_VOTING_REPO || !tokenVotingAddress) {
        this.skip();
        return;
      }

      const payroll = PayrollPlugin__factory.connect(payrollAddress, ethers.provider);
      const cost = CostRegistryPlugin__factory.connect(costRegistryAddress, ethers.provider);
      expect(await payroll.MAX_RECIPIENTS()).to.equal(300);
      expect(await cost.MAX_ENTRIES()).to.equal(300);

      const actions = [
        {
          to: payrollAddress,
          value: 0,
          data: PayrollPlugin__factory.createInterface().encodeFunctionData("setMaxRecipients", [
            500,
          ]),
        },
        {
          to: costRegistryAddress,
          value: 0,
          data: CostRegistryPlugin__factory.createInterface().encodeFunctionData("setMaxEntries", [
            750,
          ]),
        },
      ];

      const tv = new ethers.Contract(tokenVotingAddress, TOKEN_VOTING_ABI, deployer);
      const createTx = await tv.createProposal(
        ethers.utils.toUtf8Bytes("ipfs://e2e-cap-setters"),
        actions,
        0,
        0,
        0,
        VOTE_YES,
        true
      );
      const receipt = await createTx.wait();
      const created = receipt.logs.find(
        (l: {topics: string[]}) =>
          l.topics[0] ===
          ethers.utils.id(
            "ProposalCreated(uint256,address,uint64,uint64,bytes,(address,uint256,bytes)[],uint256)"
          )
      );
      const proposalId = created
        ? ethers.BigNumber.from(created.topics[1])
        : ethers.BigNumber.from(0);

      let proposal = await tv.getProposal(proposalId);
      if (!proposal.executed) {
        await time.increase(3600 + 1);
        await (await tv.execute(proposalId)).wait();
        proposal = await tv.getProposal(proposalId);
      }
      expect(proposal.executed).to.equal(true);

      expect(await payroll.MAX_RECIPIENTS()).to.equal(500);
      expect(await cost.MAX_ENTRIES()).to.equal(750);
    });
  });
});
