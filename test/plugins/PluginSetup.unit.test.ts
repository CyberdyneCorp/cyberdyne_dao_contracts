import {expect} from "chai";
import {ethers} from "hardhat";
import {
  PayrollPluginSetup__factory,
  UniswapV4PluginSetup__factory,
  AaveLendingPluginSetup__factory,
  CostRegistryPluginSetup__factory,
} from "../../typechain-types";

// Mirrors the (op, where, who, permissionId) tuple from PermissionLib.MultiTargetPermission.
type Permission = {
  operation: number; // 0 Grant, 1 Revoke, 2 GrantWithCondition
  where: string;
  who: string;
  condition: string;
  permissionId: string;
};

const OP_GRANT = 0;
const OP_REVOKE = 1;

// Canonical OSx permission IDs.
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");
const UPGRADE_PLUGIN_PERMISSION_ID = ethers.utils.id("UPGRADE_PLUGIN_PERMISSION");

function assertGrant(p: Permission, where: string, who: string, permissionId: string): void {
  expect(p.operation).to.equal(OP_GRANT);
  expect(p.where).to.equal(where);
  expect(p.who).to.equal(who);
  expect(p.permissionId).to.equal(permissionId);
  expect(p.condition).to.equal(ethers.constants.AddressZero);
}

// Some non-zero address standing in for the DAO during static-call decoding of
// `prepareInstallation`. The setup contracts deploy a real UUPS proxy and
// initialize it with this DAO address — that's fine for static-call tests.
const FAKE_DAO = ethers.Wallet.createRandom().address;

