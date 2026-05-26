import {expect} from "chai";
import {ethers} from "hardhat";
import type {Signer} from "ethers";
import {
  AaveLendingPlugin,
  AaveLendingPlugin__factory,
  AaveV3Adapter,
  AaveV3Adapter__factory,
  AaveV4Adapter,
  AaveV4Adapter__factory,
  MinimalDAO,
  MinimalDAO__factory,
  MockAavePool,
  MockAavePool__factory,
  TestERC20,
  TestERC20__factory,
} from "../../../typechain-types";
import {takeSnapshot} from "../../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

const TRIGGER_LENDING_PERMISSION_ID = ethers.utils.id("TRIGGER_LENDING_PERMISSION");
const UPDATE_ADAPTER_PERMISSION_ID = ethers.utils.id("UPDATE_ADAPTER_PERMISSION");
const MANAGE_ALLOWLIST_PERMISSION_ID = ethers.utils.id("MANAGE_ALLOWLIST_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");

const VARIABLE_RATE = 2;
const STABLE_RATE = 1;

// IAavePool surface for computing expected adapter calldata.
const POOL_IFACE = new ethers.utils.Interface([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)",
]);

async function deployProxied(
  signer: Signer,
  dao: string,
  adapter: string,
  allowlist: string[]
): Promise<AaveLendingPlugin> {
  const impl = await new AaveLendingPlugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [dao, adapter, allowlist]);
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await ProxyFactory.deploy(impl.address, initData);
  await proxy.deployed();
  return AaveLendingPlugin__factory.connect(proxy.address, signer);
}

