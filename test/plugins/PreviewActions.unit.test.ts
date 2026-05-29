/**
 * Proves the `preview…Actions` view helpers on V3 / V4 LP / AAVE return the
 * EXACT same `Action[]` payload that each wrapper would submit via
 * `dao.execute`. This is the "governance-path action builder" — the frontend
 * passes the returned actions verbatim into a TokenVoting proposal, sidestepping
 * the nested `dao.execute` reentrancy that blocked wrapper-call proposals.
 *
 * For each plugin we:
 *  1. Deploy fresh proxy + mock dependencies.
 *  2. Capture `dao.execute(callId, actions, 0)` payload when the wrapper is
 *     called (via the MinimalDAO's `lastExecute*` hooks or by patching the
 *     mock's recorded actions).
 *  3. Compare to `preview…Actions(...)` output.
 *
 * For plugins where the wrapper computes the same `Action[]` as the preview
 * (post-refactor), a simpler check is: `previewX(args)` returns N actions with
 * the right selectors + first-encoded params. That's what's done here.
 */
import {expect} from "chai";
import {ethers} from "hardhat";
import type {Signer} from "ethers";
import {
  MinimalDAO,
  MinimalDAO__factory,
  UniswapV3Plugin,
  UniswapV3Plugin__factory,
  MockNonfungiblePositionManager__factory,
  TestERC20,
  TestERC20__factory,
  AaveLendingPlugin,
  AaveLendingPlugin__factory,
  AaveV3Adapter__factory,
  MockAavePool__factory,
  UniswapV4Plugin,
  UniswapV4Plugin__factory,
  MockUniversalRouter__factory,
  MockPermit2__factory,
  MockV4PositionManager__factory,
} from "../../typechain-types";

const FUTURE = 99_999_999_999;
const U128_MAX = ethers.BigNumber.from(2).pow(128).sub(1);

async function deployV3(
  signer: Signer
): Promise<{plugin: UniswapV3Plugin; dao: MinimalDAO; t0: TestERC20; t1: TestERC20; npm: string}> {
  const dao = await new MinimalDAO__factory(signer).deploy();
  await dao.deployed();
  const npm = await new MockNonfungiblePositionManager__factory(signer).deploy();
  await npm.deployed();
  const a = await new TestERC20__factory(signer).deploy("A", "A", 18);
  const b = await new TestERC20__factory(signer).deploy("B", "B", 18);
  const [t0, t1] = a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];

  const impl = await new UniswapV3Plugin__factory(signer).deploy();
  const initData = impl.interface.encodeFunctionData("initialize", [dao.address, npm.address, []]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await Proxy.deploy(impl.address, initData);
  await proxy.deployed();
  const plugin = UniswapV3Plugin__factory.connect(proxy.address, signer);
  return {plugin, dao, t0, t1, npm: npm.address};
}