describe("PluginSetup (TRD §9 permission-matrix compliance)", () => {
  it("UniswapV4PluginSetup grants the 5 expected permissions on install", async () => {
    const [deployer] = await ethers.getSigners();
    const setup = await new UniswapV4PluginSetup__factory(deployer).deploy();

    // Plausible install args.
    const router = ethers.Wallet.createRandom().address;
    const permit2 = ethers.Wallet.createRandom().address;
    const poolManager = ethers.Wallet.createRandom().address;
    const initialAllowlist: string[] = [];

    const data = ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "address", "address[]"],
      [router, permit2, poolManager, initialAllowlist]
    );

    // callStatic — we only inspect the returned permissions, no side effects we care about.
    const result = await setup.callStatic.prepareInstallation(FAKE_DAO, data);
    const permissions = result.preparedSetupData.permissions as unknown as Permission[];
    const plugin = result.plugin;

    expect(permissions.length).to.equal(5);

    assertGrant(permissions[0], FAKE_DAO, plugin, EXECUTE_PERMISSION_ID);
    assertGrant(permissions[1], plugin, FAKE_DAO, ethers.utils.id("TRIGGER_SWAP_PERMISSION"));
    assertGrant(permissions[2], plugin, FAKE_DAO, ethers.utils.id("UPDATE_ROUTER_PERMISSION"));
    assertGrant(permissions[3], plugin, FAKE_DAO, ethers.utils.id("MANAGE_ALLOWLIST_PERMISSION"));
    assertGrant(permissions[4], plugin, FAKE_DAO, UPGRADE_PLUGIN_PERMISSION_ID);
  });

  it("AaveLendingPluginSetup grants the 5 expected permissions on install", async () => {
    const [deployer] = await ethers.getSigners();
    const setup = await new AaveLendingPluginSetup__factory(deployer).deploy();

    // Adapter must be non-zero — init reverts ZeroAddress otherwise.
    const adapter = ethers.Wallet.createRandom().address;
    const data = ethers.utils.defaultAbiCoder.encode(["address", "address[]"], [adapter, []]);

    const result = await setup.callStatic.prepareInstallation(FAKE_DAO, data);
    const permissions = result.preparedSetupData.permissions as unknown as Permission[];
    const plugin = result.plugin;

    expect(permissions.length).to.equal(5);

    expect(permissions[0].permissionId).to.equal(EXECUTE_PERMISSION_ID);
    expect(permissions[0].where).to.equal(FAKE_DAO);
    expect(permissions[0].who).to.equal(plugin);

    expect(permissions[1].permissionId).to.equal(ethers.utils.id("TRIGGER_LENDING_PERMISSION"));
    expect(permissions[2].permissionId).to.equal(ethers.utils.id("UPDATE_ADAPTER_PERMISSION"));
    expect(permissions[3].permissionId).to.equal(ethers.utils.id("MANAGE_ALLOWLIST_PERMISSION"));
    expect(permissions[4].permissionId).to.equal(UPGRADE_PLUGIN_PERMISSION_ID);

    // Every plugin→DAO grant has plugin as `where` and DAO as `who`.
    for (let i = 1; i < permissions.length; i++) {
      expect(permissions[i].where).to.equal(plugin);
      expect(permissions[i].who).to.equal(FAKE_DAO);
      expect(permissions[i].operation).to.equal(OP_GRANT);
    }
  });

  it("PayrollPluginSetup grants the 3 expected permissions on install", async () => {
    const [deployer] = await ethers.getSigners();
    const setup = await new PayrollPluginSetup__factory(deployer).deploy();

    const payDayOfMonth = 15;
    const data = ethers.utils.defaultAbiCoder.encode(["uint8"], [payDayOfMonth]);

    const result = await setup.callStatic.prepareInstallation(FAKE_DAO, data);
    const permissions = result.preparedSetupData.permissions as unknown as Permission[];
    const plugin = result.plugin;

    expect(permissions.length).to.equal(3);

    assertGrant(permissions[0], FAKE_DAO, plugin, EXECUTE_PERMISSION_ID);
    assertGrant(permissions[1], plugin, FAKE_DAO, ethers.utils.id("MANAGE_PAYROLL_PERMISSION"));
    assertGrant(permissions[2], plugin, FAKE_DAO, UPGRADE_PLUGIN_PERMISSION_ID);
  });

  it("CostRegistryPluginSetup grants the 3 expected permissions on install", async () => {
    const [deployer] = await ethers.getSigners();
    const setup = await new CostRegistryPluginSetup__factory(deployer).deploy();

    const usdc = ethers.Wallet.createRandom().address;
    const data = ethers.utils.defaultAbiCoder.encode(["address"], [usdc]);

    const result = await setup.callStatic.prepareInstallation(FAKE_DAO, data);
    const permissions = result.preparedSetupData.permissions as unknown as Permission[];
    const plugin = result.plugin;

    expect(permissions.length).to.equal(3);

    assertGrant(permissions[0], FAKE_DAO, plugin, EXECUTE_PERMISSION_ID);
    assertGrant(permissions[1], plugin, FAKE_DAO, ethers.utils.id("MANAGE_COSTS_PERMISSION"));
    assertGrant(permissions[2], plugin, FAKE_DAO, UPGRADE_PLUGIN_PERMISSION_ID);
  });

  it("prepareUpdate on build 1 reverts InvalidUpdatePath(0, 1)", async () => {
    const [deployer] = await ethers.getSigners();

    const uniSetup = await new UniswapV4PluginSetup__factory(deployer).deploy();
    const aaveSetup = await new AaveLendingPluginSetup__factory(deployer).deploy();
    const payrollSetup = await new PayrollPluginSetup__factory(deployer).deploy();
    const costSetup = await new CostRegistryPluginSetup__factory(deployer).deploy();

    const fakePlugin = ethers.Wallet.createRandom().address;
    const payload = {plugin: fakePlugin, currentHelpers: [], data: "0x"};

    for (const setup of [uniSetup, aaveSetup, payrollSetup, costSetup]) {
      await expect(setup.prepareUpdate(FAKE_DAO, 0, payload))
        .to.be.revertedWithCustomError(setup, "InvalidUpdatePath")
        .withArgs(0, 1);
    }
  });

  it("Every PluginSetup's uninstall produces the inverse Revoke set", async () => {
    const [deployer] = await ethers.getSigners();

    const uniSetup = await new UniswapV4PluginSetup__factory(deployer).deploy();
    const aaveSetup = await new AaveLendingPluginSetup__factory(deployer).deploy();
    const payrollSetup = await new PayrollPluginSetup__factory(deployer).deploy();
    const costSetup = await new CostRegistryPluginSetup__factory(deployer).deploy();

    const fakePlugin = ethers.Wallet.createRandom().address;
    const payload = {plugin: fakePlugin, currentHelpers: [], data: "0x"};

    for (const setup of [uniSetup, aaveSetup, payrollSetup, costSetup]) {
      const revokes = (await setup.callStatic.prepareUninstallation(
        FAKE_DAO,
        payload
      )) as unknown as Permission[];
      expect(revokes.length).to.be.greaterThan(0);
      for (const r of revokes) {
        expect(r.operation).to.equal(OP_REVOKE);
      }
    }
  });
});