describe("AaveLendingPlugin", () => {
  let deployer: Signer;
  let voter: Signer; // stands in for the DAO-authorized governance caller
  let stranger: Signer;
  let dao: MinimalDAO;
  let pool: MockAavePool;
  let adapter: AaveV3Adapter;
  let plugin: AaveLendingPlugin;
  let usdc: TestERC20;
  let weth: TestERC20;
  let snapshot: SnapshotRestorer;

  afterEach(async () => {
    if (snapshot) await snapshot.restore();
  });

  beforeEach(async () => {
    [deployer, voter, stranger] = await ethers.getSigners();

    dao = await new MinimalDAO__factory(deployer).deploy();
    await dao.deployed();

    // The DAO calls the pool directly; the adapter only encodes calldata.
    pool = await new MockAavePool__factory(deployer).deploy();
    await pool.deployed();
    adapter = await new AaveV3Adapter__factory(deployer).deploy(pool.address);
    await adapter.deployed();

    plugin = await deployProxied(deployer, dao.address, adapter.address, []);

    // Vote-gated callers = `voter` (proxies for "calls coming via DAO.execute").
    await dao.grant(plugin.address, await voter.getAddress(), TRIGGER_LENDING_PERMISSION_ID);
    await dao.grant(plugin.address, await voter.getAddress(), UPDATE_ADAPTER_PERMISSION_ID);
    await dao.grant(plugin.address, await voter.getAddress(), MANAGE_ALLOWLIST_PERMISSION_ID);
    // Plugin needs EXECUTE on DAO so it can issue approve+pool actions.
    await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);

    usdc = await new TestERC20__factory(deployer).deploy("USD Coin", "USDC", 6);
    await usdc.deployed();
    weth = await new TestERC20__factory(deployer).deploy("Wrapped Ether", "WETH", 18);
    await weth.deployed();

    snapshot = await takeSnapshot();
  });

  describe("initialize", () => {
    it("sets adapter, leaves allowlist disabled when empty", async () => {
      expect(await plugin.adapter()).to.equal(adapter.address);
      expect(await plugin.allowlistEnforced()).to.equal(false);
      expect(await plugin.opNonce()).to.equal(0);
    });

    it("reverts ZeroAddress on a zero adapter", async () => {
      const impl = await new AaveLendingPlugin__factory(deployer).deploy();
      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
      const initData = impl.interface.encodeFunctionData("initialize", [
        dao.address,
        ethers.constants.AddressZero,
        [],
      ]);
      await expect(ProxyFactory.deploy(impl.address, initData)).to.be.revertedWithCustomError(
        impl,
        "ZeroAddress"
      );
    });

    it("seeds the allowlist and flips allowlistEnforced=true", async () => {
      const seeded = await deployProxied(deployer, dao.address, adapter.address, [
        usdc.address,
        weth.address,
      ]);
      expect(await seeded.allowlistEnforced()).to.equal(true);
      expect(await seeded.allowedAsset(usdc.address)).to.equal(true);
      expect(await seeded.allowedAsset(weth.address)).to.equal(true);
      expect(await seeded.allowedAsset(ethers.Wallet.createRandom().address)).to.equal(false);
    });

    it("cannot be initialized twice", async () => {
      await expect(plugin.initialize(dao.address, adapter.address, [])).to.be.revertedWith(
        "Initializable: contract is already initialized"
      );
    });
  });

  describe("setAdapter", () => {
    it("emits AdapterUpdated and routes subsequent ops through the new adapter", async () => {
      const poolB = await new MockAavePool__factory(deployer).deploy();
      await poolB.deployed();
      const adapterB = await new AaveV3Adapter__factory(deployer).deploy(poolB.address);
      await adapterB.deployed();

      await expect(plugin.connect(voter).setAdapter(adapterB.address))
        .to.emit(plugin, "AdapterUpdated")
        .withArgs(adapter.address, adapterB.address);
      expect(await plugin.adapter()).to.equal(adapterB.address);

      // Operations now route through `poolB`.
      await usdc.mint(dao.address, 1000);
      await plugin.connect(voter).supply(usdc.address, 500);
      expect(await poolB.aTokenBalance(dao.address, usdc.address)).to.equal(500);
      expect(await pool.aTokenBalance(dao.address, usdc.address)).to.equal(0);
    });

    it("rejects zero address", async () => {
      await expect(
        plugin.connect(voter).setAdapter(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(plugin, "ZeroAddress");
    });

    it("reverts when caller lacks UPDATE_ADAPTER_PERMISSION", async () => {
      const poolB = await new MockAavePool__factory(deployer).deploy();
      const adapterB = await new AaveV3Adapter__factory(deployer).deploy(poolB.address);
      await expect(plugin.connect(stranger).setAdapter(adapterB.address)).to.be.reverted;
    });
  });

  describe("setAllowedAsset", () => {
    it("first add flips allowlistEnforced=true and emits", async () => {
      expect(await plugin.allowlistEnforced()).to.equal(false);
      await expect(plugin.connect(voter).setAllowedAsset(usdc.address, true))
        .to.emit(plugin, "AllowedAssetSet")
        .withArgs(usdc.address, true);
      expect(await plugin.allowlistEnforced()).to.equal(true);
      expect(await plugin.allowedAsset(usdc.address)).to.equal(true);
    });

    it("subsequent additions/removals do not toggle enforcement off", async () => {
      await plugin.connect(voter).setAllowedAsset(usdc.address, true);
      await plugin.connect(voter).setAllowedAsset(weth.address, true);
      expect(await plugin.allowlistEnforced()).to.equal(true);

      await plugin.connect(voter).setAllowedAsset(usdc.address, false);
      await plugin.connect(voter).setAllowedAsset(weth.address, false);
      expect(await plugin.allowlistEnforced()).to.equal(true);
      expect(await plugin.allowedAsset(usdc.address)).to.equal(false);
    });

    it("reverts when caller lacks MANAGE_ALLOWLIST_PERMISSION", async () => {
      await expect(plugin.connect(stranger).setAllowedAsset(usdc.address, true)).to.be.reverted;
    });
  });

  describe("permission gating on lending mutators", () => {
    it("supply, withdraw, borrow, repay all revert for unauthorized callers", async () => {
      await expect(plugin.connect(stranger).supply(usdc.address, 1)).to.be.reverted;
      await expect(plugin.connect(stranger).withdraw(usdc.address, 1)).to.be.reverted;
      await expect(plugin.connect(stranger).borrow(usdc.address, 1, VARIABLE_RATE)).to.be.reverted;
      await expect(plugin.connect(stranger).repay(usdc.address, 1, VARIABLE_RATE)).to.be.reverted;
    });
  });

  describe("allowlist enforcement on mutators", () => {
    beforeEach(async () => {
      // Enable enforcement; allow only USDC. WETH is denied.
      await plugin.connect(voter).setAllowedAsset(usdc.address, true);
    });

    it("supply reverts AssetNotAllowed for unlisted asset", async () => {
      await expect(plugin.connect(voter).supply(weth.address, 1))
        .to.be.revertedWithCustomError(plugin, "AssetNotAllowed")
        .withArgs(weth.address);
    });

    it("withdraw reverts AssetNotAllowed for unlisted asset", async () => {
      await expect(plugin.connect(voter).withdraw(weth.address, 1))
        .to.be.revertedWithCustomError(plugin, "AssetNotAllowed")
        .withArgs(weth.address);
    });

    it("borrow reverts AssetNotAllowed for unlisted asset", async () => {
      await expect(plugin.connect(voter).borrow(weth.address, 1, VARIABLE_RATE))
        .to.be.revertedWithCustomError(plugin, "AssetNotAllowed")
        .withArgs(weth.address);
    });

    it("repay reverts AssetNotAllowed for unlisted asset", async () => {
      await expect(plugin.connect(voter).repay(weth.address, 1, VARIABLE_RATE))
        .to.be.revertedWithCustomError(plugin, "AssetNotAllowed")
        .withArgs(weth.address);
    });
  });

  describe("supply", () => {
    it("DAO approves the pool, pool pulls funds, DAO gets aTokens", async () => {
      const amount = ethers.utils.parseUnits("1000", 6);
      await usdc.mint(dao.address, amount);

      await expect(plugin.connect(voter).supply(usdc.address, amount))
        .to.emit(plugin, "Supplied")
        .withArgs(usdc.address, amount);

      // DAO's USDC moved into the pool.
      expect(await usdc.balanceOf(dao.address)).to.equal(0);
      expect(await usdc.balanceOf(pool.address)).to.equal(amount);
      // DAO holds the aToken-equivalent claim (onBehalfOf = dao).
      expect(await pool.aTokenBalance(dao.address, usdc.address)).to.equal(amount);
      // The plugin never custodies.
      expect(await usdc.balanceOf(plugin.address)).to.equal(0);
      expect(await usdc.balanceOf(adapter.address)).to.equal(0);
      // Exact-amount approval fully consumed inside the same execute call.
      expect(await usdc.allowance(dao.address, pool.address)).to.equal(0);
    });

    it("opNonce increments per successful operation", async () => {
      await usdc.mint(dao.address, 100);
      expect(await plugin.opNonce()).to.equal(0);

      await plugin.connect(voter).supply(usdc.address, 10);
      expect(await plugin.opNonce()).to.equal(1);

      await plugin.connect(voter).supply(usdc.address, 10);
      expect(await plugin.opNonce()).to.equal(2);
    });
  });

  describe("withdraw", () => {
    it("burns aTokens, returns underlying to DAO, emits with actual received", async () => {
      const amount = ethers.utils.parseUnits("1000", 6);
      await usdc.mint(dao.address, amount);
      await plugin.connect(voter).supply(usdc.address, amount);

      expect(await usdc.balanceOf(dao.address)).to.equal(0);
      expect(await pool.aTokenBalance(dao.address, usdc.address)).to.equal(amount);

      const half = amount.div(2);
      await expect(plugin.connect(voter).withdraw(usdc.address, half))
        .to.emit(plugin, "Withdrawn")
        .withArgs(usdc.address, half, half);

      expect(await usdc.balanceOf(dao.address)).to.equal(half);
      expect(await pool.aTokenBalance(dao.address, usdc.address)).to.equal(half);
    });

    it("surfaces the actual amount when the pool returns less than requested", async () => {
      const amount = ethers.utils.parseUnits("100", 6);
      await usdc.mint(dao.address, amount);
      await plugin.connect(voter).supply(usdc.address, amount);

      // Request more than supplied — mock caps at the DAO's aToken balance.
      const requested = amount.mul(5);
      await expect(plugin.connect(voter).withdraw(usdc.address, requested))
        .to.emit(plugin, "Withdrawn")
        .withArgs(usdc.address, requested, amount);

      expect(await usdc.balanceOf(dao.address)).to.equal(amount);
      expect(await pool.aTokenBalance(dao.address, usdc.address)).to.equal(0);
    });
  });

  describe("borrow", () => {
    it("pulls the borrowed asset into the DAO and tracks debt against the DAO", async () => {
      const amount = ethers.utils.parseUnits("500", 6);
      // Keep the pool liquid so it can lend.
      await usdc.mint(pool.address, amount.mul(10));

      await expect(plugin.connect(voter).borrow(usdc.address, amount, VARIABLE_RATE))
        .to.emit(plugin, "Borrowed")
        .withArgs(usdc.address, amount, VARIABLE_RATE);

      expect(await usdc.balanceOf(dao.address)).to.equal(amount);
      // Debt is keyed by the DAO (msg.sender at the pool), NOT the adapter.
      expect(await pool.debt(dao.address, usdc.address, VARIABLE_RATE)).to.equal(amount);
      expect(await pool.debt(dao.address, usdc.address, STABLE_RATE)).to.equal(0);
    });
  });

  describe("repay", () => {
    it("burns debt, drains DAO balance by the actual paid amount, zeroes allowance", async () => {
      const amount = ethers.utils.parseUnits("500", 6);
      await usdc.mint(pool.address, amount.mul(2));
      await plugin.connect(voter).borrow(usdc.address, amount, VARIABLE_RATE);

      const half = amount.div(2);
      await expect(plugin.connect(voter).repay(usdc.address, half, VARIABLE_RATE))
        .to.emit(plugin, "Repaid")
        .withArgs(usdc.address, half, VARIABLE_RATE, half);

      expect(await pool.debt(dao.address, usdc.address, VARIABLE_RATE)).to.equal(half);
      expect(await usdc.balanceOf(dao.address)).to.equal(half); // started at `amount`, paid `half`
      expect(await usdc.allowance(dao.address, pool.address)).to.equal(0);
    });

    it("caps `paid` at outstanding debt when caller over-pays, leaving zero residual allowance", async () => {
      const amount = ethers.utils.parseUnits("100", 6);
      await usdc.mint(pool.address, amount);
      await plugin.connect(voter).borrow(usdc.address, amount, VARIABLE_RATE);

      // Mint extra USDC into the DAO so it CAN over-pay.
      await usdc.mint(dao.address, amount);

      // Repay 2x the debt. Pool pulls only `amount`; the 3rd action resets the
      // residual approval so allowance ends at zero.
      const requested = amount.mul(2);
      await expect(plugin.connect(voter).repay(usdc.address, requested, VARIABLE_RATE))
        .to.emit(plugin, "Repaid")
        .withArgs(usdc.address, requested, VARIABLE_RATE, amount);

      expect(await pool.debt(dao.address, usdc.address, VARIABLE_RATE)).to.equal(0);
      expect(await usdc.allowance(dao.address, pool.address)).to.equal(0);
    });
  });

  describe("adapter swap simulation (v3 ↔ v4 migration playbook)", () => {
    it("supply through pool A, swap adapter to pool B, prove A still holds the legacy position", async () => {
      const amount = ethers.utils.parseUnits("100", 6);

      await usdc.mint(dao.address, amount);
      await plugin.connect(voter).supply(usdc.address, amount);
      expect(await pool.aTokenBalance(dao.address, usdc.address)).to.equal(amount);

      // Vote-gated swap to a new adapter pointing at a different pool.
      const poolB = await new MockAavePool__factory(deployer).deploy();
      await poolB.deployed();
      const adapterB = await new AaveV3Adapter__factory(deployer).deploy(poolB.address);
      await adapterB.deployed();
      await plugin.connect(voter).setAdapter(adapterB.address);

      // New supply lands in pool B.
      const more = ethers.utils.parseUnits("50", 6);
      await usdc.mint(dao.address, more);
      await plugin.connect(voter).supply(usdc.address, more);
      expect(await poolB.aTokenBalance(dao.address, usdc.address)).to.equal(more);

      // Legacy position still readable on pool A — unchanged.
      expect(await pool.aTokenBalance(dao.address, usdc.address)).to.equal(amount);
    });
  });
});

describe("AaveV3Adapter (calldata builder)", () => {
  let deployer: Signer;
  let pool: MockAavePool;
  let v3: AaveV3Adapter;
  let snapshot: SnapshotRestorer;

  const asset = ethers.Wallet.createRandom().address;
  const onBehalfOf = ethers.Wallet.createRandom().address;
  const amount = ethers.utils.parseUnits("123", 6);

  afterEach(async () => {
    if (snapshot) await snapshot.restore();
  });

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();
    pool = await new MockAavePool__factory(deployer).deploy();
    await pool.deployed();
    v3 = await new AaveV3Adapter__factory(deployer).deploy(pool.address);
    await v3.deployed();
    snapshot = await takeSnapshot();
  });

  it("poolAddress() and POOL both return the constructor pool", async () => {
    expect(await v3.poolAddress()).to.equal(pool.address);
    expect(await v3.POOL()).to.equal(pool.address);
  });

  it("encodeSupply matches pool.supply(asset, amount, onBehalfOf, 0)", async () => {
    const expected = POOL_IFACE.encodeFunctionData("supply", [asset, amount, onBehalfOf, 0]);
    expect(await v3.encodeSupply(asset, amount, onBehalfOf)).to.equal(expected);
  });

  it("encodeWithdraw matches pool.withdraw(asset, amount, to)", async () => {
    const expected = POOL_IFACE.encodeFunctionData("withdraw", [asset, amount, onBehalfOf]);
    expect(await v3.encodeWithdraw(asset, amount, onBehalfOf)).to.equal(expected);
  });

  it("encodeBorrow matches pool.borrow(asset, amount, mode, 0, onBehalfOf)", async () => {
    const expected = POOL_IFACE.encodeFunctionData("borrow", [asset, amount, 2, 0, onBehalfOf]);
    expect(await v3.encodeBorrow(asset, amount, 2, onBehalfOf)).to.equal(expected);
  });

  it("encodeRepay matches pool.repay(asset, amount, mode, onBehalfOf)", async () => {
    const expected = POOL_IFACE.encodeFunctionData("repay", [asset, amount, 2, onBehalfOf]);
    expect(await v3.encodeRepay(asset, amount, 2, onBehalfOf)).to.equal(expected);
  });
});

describe("AaveV4Adapter (stub)", () => {
  let deployer: Signer;
  let stub: AaveV4Adapter;

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();
    stub = await new AaveV4Adapter__factory(deployer).deploy();
    await stub.deployed();
  });

  it("every function reverts NotImplemented", async () => {
    const someAsset = ethers.Wallet.createRandom().address;
    const someAddr = ethers.Wallet.createRandom().address;

    await expect(stub.poolAddress()).to.be.revertedWithCustomError(stub, "NotImplemented");
    await expect(stub.encodeSupply(someAsset, 1, someAddr)).to.be.revertedWithCustomError(
      stub,
      "NotImplemented"
    );
    await expect(stub.encodeWithdraw(someAsset, 1, someAddr)).to.be.revertedWithCustomError(
      stub,
      "NotImplemented"
    );
    await expect(
      stub.encodeBorrow(someAsset, 1, VARIABLE_RATE, someAddr)
    ).to.be.revertedWithCustomError(stub, "NotImplemented");
    await expect(
      stub.encodeRepay(someAsset, 1, VARIABLE_RATE, someAddr)
    ).to.be.revertedWithCustomError(stub, "NotImplemented");
  });
});