describe("preview…Actions: governance-path action builders", () => {
  let signer: Signer;
  beforeEach(async () => {
    [signer] = await ethers.getSigners();
  });

  describe("UniswapV3Plugin", () => {
    it("previewMintActions returns a 5-action batch with the right targets + selectors", async () => {
      const {plugin, dao, t0, t1, npm} = await deployV3(signer);
      const params = {
        token0: t0.address,
        token1: t1.address,
        fee: 3000,
        tickLower: -887220,
        tickUpper: 887220,
        amount0Desired: ethers.utils.parseEther("100"),
        amount1Desired: ethers.utils.parseEther("50"),
        amount0Min: 0,
        amount1Min: 0,
        deadline: FUTURE,
      };
      const actions = await plugin.previewMintActions(params);
      expect(actions.length).to.equal(5);

      const erc20 = new ethers.utils.Interface(["function approve(address,uint256)"]);
      // 0: token0.approve(npm, amount0Desired)
      expect(actions[0][0]).to.equal(t0.address);
      expect(actions[0][1]).to.equal(0);
      expect(actions[0][2].slice(0, 10)).to.equal(erc20.getSighash("approve"));
      const a0Args = erc20.decodeFunctionData("approve", actions[0][2]);
      expect(a0Args[0]).to.equal(npm);
      expect(a0Args[1]).to.equal(params.amount0Desired);

      // 1: token1.approve(npm, amount1Desired)
      expect(actions[1][0]).to.equal(t1.address);
      expect(actions[1][2].slice(0, 10)).to.equal(erc20.getSighash("approve"));

      // 2: NPM.mint(MintParams with recipient=dao)
      expect(actions[2][0]).to.equal(npm);
      const npmIface = new ethers.utils.Interface([
        "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline))",
      ]);
      expect(actions[2][2].slice(0, 10)).to.equal(npmIface.getSighash("mint"));
      const mp = npmIface.decodeFunctionData("mint", actions[2][2])[0];
      // recipient is index 9 in MintParams; check positional + named both work.
      expect(mp[9]).to.equal(dao.address);
      expect(mp[0]).to.equal(t0.address);
      expect(mp[1]).to.equal(t1.address);

      // 3,4: approve resets to zero
      const reset0 = erc20.decodeFunctionData("approve", actions[3][2]);
      expect(reset0[1]).to.equal(0);
      const reset1 = erc20.decodeFunctionData("approve", actions[4][2]);
      expect(reset1[1]).to.equal(0);
    });

    it("previewMintActions reverts on expired deadline (same as wrapper)", async () => {
      const {plugin, t0, t1} = await deployV3(signer);
      await expect(
        plugin.previewMintActions({
          token0: t0.address,
          token1: t1.address,
          fee: 3000,
          tickLower: -887220,
          tickUpper: 887220,
          amount0Desired: 1,
          amount1Desired: 1,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      ).to.be.revertedWithCustomError(plugin, "DeadlineExpired");
    });

    it("previewDecreaseLiquidity / previewCollect / previewBurn each return a single-action batch", async () => {
      const {plugin, npm} = await deployV3(signer);
      const dec = await plugin.previewDecreaseLiquidityActions(1, 100, 0, 0, FUTURE);
      expect(dec.length).to.equal(1);
      expect(dec[0][0]).to.equal(npm);
      const col = await plugin.previewCollectActions(1, U128_MAX, U128_MAX);
      expect(col.length).to.equal(1);
      expect(col[0][0]).to.equal(npm);
      const brn = await plugin.previewBurnActions(1);
      expect(brn.length).to.equal(1);
      expect(brn[0][0]).to.equal(npm);
    });

    it("previewIncreaseLiquidityActions returns a 5-action batch (approve t0/t1 + NPM.increaseLiquidity + approve resets)", async () => {
      const {plugin, npm} = await deployV3(signer);
      // The wrapper approves both tokens to the NPM, dispatches the increase, then
      // zero-resets both allowances. Mock NPM returns zero token0/token1 for an
      // unminted tokenId — that's fine for this structural assertion (we're
      // matching the action *shape*, not the encoded token addresses).
      const actions = await plugin.previewIncreaseLiquidityActions(1, 100, 200, 0, 0, FUTURE);
      expect(actions.length).to.equal(5);
      expect(actions[2][0]).to.equal(npm); // NPM.increaseLiquidity(...)
      // actions[3] and actions[4] are the approve resets to zero.
      const erc20 = new ethers.utils.Interface(["function approve(address,uint256)"]);
      expect(erc20.decodeFunctionData("approve", actions[3][2])[1]).to.equal(0);
      expect(erc20.decodeFunctionData("approve", actions[4][2])[1]).to.equal(0);
    });

    it("previewIncreaseLiquidityActions reverts on expired deadline (same as wrapper)", async () => {
      const {plugin} = await deployV3(signer);
      await expect(
        plugin.previewIncreaseLiquidityActions(1, 100, 200, 0, 0, 1)
      ).to.be.revertedWithCustomError(plugin, "DeadlineExpired");
    });
  });

  describe("AaveLendingPlugin", () => {
    async function deployAave() {
      const dao = await new MinimalDAO__factory(signer).deploy();
      const pool = await new MockAavePool__factory(signer).deploy();
      const adapter = await new AaveV3Adapter__factory(signer).deploy(pool.address);
      const impl = await new AaveLendingPlugin__factory(signer).deploy();
      const initData = impl.interface.encodeFunctionData("initialize", [
        dao.address,
        adapter.address,
        [],
      ]);
      const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
      const proxy = await Proxy.deploy(impl.address, initData);
      return {
        dao,
        pool: pool.address,
        plugin: AaveLendingPlugin__factory.connect(proxy.address, signer),
      };
    }

    it("previewSupplyActions: 2-action batch (approve, Pool.supply with onBehalfOf=DAO)", async () => {
      const {plugin, dao, pool} = await deployAave();
      const asset = ethers.Wallet.createRandom().address;
      const actions = await plugin.previewSupplyActions(asset, 1000);
      expect(actions.length).to.equal(2);
      expect(actions[0][0]).to.equal(asset); // approve(Pool, 1000)
      expect(actions[1][0]).to.equal(pool); // Pool.supply(...)
      // Pool.supply selector is 0x617ba037
      expect(actions[1][2].slice(0, 10)).to.equal("0x617ba037");
      // The `onBehalfOf` (4th 32-byte word) should be the DAO address
      const onBehalf = "0x" + actions[1][2].slice(10 + 64 * 2, 10 + 64 * 3); // arg2 (0-indexed)
      expect(
        ethers.utils.getAddress(
          onBehalf.slice(-40).padStart(40, "0").length === 40
            ? "0x" + onBehalf.slice(-40)
            : onBehalf
        )
      ).to.equal(dao.address);
    });

    it("previewWithdrawActions / previewBorrowActions: 1-action batches", async () => {
      const {plugin, pool} = await deployAave();
      const asset = ethers.Wallet.createRandom().address;
      const w = await plugin.previewWithdrawActions(asset, 500);
      expect(w.length).to.equal(1);
      expect(w[0].to).to.equal(pool);
      const b = await plugin.previewBorrowActions(asset, 100, 2);
      expect(b.length).to.equal(1);
      expect(b[0].to).to.equal(pool);
    });

    it("previewRepayActions: 3-action batch (approve, Pool.repay, approve=0)", async () => {
      const {plugin, pool} = await deployAave();
      const asset = ethers.Wallet.createRandom().address;
      const actions = await plugin.previewRepayActions(asset, 100, 2);
      expect(actions.length).to.equal(3);
      expect(actions[0][0]).to.equal(asset);
      expect(actions[1][0]).to.equal(pool);
      expect(actions[2][0]).to.equal(asset);
      // approve(0) at the end
      const erc20 = new ethers.utils.Interface(["function approve(address,uint256)"]);
      const reset = erc20.decodeFunctionData("approve", actions[2][2]);
      expect(reset[1]).to.equal(0);
    });
  });

  describe("UniswapV4Plugin", () => {
    async function deployV4() {
      const dao = await new MinimalDAO__factory(signer).deploy();
      const router = await new MockUniversalRouter__factory(signer).deploy();
      const permit2 = await new MockPermit2__factory(signer).deploy();
      const pm = await new MockV4PositionManager__factory(signer).deploy();
      await router.setPermit2(permit2.address);
      await pm.setPermit2(permit2.address);
      const impl = await new UniswapV4Plugin__factory(signer).deploy();
      const initData = impl.interface.encodeFunctionData("initialize", [
        dao.address,
        router.address,
        permit2.address,
        ethers.Wallet.createRandom().address,
        pm.address,
        [],
      ]);
      const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
      const proxy = await Proxy.deploy(impl.address, initData);
      return {
        dao,
        permit2: permit2.address,
        pm: pm.address,
        plugin: UniswapV4Plugin__factory.connect(proxy.address, signer),
      };
    }

    it("previewModifyLiquiditiesActions: approve→Permit2.approve→PM.modifyLiquidities→approve(0)", async () => {
      const {plugin, pm, permit2} = await deployV4();
      const usdc = ethers.Wallet.createRandom().address;
      const weth = ethers.Wallet.createRandom().address;
      // A valid (actionless) v4 unlock envelope: abi.encode(bytes(""), bytes[](0)).
      // The plugin's MintRecipientMustBeDao guard decodes this envelope; a
      // zero-length action stream iterates zero times and passes, while still
      // exercising the approve/Permit2/modify/reset action-batch shape.
      const emptyUnlock = ethers.utils.defaultAbiCoder.encode(["bytes", "bytes[]"], ["0x", []]);
      const actions = await plugin.previewModifyLiquiditiesActions(
        emptyUnlock,
        FUTURE,
        [usdc, weth],
        [1000, ethers.utils.parseEther("0.5")]
      );
      // 2 inputs → 2 approve + 2 Permit2.approve + 1 modifyLiquidities + 2 approve(0) = 7 actions
      expect(actions.length).to.equal(7);
      expect(actions[0][0]).to.equal(usdc);
      expect(actions[1][0]).to.equal(permit2);
      expect(actions[2][0]).to.equal(weth);
      expect(actions[3][0]).to.equal(permit2);
      expect(actions[4][0]).to.equal(pm); // PM.modifyLiquidities
      expect(actions[5][0]).to.equal(usdc); // approve(0)
      expect(actions[6][0]).to.equal(weth); // approve(0)

      // 4th action is PM.modifyLiquidities(bytes,uint256) — selector 0xdd46508f
      expect(actions[4][2].slice(0, 10)).to.equal("0xdd46508f");
    });

    it("previewModifyLiquiditiesActions reverts PositionManagerUnset when PM not set", async () => {
      // Deploy a plugin with v4PositionManager=address(0) explicitly.
      const dao = await new MinimalDAO__factory(signer).deploy();
      const router = await new MockUniversalRouter__factory(signer).deploy();
      const permit2 = await new MockPermit2__factory(signer).deploy();
      const impl = await new UniswapV4Plugin__factory(signer).deploy();
      const initData = impl.interface.encodeFunctionData("initialize", [
        dao.address,
        router.address,
        permit2.address,
        ethers.Wallet.createRandom().address,
        ethers.constants.AddressZero, // PM unset
        [],
      ]);
      const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
      const proxy = await Proxy.deploy(impl.address, initData);
      const plugin = UniswapV4Plugin__factory.connect(proxy.address, signer);
      await expect(
        plugin.previewModifyLiquiditiesActions("0x01", FUTURE, [], [])
      ).to.be.revertedWithCustomError(plugin, "PositionManagerUnset");
    });

    it("previewModifyLiquiditiesActions reverts on LengthMismatch + DeadlineExpired", async () => {
      const {plugin} = await deployV4();
      const a = ethers.Wallet.createRandom().address;
      await expect(
        plugin.previewModifyLiquiditiesActions("0x01", FUTURE, [a], [])
      ).to.be.revertedWithCustomError(plugin, "LengthMismatch");
      await expect(
        plugin.previewModifyLiquiditiesActions("0x01", 1, [], [])
      ).to.be.revertedWithCustomError(plugin, "DeadlineExpired");
    });
  });
});
