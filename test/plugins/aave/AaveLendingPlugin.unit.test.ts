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
  MockAaveAdapter,
  MockAaveAdapter__factory,
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
  let adapter: MockAaveAdapter;
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

    adapter = await new MockAaveAdapter__factory(deployer).deploy();
    await adapter.deployed();

    plugin = await deployProxied(deployer, dao.address, adapter.address, []);

    // Vote-gated callers = `voter` (proxies for "calls coming via DAO.execute").
    await dao.grant(plugin.address, await voter.getAddress(), TRIGGER_LENDING_PERMISSION_ID);
    await dao.grant(plugin.address, await voter.getAddress(), UPDATE_ADAPTER_PERMISSION_ID);
    await dao.grant(plugin.address, await voter.getAddress(), MANAGE_ALLOWLIST_PERMISSION_ID);
    // Plugin needs EXECUTE on DAO so it can issue approve+adapter actions.
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
      // Custom errors thrown from inside the proxy constructor bubble up as
      // raw data; matching by selector via `revertedWithCustomError` works
      // here because the impl ABI we attach to declares ZeroAddress.
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
      // Untracked asset stays false.
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
      const newAdapter = await new MockAaveAdapter__factory(deployer).deploy();
      await newAdapter.deployed();

      await expect(plugin.connect(voter).setAdapter(newAdapter.address))
        .to.emit(plugin, "AdapterUpdated")
        .withArgs(adapter.address, newAdapter.address);
      expect(await plugin.adapter()).to.equal(newAdapter.address);

      // Operations now route through `newAdapter`.
      await usdc.mint(dao.address, 1000);
      await plugin.connect(voter).supply(usdc.address, 500);
      expect(await newAdapter.aTokenBalance(dao.address, usdc.address)).to.equal(500);
      expect(await adapter.aTokenBalance(dao.address, usdc.address)).to.equal(0);
    });

    it("rejects zero address", async () => {
      await expect(
        plugin.connect(voter).setAdapter(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(plugin, "ZeroAddress");
    });

    it("reverts when caller lacks UPDATE_ADAPTER_PERMISSION", async () => {
      const newAdapter = await new MockAaveAdapter__factory(deployer).deploy();
      await expect(plugin.connect(stranger).setAdapter(newAdapter.address)).to.be.reverted;
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

      // Removing every entry does NOT disable enforcement — by design.
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
    it("DAO funds the adapter via approve+transferFrom and gets aTokens", async () => {
      const amount = ethers.utils.parseUnits("1000", 6);
      await usdc.mint(dao.address, amount);

      await expect(plugin.connect(voter).supply(usdc.address, amount))
        .to.emit(plugin, "Supplied")
        .withArgs(usdc.address, amount);

      // DAO's USDC moved into the adapter (the "pool").
      expect(await usdc.balanceOf(dao.address)).to.equal(0);
      expect(await usdc.balanceOf(adapter.address)).to.equal(amount);
      // DAO has the aToken-equivalent claim.
      expect(await adapter.aTokenBalance(dao.address, usdc.address)).to.equal(amount);

      // Allowance to the pool address was an exact-amount grant and got
      // fully consumed by the transferFrom inside the same execute call.
      expect(await usdc.allowance(dao.address, await adapter.poolAddress())).to.equal(0);
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

      // Pre-state.
      expect(await usdc.balanceOf(dao.address)).to.equal(0);
      expect(await adapter.aTokenBalance(dao.address, usdc.address)).to.equal(amount);

      const half = amount.div(2);
      await expect(plugin.connect(voter).withdraw(usdc.address, half))
        .to.emit(plugin, "Withdrawn")
        .withArgs(usdc.address, half, half);

      expect(await usdc.balanceOf(dao.address)).to.equal(half);
      expect(await adapter.aTokenBalance(dao.address, usdc.address)).to.equal(half);
    });

    it("surfaces the actual amount when the adapter returns less than requested", async () => {
      const amount = ethers.utils.parseUnits("100", 6);
      await usdc.mint(dao.address, amount);
      await plugin.connect(voter).supply(usdc.address, amount);

      // Request more than supplied — mock caps at the user's balance.
      const requested = amount.mul(5);
      await expect(plugin.connect(voter).withdraw(usdc.address, requested))
        .to.emit(plugin, "Withdrawn")
        .withArgs(usdc.address, requested, amount);

      expect(await usdc.balanceOf(dao.address)).to.equal(amount);
      expect(await adapter.aTokenBalance(dao.address, usdc.address)).to.equal(0);
    });
  });

  describe("borrow", () => {
    it("pulls the borrowed asset into the DAO and tracks debt", async () => {
      const amount = ethers.utils.parseUnits("500", 6);
      // Pre-fund the adapter so it has USDC to lend.
      await usdc.mint(adapter.address, amount.mul(10));

      await expect(plugin.connect(voter).borrow(usdc.address, amount, VARIABLE_RATE))
        .to.emit(plugin, "Borrowed")
        .withArgs(usdc.address, amount, VARIABLE_RATE);

      expect(await usdc.balanceOf(dao.address)).to.equal(amount);
      expect(await adapter.debt(dao.address, usdc.address, VARIABLE_RATE)).to.equal(amount);
      // Other rate modes untouched.
      expect(await adapter.debt(dao.address, usdc.address, STABLE_RATE)).to.equal(0);
    });
  });

  describe("repay", () => {
    it("burns debt, drains DAO balance by the actual paid amount", async () => {
      const amount = ethers.utils.parseUnits("500", 6);
      await usdc.mint(adapter.address, amount.mul(2));
      await plugin.connect(voter).borrow(usdc.address, amount, VARIABLE_RATE);

      // DAO now holds USDC and owes debt. Repay half.
      const half = amount.div(2);
      await expect(plugin.connect(voter).repay(usdc.address, half, VARIABLE_RATE))
        .to.emit(plugin, "Repaid")
        .withArgs(usdc.address, half, VARIABLE_RATE, half);

      expect(await adapter.debt(dao.address, usdc.address, VARIABLE_RATE)).to.equal(half);
      expect(await usdc.balanceOf(dao.address)).to.equal(half); // started at `amount`, paid `half`
      expect(await usdc.allowance(dao.address, await adapter.poolAddress())).to.equal(0);
    });

    it("caps `paid` at outstanding debt when caller over-pays", async () => {
      const amount = ethers.utils.parseUnits("100", 6);
      await usdc.mint(adapter.address, amount);
      await plugin.connect(voter).borrow(usdc.address, amount, VARIABLE_RATE);

      // Mint extra USDC into the DAO so it CAN over-pay.
      await usdc.mint(dao.address, amount);

      // Caller asks to repay 2x the debt. Mock returns `amount`, plugin records
      // `paid = before - after = amount` (the actual delta).
      const requested = amount.mul(2);
      await expect(plugin.connect(voter).repay(usdc.address, requested, VARIABLE_RATE))
        .to.emit(plugin, "Repaid")
        .withArgs(usdc.address, requested, VARIABLE_RATE, amount);

      expect(await adapter.debt(dao.address, usdc.address, VARIABLE_RATE)).to.equal(0);
    });
  });

  describe("adapter swap simulation (v3 ↔ v4 migration playbook)", () => {
    it("supply through A, swap to B, prove A still holds the legacy position", async () => {
      // Adapter A = the default `adapter` set in beforeEach.
      const adapterA = adapter;
      const amount = ethers.utils.parseUnits("100", 6);

      await usdc.mint(dao.address, amount);
      await plugin.connect(voter).supply(usdc.address, amount);
      expect(await adapterA.aTokenBalance(dao.address, usdc.address)).to.equal(amount);

      // Vote-gated swap to Adapter B.
      const adapterB = await new MockAaveAdapter__factory(deployer).deploy();
      await adapterB.deployed();
      await plugin.connect(voter).setAdapter(adapterB.address);

      // New supply lands in B.
      const more = ethers.utils.parseUnits("50", 6);
      await usdc.mint(dao.address, more);
      await plugin.connect(voter).supply(usdc.address, more);
      expect(await adapterB.aTokenBalance(dao.address, usdc.address)).to.equal(more);

      // Legacy position is still readable through A — unchanged.
      expect(await adapterA.aTokenBalance(dao.address, usdc.address)).to.equal(amount);
    });
  });
});

