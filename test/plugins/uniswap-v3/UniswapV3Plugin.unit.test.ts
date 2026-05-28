import {expect} from "chai";
import {ethers} from "hardhat";
import type {BigNumber, Signer} from "ethers";
import {
  MinimalDAO,
  MinimalDAO__factory,
  UniswapV3Plugin,
  UniswapV3Plugin__factory,
  MockNonfungiblePositionManager,
  MockNonfungiblePositionManager__factory,
  TestERC20,
  TestERC20__factory,
} from "../../../typechain-types";

const MANAGE_POSITIONS_PERMISSION_ID = ethers.utils.id("MANAGE_POSITIONS_PERMISSION");
const UPDATE_POSITION_MANAGER_PERMISSION_ID = ethers.utils.id("UPDATE_POSITION_MANAGER_PERMISSION");
const MANAGE_ALLOWLIST_PERMISSION_ID = ethers.utils.id("MANAGE_ALLOWLIST_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");

const FEE = 3000;
const TICK_LOWER = -887220;
const TICK_UPPER = 887220;
const FUTURE = 99_999_999_999;
const U128_MAX = ethers.BigNumber.from(2).pow(128).sub(1);

async function deployProxied(
  signer: Signer,
  dao: string,
  npm: string,
  allowlist: string[]
): Promise<UniswapV3Plugin> {
  const impl = await new UniswapV3Plugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [dao, npm, allowlist]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await Proxy.deploy(impl.address, initData);
  await proxy.deployed();
  return UniswapV3Plugin__factory.connect(proxy.address, signer);
}

// MintParams tuple (no recipient — plugin forces dao).
function mintParams(token0: string, token1: string, a0: BigNumber, a1: BigNumber) {
  return {
    token0,
    token1,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired: a0,
    amount1Desired: a1,
    amount0Min: 0,
    amount1Min: 0,
    deadline: FUTURE,
  };
}

describe("UniswapV3Plugin", () => {
  let deployer: Signer;
  let voter: Signer;
  let stranger: Signer;
  let dao: MinimalDAO;
  let plugin: UniswapV3Plugin;
  let npm: MockNonfungiblePositionManager;
  let t0: TestERC20;
  let t1: TestERC20;

  const amt = (n: number) => ethers.utils.parseUnits(n.toString(), 18);

  beforeEach(async () => {
    [deployer, voter, stranger] = await ethers.getSigners();
    dao = await new MinimalDAO__factory(deployer).deploy();
    await dao.deployed();
    npm = await new MockNonfungiblePositionManager__factory(deployer).deploy();
    await npm.deployed();

    // Two tokens; order so t0 < t1 by address (mirrors V3's token ordering).
    const a = await new TestERC20__factory(deployer).deploy("A", "A", 18);
    const b = await new TestERC20__factory(deployer).deploy("B", "B", 18);
    [t0, t1] = a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];

    plugin = await deployProxied(deployer, dao.address, npm.address, []);
    await dao.grant(plugin.address, await voter.getAddress(), MANAGE_POSITIONS_PERMISSION_ID);
    await dao.grant(
      plugin.address,
      await voter.getAddress(),
      UPDATE_POSITION_MANAGER_PERMISSION_ID
    );
    await dao.grant(plugin.address, await voter.getAddress(), MANAGE_ALLOWLIST_PERMISSION_ID);
    await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);

    // Fund the DAO with both tokens.
    await t0.mint(dao.address, amt(10_000));
    await t1.mint(dao.address, amt(10_000));
  });

  describe("initialize", () => {
    it("sets positionManager; rejects zero", async () => {
      expect(await plugin.positionManager()).to.equal(npm.address);
      expect(await plugin.allowlistEnforced()).to.equal(false);
      expect(await plugin.opNonce()).to.equal(0);

      const impl = await new UniswapV3Plugin__factory(deployer).deploy();
      const Proxy = await ethers.getContractFactory("ERC1967Proxy", deployer);
      const bad = impl.interface.encodeFunctionData("initialize", [
        dao.address,
        ethers.constants.AddressZero,
        [],
      ]);
      await expect(Proxy.deploy(impl.address, bad)).to.be.revertedWithCustomError(
        plugin,
        "ZeroAddress"
      );
    });

    it("cannot be initialized twice", async () => {
      await expect(plugin.initialize(dao.address, npm.address, [])).to.be.revertedWith(
        "Initializable: contract is already initialized"
      );
    });
  });

  describe("mint", () => {
    it("mints a DAO-owned position, pulls DAO tokens, emits tokenId", async () => {
      const daoT0Before = await t0.balanceOf(dao.address);
      const tx = await plugin
        .connect(voter)
        .mint(mintParams(t0.address, t1.address, amt(100), amt(50)));
      await expect(tx).to.emit(plugin, "PositionMinted");

      // tokenId 1 minted to the DAO.
      expect(await npm.ownerOf(1)).to.equal(dao.address);
      // DAO funded the position; plugin custodies nothing.
      expect(await t0.balanceOf(dao.address)).to.equal(daoT0Before.sub(amt(100)));
      expect(await t0.balanceOf(plugin.address)).to.equal(0);
      expect(await t1.balanceOf(plugin.address)).to.equal(0);
      // approvals reset to zero (no residual DAO→NPM allowance).
      expect(await t0.allowance(dao.address, npm.address)).to.equal(0);
      expect(await t1.allowance(dao.address, npm.address)).to.equal(0);

      const pos = await npm.positions(1);
      expect(pos.liquidity).to.equal(amt(150));
      expect(await plugin.opNonce()).to.equal(1);
    });

    it("reverts DeadlineExpired when deadline has passed", async () => {
      const p = mintParams(t0.address, t1.address, amt(1), amt(1));
      p.deadline = 1; // in the past
      await expect(plugin.connect(voter).mint(p)).to.be.revertedWithCustomError(
        plugin,
        "DeadlineExpired"
      );
    });

    it("reverts when caller lacks MANAGE_POSITIONS", async () => {
      await expect(
        plugin.connect(stranger).mint(mintParams(t0.address, t1.address, amt(1), amt(1)))
      ).to.be.reverted;
    });
  });

  describe("lifecycle: increase / decrease / collect / burn", () => {
    beforeEach(async () => {
      await plugin.connect(voter).mint(mintParams(t0.address, t1.address, amt(100), amt(100)));
    });

    it("increaseLiquidity adds to the position and pulls DAO tokens", async () => {
      const tx = await plugin.connect(voter).increaseLiquidity(1, amt(50), amt(50), 0, 0, FUTURE);
      await expect(tx).to.emit(plugin, "LiquidityIncreased");
      expect((await npm.positions(1)).liquidity).to.equal(amt(300)); // 200 + 100
      expect(await t0.allowance(dao.address, npm.address)).to.equal(0);
    });

    it("decreaseLiquidity then collect returns tokens to the DAO", async () => {
      await expect(plugin.connect(voter).decreaseLiquidity(1, amt(100), 0, 0, FUTURE)).to.emit(
        plugin,
        "LiquidityDecreased"
      );
      // Half the liquidity removed → owed tokens accrue on the position.
      const pos = await npm.positions(1);
      expect(pos.liquidity).to.equal(amt(100));
      expect(pos.tokensOwed0).to.equal(amt(50));
      expect(pos.tokensOwed1).to.equal(amt(50));

      const daoT0Before = await t0.balanceOf(dao.address);
      await expect(plugin.connect(voter).collect(1, U128_MAX, U128_MAX)).to.emit(
        plugin,
        "FeesCollected"
      );
      // Collected tokens landed in the DAO (recipient forced to dao).
      expect(await t0.balanceOf(dao.address)).to.equal(daoT0Before.add(amt(50)));
      expect(await t0.balanceOf(plugin.address)).to.equal(0);
    });

    it("burn after fully clearing the position", async () => {
      await plugin
        .connect(voter)
        .decreaseLiquidity(1, (await npm.positions(1)).liquidity, 0, 0, FUTURE);
      await plugin.connect(voter).collect(1, U128_MAX, U128_MAX);
      await expect(plugin.connect(voter).burn(1)).to.emit(plugin, "PositionBurned").withArgs(1);
      expect(await npm.ownerOf(1)).to.equal(ethers.constants.AddressZero);
    });

    it("increaseLiquidity reverts DeadlineExpired in the past", async () => {
      await expect(
        plugin.connect(voter).increaseLiquidity(1, amt(1), amt(1), 0, 0, 1)
      ).to.be.revertedWithCustomError(plugin, "DeadlineExpired");
    });

    it("decreaseLiquidity reverts DeadlineExpired in the past", async () => {
      await expect(
        plugin.connect(voter).decreaseLiquidity(1, amt(1), 0, 0, 1)
      ).to.be.revertedWithCustomError(plugin, "DeadlineExpired");
    });

    it("gates collect + burn on MANAGE_POSITIONS", async () => {
      await expect(plugin.connect(stranger).collect(1, 1, 1)).to.be.reverted;
      await expect(plugin.connect(stranger).burn(1)).to.be.reverted;
    });
  });

  describe("allowlist", () => {
    it("blocks minting a non-allowed token once enforced", async () => {
      await plugin.connect(voter).setAllowedToken(t0.address, true); // flips enforcement on
      expect(await plugin.allowlistEnforced()).to.equal(true);
      // t1 not allowed → revert
      await expect(plugin.connect(voter).mint(mintParams(t0.address, t1.address, amt(1), amt(1))))
        .to.be.revertedWithCustomError(plugin, "TokenNotAllowed")
        .withArgs(t1.address);
      // allow t1 → mint passes
      await plugin.connect(voter).setAllowedToken(t1.address, true);
      await expect(
        plugin.connect(voter).mint(mintParams(t0.address, t1.address, amt(1), amt(1)))
      ).to.emit(plugin, "PositionMinted");
    });

    it("setAllowedToken gated on MANAGE_ALLOWLIST", async () => {
      await expect(plugin.connect(stranger).setAllowedToken(t0.address, true)).to.be.reverted;
    });

    it("setAllowedToken emits AllowedTokenSet + flips the allowedToken getter", async () => {
      // Add then revoke; assert event payload + getter on each transition.
      expect(await plugin.allowedToken(t0.address)).to.equal(false);
      await expect(plugin.connect(voter).setAllowedToken(t0.address, true))
        .to.emit(plugin, "AllowedTokenSet")
        .withArgs(t0.address, true);
      expect(await plugin.allowedToken(t0.address)).to.equal(true);
      await expect(plugin.connect(voter).setAllowedToken(t0.address, false))
        .to.emit(plugin, "AllowedTokenSet")
        .withArgs(t0.address, false);
      expect(await plugin.allowedToken(t0.address)).to.equal(false);
    });
  });

  describe("setPositionManager", () => {
    it("updates and emits; rejects zero + unauthorized", async () => {
      const next = ethers.Wallet.createRandom().address;
      await expect(plugin.connect(voter).setPositionManager(next))
        .to.emit(plugin, "PositionManagerUpdated")
        .withArgs(npm.address, next);
      expect(await plugin.positionManager()).to.equal(next);

      await expect(
        plugin.connect(voter).setPositionManager(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(plugin, "ZeroAddress");
      await expect(plugin.connect(stranger).setPositionManager(next)).to.be.reverted;
    });
  });
});