describe("AaveV3Adapter", () => {
  // Drive AaveV3Adapter against a MockAavePool that implements the v3
  // `IAavePool` shape (with the `referralCode` parameter the wrapper
  // hardcodes to 0). This exercises every line of the wrapper without
  // requiring a fork; the fork test then validates against the real Pool.
  let deployer: Signer;
  let user: Signer;
  let pool: MockAavePool;
  let v3: AaveV3Adapter;
  let usdc: TestERC20;
  let snapshot: SnapshotRestorer;

  afterEach(async () => {
    if (snapshot) await snapshot.restore();
  });

  beforeEach(async () => {
    [deployer, user] = await ethers.getSigners();
    pool = await new MockAavePool__factory(deployer).deploy();
    await pool.deployed();
    v3 = await new AaveV3Adapter__factory(deployer).deploy(pool.address);
    await v3.deployed();
    usdc = await new TestERC20__factory(deployer).deploy("USD Coin", "USDC", 6);
    await usdc.deployed();
    snapshot = await takeSnapshot();
  });

  it("poolAddress() and POOL both return the constructor pool", async () => {
    expect(await v3.poolAddress()).to.equal(pool.address);
    expect(await v3.POOL()).to.equal(pool.address);
  });

  it("supply forwards (asset, amount, onBehalfOf, referralCode=0) to the pool", async () => {
    // Approve flow: a user holds USDC, approves the adapter pool (== pool
    // in this construction), and calls v3.supply directly. AaveV3Adapter
    // is stateless — msg.sender on the inner pool call is the adapter,
    // which is what the wrapper relies on.
    //
    // The plugin's real flow has the DAO calling adapter.supply via the
    // execute() batch; the same call shape applies here.
    const amount = ethers.utils.parseUnits("100", 6);
    const userAddr = await user.getAddress();
    await usdc.mint(await deployer.getAddress(), amount);
    await usdc.connect(deployer).approve(v3.address, amount);

    // The adapter calls POOL.supply(asset, amount, onBehalfOf, 0). Since
    // the adapter is the msg.sender for the pool, the pool tries to pull
    // tokens from the adapter — so we approve+transfer to the adapter first.
    await usdc.transfer(v3.address, amount);
    // The adapter doesn't approve the pool itself (the plugin would in
    // production); we approve from the adapter address via impersonation.
    await ethers.provider.send("hardhat_impersonateAccount", [v3.address]);
    await ethers.provider.send("hardhat_setBalance", [
      v3.address,
      ethers.utils.hexValue(ethers.utils.parseEther("1")),
    ]);
    const adapterSigner = await ethers.getSigner(v3.address);
    await usdc.connect(adapterSigner).approve(pool.address, amount);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [v3.address]);

    await v3.connect(deployer).supply(usdc.address, amount, userAddr);

    const last = await pool.lastSupply();
    expect(last.asset).to.equal(usdc.address);
    expect(last.amount).to.equal(amount);
    expect(last.onBehalfOf).to.equal(userAddr);
    expect(last.referralCode).to.equal(0); // hardcoded by AaveV3Adapter
    expect(await pool.aTokenBalance(userAddr, usdc.address)).to.equal(amount);
  });

  it("withdraw forwards (asset, amount, to) and returns the actual withdrawn", async () => {
    // Seed: msg.sender on the pool will be the adapter, so credit the
    // adapter's aTokenBalance directly via a fake supply.
    const amount = ethers.utils.parseUnits("50", 6);
    await usdc.mint(pool.address, amount);
    // Impersonate the adapter to seed its aToken balance on the pool.
    await ethers.provider.send("hardhat_impersonateAccount", [v3.address]);
    await ethers.provider.send("hardhat_setBalance", [
      v3.address,
      ethers.utils.hexValue(ethers.utils.parseEther("1")),
    ]);
    // Use the pool's supply to credit the adapter as the depositor.
    await usdc.mint(v3.address, amount);
    const adapterSigner = await ethers.getSigner(v3.address);
    await usdc.connect(adapterSigner).approve(pool.address, amount);
    await pool.connect(adapterSigner).supply(usdc.address, amount, v3.address, 0);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [v3.address]);

    const userAddr = await user.getAddress();
    const tx = await v3.connect(deployer).callStatic.withdraw(usdc.address, amount, userAddr);
    expect(tx).to.equal(amount);
    await v3.connect(deployer).withdraw(usdc.address, amount, userAddr);
    expect(await usdc.balanceOf(userAddr)).to.equal(amount);
    expect(await pool.lastWithdrawTo()).to.equal(userAddr);
    expect(await pool.lastWithdrawAmount()).to.equal(amount);
  });

  it("borrow forwards (asset, amount, interestRateMode, referralCode=0, onBehalfOf)", async () => {
    const amount = ethers.utils.parseUnits("25", 6);
    const userAddr = await user.getAddress();
    // Pre-fund the pool so it has USDC to lend out.
    await usdc.mint(pool.address, amount);

    await v3.connect(deployer).borrow(usdc.address, amount, 2, userAddr);

    const last = await pool.lastBorrow();
    expect(last.asset).to.equal(usdc.address);
    expect(last.amount).to.equal(amount);
    expect(last.interestRateMode).to.equal(2);
    expect(last.referralCode).to.equal(0); // hardcoded by AaveV3Adapter
    expect(last.onBehalfOf).to.equal(userAddr);
    expect(await usdc.balanceOf(userAddr)).to.equal(amount);
  });

  it("repay forwards (asset, amount, interestRateMode, onBehalfOf) and returns actual paid", async () => {
    const amount = ethers.utils.parseUnits("10", 6);
    const userAddr = await user.getAddress();

    // Seed debt against the adapter (the adapter is msg.sender on borrow).
    await usdc.mint(pool.address, amount);
    await v3.connect(deployer).borrow(usdc.address, amount, 2, userAddr);
    expect(await pool.debt(v3.address, usdc.address, 2)).to.equal(amount);

    // Caller (adapter) needs USDC + allowance to repay.
    await usdc.mint(v3.address, amount);
    await ethers.provider.send("hardhat_impersonateAccount", [v3.address]);
    await ethers.provider.send("hardhat_setBalance", [
      v3.address,
      ethers.utils.hexValue(ethers.utils.parseEther("1")),
    ]);
    const adapterSigner = await ethers.getSigner(v3.address);
    await usdc.connect(adapterSigner).approve(pool.address, amount);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [v3.address]);

    // repay() forwards onBehalfOf so the debt cleared belongs to userAddr's view;
    // however our mock keys debt by msg.sender (adapter). That's fine — the
    // wrapper-forwarding contract is what we're testing.
    const paid = await v3.connect(deployer).callStatic.repay(usdc.address, amount, 2, v3.address);
    expect(paid).to.equal(amount);
    await v3.connect(deployer).repay(usdc.address, amount, 2, v3.address);
    expect(await pool.lastRepayAmount()).to.equal(amount);
    expect(await pool.lastRepayOnBehalfOf()).to.equal(v3.address);
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
    await expect(stub.supply(someAsset, 1, someAddr)).to.be.revertedWithCustomError(
      stub,
      "NotImplemented"
    );
    await expect(stub.withdraw(someAsset, 1, someAddr)).to.be.revertedWithCustomError(
      stub,
      "NotImplemented"
    );
    await expect(stub.borrow(someAsset, 1, VARIABLE_RATE, someAddr)).to.be.revertedWithCustomError(
      stub,
      "NotImplemented"
    );
    await expect(stub.repay(someAsset, 1, VARIABLE_RATE, someAddr)).to.be.revertedWithCustomError(
      stub,
      "NotImplemented"
    );
  });
});
