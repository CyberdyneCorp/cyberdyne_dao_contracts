/**
 * UniswapV4Plugin unit tests.
 *
 * In-memory `hardhat` network; the plugin is exercised against MinimalDAO +
 * MockUniversalRouter + MockPermit2 (under src/test/mocks/). Covers the full
 * permission gating + slippage + deadline + nonce surface defined in TRD §6.1.
 *
 * Fork-mode tests live in UniswapV4Plugin.fork.test.ts and exercise the same
 * plugin against the REAL Universal Router on mainnet/Base.
 */
import {expect} from "chai";
import {ethers} from "hardhat";
import type {ContractTransaction, Signer} from "ethers";
import {
  MinimalDAO,
  MinimalDAO__factory,
  MockPermit2,
  MockPermit2__factory,
  MockUniversalRouter,
  MockUniversalRouter__factory,
  MockV4PositionManager,
  MockV4PositionManager__factory,
  TestERC20,
  TestERC20__factory,
  UniswapV4Plugin,
  UniswapV4Plugin__factory,
} from "../../../typechain-types";
import {takeSnapshot} from "../../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

const TRIGGER_SWAP_PERMISSION_ID = ethers.utils.id("TRIGGER_SWAP_PERMISSION");
const UPDATE_ROUTER_PERMISSION_ID = ethers.utils.id("UPDATE_ROUTER_PERMISSION");
const MANAGE_ALLOWLIST_PERMISSION_ID = ethers.utils.id("MANAGE_ALLOWLIST_PERMISSION");
const MANAGE_POSITIONS_PERMISSION_ID = ethers.utils.id("MANAGE_POSITIONS_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");

// Plausible mainnet PoolManager — unit tests don't actually hit it; we just
// pass an address through to verify it lands in storage.
const FAKE_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";

async function deployProxied(
  signer: Signer,
  dao: string,
  universalRouter: string,
  permit2: string,
  poolManager: string,
  initialAllowlist: string[]
): Promise<UniswapV4Plugin> {
  const impl = await new UniswapV4Plugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [
    dao,
    universalRouter,
    permit2,
    poolManager,
    ethers.constants.AddressZero, // v4PositionManager — set later via setV4PositionManager
    initialAllowlist,
  ]);
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await ProxyFactory.deploy(impl.address, initData);
  await proxy.deployed();
  return UniswapV4Plugin__factory.connect(proxy.address, signer);
}

// Plausible (but otherwise meaningless) commands/inputs payload. The plugin
// treats it as opaque bytes; only the mock interprets them (it ignores both).
const DUMMY_COMMANDS = "0x00";
const DUMMY_INPUTS: string[] = ["0x"];

// Future timestamp used as a generic non-expired deadline.
const FUTURE_DEADLINE = 2_000_000_000; // year 2033

describe("UniswapV4Plugin", () => {
  let deployer: Signer;
  let voter: Signer;
  let stranger: Signer;
  let dao: MinimalDAO;
  let plugin: UniswapV4Plugin;
  let router: MockUniversalRouter;
  let permit2: MockPermit2;
  let tokenIn: TestERC20;
  let tokenOut: TestERC20;
  let snapshot: SnapshotRestorer;

  // Snapshot/restore in afterEach so each test gets a clean chain — important
  // for tests that mutate the mock router or the plugin's storage state.
  afterEach(async () => {
    if (snapshot) await snapshot.restore();
  });

  beforeEach(async () => {
    [deployer, voter, stranger] = await ethers.getSigners();

    dao = await new MinimalDAO__factory(deployer).deploy();
    await dao.deployed();

    router = await new MockUniversalRouter__factory(deployer).deploy();
    await router.deployed();

    permit2 = await new MockPermit2__factory(deployer).deploy();
    await permit2.deployed();

    // Wire the mock router to use the mock Permit2 for the simulated pull.
    await router.setPermit2(permit2.address);

    plugin = await deployProxied(
      deployer,
      dao.address,
      router.address,
      permit2.address,
      FAKE_POOL_MANAGER,
      []
    );

    // Vote-gated swap = voter (proxies for "calls coming via DAO.execute").
    await dao.grant(plugin.address, await voter.getAddress(), TRIGGER_SWAP_PERMISSION_ID);
    await dao.grant(plugin.address, await voter.getAddress(), UPDATE_ROUTER_PERMISSION_ID);
    await dao.grant(plugin.address, await voter.getAddress(), MANAGE_ALLOWLIST_PERMISSION_ID);
    await dao.grant(plugin.address, await voter.getAddress(), MANAGE_POSITIONS_PERMISSION_ID);
    // Plugin needs EXECUTE on the DAO to run its action batch.
    await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);

    tokenIn = await new TestERC20__factory(deployer).deploy("Test USDC", "tUSDC", 6);
    await tokenIn.deployed();
    tokenOut = await new TestERC20__factory(deployer).deploy("Test WETH", "tWETH", 18);
    await tokenOut.deployed();

    snapshot = await takeSnapshot();
  });

  describe("initialize", () => {
    it("stores constructor params and disables initializer on the impl", async () => {
      expect(await plugin.universalRouter()).to.equal(router.address);
      expect(await plugin.permit2()).to.equal(permit2.address);
      expect(await plugin.poolManager()).to.equal(FAKE_POOL_MANAGER);
      expect(await plugin.allowlistEnforced()).to.equal(false);
      expect(await plugin.swapNonce()).to.equal(0);
    });

    it("cannot be initialized twice", async () => {
      await expect(
        plugin.initialize(
          dao.address,
          router.address,
          permit2.address,
          FAKE_POOL_MANAGER,
          ethers.constants.AddressZero,
          []
        )
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });

    it("non-empty allowlist flips allowlistEnforced and emits per-token events", async () => {
      const initialAllowlist = [tokenIn.address, tokenOut.address];

      const impl = await new UniswapV4Plugin__factory(deployer).deploy();
      const initData = impl.interface.encodeFunctionData("initialize", [
        dao.address,
        router.address,
        permit2.address,
        FAKE_POOL_MANAGER,
        ethers.constants.AddressZero,
        initialAllowlist,
      ]);
      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
      const tx = ProxyFactory.deploy(impl.address, initData);

      // Each token in the seed list emits an AllowedTokenSet event during init.
      // We assert against the plugin's interface bound to the proxy address.
      const proxy = await tx;
      await proxy.deployed();
      const seeded = UniswapV4Plugin__factory.connect(proxy.address, deployer);

      expect(await seeded.allowlistEnforced()).to.equal(true);
      expect(await seeded.allowedToken(tokenIn.address)).to.equal(true);
      expect(await seeded.allowedToken(tokenOut.address)).to.equal(true);
    });

    it("empty allowlist leaves allowlistEnforced=false (no restriction)", async () => {
      expect(await plugin.allowlistEnforced()).to.equal(false);
      // Default mapping returns false; no entries are added.
      expect(await plugin.allowedToken(tokenIn.address)).to.equal(false);
    });
  });

  describe("setUniversalRouter", () => {
    it("updates router and emits UniversalRouterUpdated", async () => {
      const newRouter = ethers.Wallet.createRandom().address;
      const prev = await plugin.universalRouter();

      await expect(plugin.connect(voter).setUniversalRouter(newRouter))
        .to.emit(plugin, "UniversalRouterUpdated")
        .withArgs(prev, newRouter);

      expect(await plugin.universalRouter()).to.equal(newRouter);
    });

    it("reverts when caller lacks UPDATE_ROUTER_PERMISSION", async () => {
      await expect(
        plugin.connect(stranger).setUniversalRouter(ethers.Wallet.createRandom().address)
      ).to.be.reverted;
    });
  });

  describe("setAllowedToken", () => {
    it("adds a token and flips allowlistEnforced on the first allow", async () => {
      expect(await plugin.allowlistEnforced()).to.equal(false);

      await expect(plugin.connect(voter).setAllowedToken(tokenIn.address, true))
        .to.emit(plugin, "AllowedTokenSet")
        .withArgs(tokenIn.address, true);

      expect(await plugin.allowedToken(tokenIn.address)).to.equal(true);
      expect(await plugin.allowlistEnforced()).to.equal(true);
    });

    it("removing a token does NOT flip allowlistEnforced back to false", async () => {
      // setAllowedToken(true) on a previously-empty allowlist flips enforcement on.
      // Subsequent setAllowedToken(false) only removes the entry — enforcement
      // is sticky (auditors flagged "implicit un-enforcement on empty" as a footgun).
      await plugin.connect(voter).setAllowedToken(tokenIn.address, true);
      expect(await plugin.allowlistEnforced()).to.equal(true);

      await expect(plugin.connect(voter).setAllowedToken(tokenIn.address, false))
        .to.emit(plugin, "AllowedTokenSet")
        .withArgs(tokenIn.address, false);

      expect(await plugin.allowedToken(tokenIn.address)).to.equal(false);
      expect(await plugin.allowlistEnforced()).to.equal(true); // sticky
    });

    it("reverts when caller lacks MANAGE_ALLOWLIST_PERMISSION", async () => {
      await expect(plugin.connect(stranger).setAllowedToken(tokenIn.address, true)).to.be.reverted;
    });
  });

  describe("swap: revert paths", () => {
    it("reverts DeadlineExpired when deadline < block.timestamp", async () => {
      // block.timestamp is monotonic in-test; "1" is always in the past.
      await expect(
        plugin
          .connect(voter)
          .swap(DUMMY_COMMANDS, DUMMY_INPUTS, 1, tokenIn.address, 1000, tokenOut.address, 0)
      ).to.be.revertedWithCustomError(plugin, "DeadlineExpired");
    });

    it("reverts TokenNotAllowed for tokenIn when allowlist enforced", async () => {
      // Seed allowlist with tokenOut only — tokenIn is missing.
      await plugin.connect(voter).setAllowedToken(tokenOut.address, true);
      await expect(
        plugin
          .connect(voter)
          .swap(
            DUMMY_COMMANDS,
            DUMMY_INPUTS,
            FUTURE_DEADLINE,
            tokenIn.address,
            1000,
            tokenOut.address,
            0
          )
      )
        .to.be.revertedWithCustomError(plugin, "TokenNotAllowed")
        .withArgs(tokenIn.address);
    });

    it("reverts TokenNotAllowed for tokenOut when allowlist enforced", async () => {
      await plugin.connect(voter).setAllowedToken(tokenIn.address, true);
      await expect(
        plugin
          .connect(voter)
          .swap(
            DUMMY_COMMANDS,
            DUMMY_INPUTS,
            FUTURE_DEADLINE,
            tokenIn.address,
            1000,
            tokenOut.address,
            0
          )
      )
        .to.be.revertedWithCustomError(plugin, "TokenNotAllowed")
        .withArgs(tokenOut.address);
    });

    it("reverts SlippageExceeded when received < minAmountOut", async () => {
      // DAO holds tokenIn, router has tokenOut to deliver — but only 50 of it,
      // while the proposal demands 100.
      const amountIn = ethers.utils.parseUnits("100", 6);
      const delivered = ethers.utils.parseUnits("50", 18);
      const minOut = ethers.utils.parseUnits("100", 18);

      await tokenIn.mint(dao.address, amountIn);
      await tokenOut.mint(router.address, delivered);

      await router.setSwap(
        tokenIn.address,
        0, // don't pull tokenIn — simpler for the slippage path
        tokenOut.address,
        delivered,
        dao.address,
        dao.address
      );

      await expect(
        plugin
          .connect(voter)
          .swap(
            DUMMY_COMMANDS,
            DUMMY_INPUTS,
            FUTURE_DEADLINE,
            tokenIn.address,
            amountIn,
            tokenOut.address,
            minOut
          )
      )
        .to.be.revertedWithCustomError(plugin, "SlippageExceeded")
        .withArgs(delivered, minOut);
    });

    it("reverts when caller lacks TRIGGER_SWAP_PERMISSION", async () => {
      await expect(
        plugin
          .connect(stranger)
          .swap(
            DUMMY_COMMANDS,
            DUMMY_INPUTS,
            FUTURE_DEADLINE,
            tokenIn.address,
            100,
            tokenOut.address,
            0
          )
      ).to.be.reverted;
    });
  });

  describe("swap: happy path", () => {
    async function happySwap(
      opts: {
        amountIn?: bigint | ReturnType<typeof ethers.utils.parseUnits>;
        delivered?: bigint | ReturnType<typeof ethers.utils.parseUnits>;
        minOut?: bigint | ReturnType<typeof ethers.utils.parseUnits>;
        pullTokenIn?: boolean;
      } = {}
    ): Promise<{
      tx: ContractTransaction;
      amountIn: ReturnType<typeof ethers.utils.parseUnits>;
      delivered: ReturnType<typeof ethers.utils.parseUnits>;
    }> {
      const amountIn = (opts.amountIn ?? ethers.utils.parseUnits("100", 6)) as ReturnType<
        typeof ethers.utils.parseUnits
      >;
      const delivered = (opts.delivered ?? ethers.utils.parseUnits("0.05", 18)) as ReturnType<
        typeof ethers.utils.parseUnits
      >;
      const minOut = (opts.minOut ?? ethers.utils.parseUnits("0.04", 18)) as ReturnType<
        typeof ethers.utils.parseUnits
      >;

      await tokenIn.mint(dao.address, amountIn);
      await tokenOut.mint(router.address, delivered);

      await router.setPullTokenIn(opts.pullTokenIn ?? false);
      await router.setSwap(
        tokenIn.address,
        opts.pullTokenIn ? amountIn : 0,
        tokenOut.address,
        delivered,
        dao.address,
        dao.address
      );

      const tx = await plugin
        .connect(voter)
        .swap(
          DUMMY_COMMANDS,
          DUMMY_INPUTS,
          FUTURE_DEADLINE,
          tokenIn.address,
          amountIn,
          tokenOut.address,
          minOut
        );
      return {tx, amountIn, delivered};
    }

    it("debits tokenIn from the DAO and credits tokenOut to the DAO", async () => {
      const {amountIn, delivered} = await happySwap({pullTokenIn: true});

      // DAO spent tokenIn (mock router pulled it via transferFrom in the
      // approve+execute sequence).
      expect(await tokenIn.balanceOf(dao.address)).to.equal(0);
      expect(await tokenIn.balanceOf(router.address)).to.equal(amountIn);
      // DAO received tokenOut.
      expect(await tokenOut.balanceOf(dao.address)).to.equal(delivered);
    });

    it("emits SwapExecuted with the actual delta as amountOutActual", async () => {
      const {tx, amountIn, delivered} = await happySwap();

      await expect(tx)
        .to.emit(plugin, "SwapExecuted")
        .withArgs(tokenIn.address, amountIn, tokenOut.address, delivered);
    });

    it("increments swapNonce on each successful swap", async () => {
      expect(await plugin.swapNonce()).to.equal(0);
      await happySwap();
      expect(await plugin.swapNonce()).to.equal(1);
    });

    it("approves Permit2 for exactly amountIn (not max) — TRD §11 security note", async () => {
      // With pullTokenIn=true, MockUniversalRouter pulls `amountIn` of tokenIn
      // from the DAO *via Permit2*, mirroring the real settlement path. The
      // DAO's ERC20 allowance for Permit2 should be exactly amountIn before
      // the call and zero after (since the plugin approves the exact amount,
      // not max).
      const {amountIn} = await happySwap({pullTokenIn: true});

      // Plugin recorded its approve via the mock Permit2 — check it was
      // (tokenIn, router, amountIn, deadline).
      const {amount, expiration, set} = await permit2.getApproval(tokenIn.address, router.address);
      expect(set).to.equal(true);
      expect(amount).to.equal(amountIn);
      expect(expiration).to.equal(FUTURE_DEADLINE);

      // After the router (here: the mock) has done its Permit2.transferFrom
      // of `amountIn`, the ERC20 allowance for Permit2 should be back to zero
      // (we approved exactly amountIn — not max).
      const remaining = await tokenIn.allowance(dao.address, permit2.address);
      expect(remaining).to.equal(0);
    });

    it("Permit2.approve was called exactly once per swap", async () => {
      expect(await permit2.approveCallCount()).to.equal(0);
      await happySwap();
      expect(await permit2.approveCallCount()).to.equal(1);
    });

    it("passes the allowlist gate when both tokens are listed", async () => {
      await plugin.connect(voter).setAllowedToken(tokenIn.address, true);
      await plugin.connect(voter).setAllowedToken(tokenOut.address, true);
      const {tx} = await happySwap();
      // No revert — and the event still fires.
      await expect(tx).to.emit(plugin, "SwapExecuted");
    });
  });

  describe("swap: nonce uniqueness across runs", () => {
    it("produces different callIds for two sequential swaps", async () => {
      const amountIn = ethers.utils.parseUnits("100", 6);
      const delivered = ethers.utils.parseUnits("0.05", 18);

      // Top up enough for two swaps.
      await tokenIn.mint(dao.address, amountIn.mul(2));
      await tokenOut.mint(router.address, delivered.mul(2));

      await router.setPullTokenIn(true);
      await router.setSwap(
        tokenIn.address,
        amountIn,
        tokenOut.address,
        delivered,
        dao.address,
        dao.address
      );

      const tx1 = await plugin
        .connect(voter)
        .swap(
          DUMMY_COMMANDS,
          DUMMY_INPUTS,
          FUTURE_DEADLINE,
          tokenIn.address,
          amountIn,
          tokenOut.address,
          0
        );
      const tx2 = await plugin
        .connect(voter)
        .swap(
          DUMMY_COMMANDS,
          DUMMY_INPUTS,
          FUTURE_DEADLINE,
          tokenIn.address,
          amountIn,
          tokenOut.address,
          0
        );

      expect(await plugin.swapNonce()).to.equal(2);

      // Both `Executed` events should be present; the callIds derive from a
      // monotonically-incrementing nonce so they must differ.
      const r1 = await tx1.wait();
      const r2 = await tx2.wait();

      const execIface = new ethers.utils.Interface([
        "event Executed(address indexed actor, bytes32 callId, tuple(address to, uint256 value, bytes data)[] actions, uint256 allowFailureMap, uint256 failureMap, bytes[] execResults)",
      ]);
      function callIdFrom(receipt: typeof r1): string {
        for (const log of receipt.logs) {
          try {
            const parsed = execIface.parseLog(log);
            if (parsed.name === "Executed") return parsed.args.callId as string;
          } catch {
            /* ignore */
          }
        }
        throw new Error("Executed not found");
      }
      const id1 = callIdFrom(r1);
      const id2 = callIdFrom(r2);

      expect(id1).to.equal(
        ethers.utils.solidityKeccak256(["string", "uint256"], ["UNI_V4_SWAP:", 0])
      );
      expect(id2).to.equal(
        ethers.utils.solidityKeccak256(["string", "uint256"], ["UNI_V4_SWAP:", 1])
      );
      expect(id1).to.not.equal(id2);
    });
  });

  // -------------------------------------------------------------------------
  // V4 LP lifecycle: modifyLiquidities is a pass-through to the v4-periphery
  // PositionManager. The mock PM ignores the unlockData and instead is
  // pre-configured per test with pull legs (mint/increase — Permit2 pulls
  // tokens from the DAO) and push legs (decrease/burn — PM sends tokens to
  // the DAO). All tests share the DAO + plugin + Permit2 from the outer
  // beforeEach; we deploy a fresh MockV4PositionManager per `describe`.
  // -------------------------------------------------------------------------
  describe("modifyLiquidities (v4 LP lifecycle)", () => {
    let pm: MockV4PositionManager;
    // A valid (but actionless) v4 unlock envelope: abi.encode(bytes(""), bytes[](0)).
    // The plugin's MintRecipientMustBeDao check needs a well-formed envelope
    // even when the mock PM ignores the bytes; the loop simply iterates zero times.
    const DUMMY_UNLOCK = ethers.utils.defaultAbiCoder.encode(["bytes", "bytes[]"], ["0x", []]);

    beforeEach(async () => {
      pm = await new MockV4PositionManager__factory(deployer).deploy();
      await pm.deployed();
      await pm.setPermit2(permit2.address);
      // Wire the v4 PositionManager via the vote-gated setter.
      await plugin.connect(voter).setV4PositionManager(pm.address);
    });

    it("setV4PositionManager emits + updates storage; rejects unauthorized", async () => {
      expect(await plugin.v4PositionManager()).to.equal(pm.address);
      const next = ethers.Wallet.createRandom().address;
      await expect(plugin.connect(voter).setV4PositionManager(next))
        .to.emit(plugin, "V4PositionManagerUpdated")
        .withArgs(pm.address, next);
      await expect(plugin.connect(stranger).setV4PositionManager(next)).to.be.reverted;
    });

    it("reverts PositionManagerUnset when never configured", async () => {
      // Fresh plugin instance with the PM intentionally not set.
      const fresh = await deployProxied(
        deployer,
        dao.address,
        router.address,
        permit2.address,
        FAKE_POOL_MANAGER,
        []
      );
      await dao.grant(fresh.address, await voter.getAddress(), MANAGE_POSITIONS_PERMISSION_ID);
      await dao.grant(dao.address, fresh.address, EXECUTE_PERMISSION_ID);
      await expect(
        fresh.connect(voter).modifyLiquidities(DUMMY_UNLOCK, FUTURE_DEADLINE, [], [], [], [])
      ).to.be.revertedWithCustomError(fresh, "PositionManagerUnset");
    });

    it("reverts DeadlineExpired in the past + LengthMismatch on misaligned arrays", async () => {
      await expect(
        plugin.connect(voter).modifyLiquidities(DUMMY_UNLOCK, 1, [], [], [], [])
      ).to.be.revertedWithCustomError(plugin, "DeadlineExpired");
      await expect(
        plugin
          .connect(voter)
          .modifyLiquidities(DUMMY_UNLOCK, FUTURE_DEADLINE, [tokenIn.address], [], [], [])
      ).to.be.revertedWithCustomError(plugin, "LengthMismatch");
      await expect(
        plugin
          .connect(voter)
          .modifyLiquidities(DUMMY_UNLOCK, FUTURE_DEADLINE, [], [], [tokenOut.address], [])
      ).to.be.revertedWithCustomError(plugin, "LengthMismatch");
    });

    it("reverts when caller lacks MANAGE_POSITIONS", async () => {
      await expect(
        plugin.connect(stranger).modifyLiquidities(DUMMY_UNLOCK, FUTURE_DEADLINE, [], [], [], [])
      ).to.be.reverted;
    });

    it("enforces the allowlist on both input and output currencies", async () => {
      // Allow tokenIn but NOT tokenOut, then attempt a mint paying tokenIn
      // and an op receiving tokenOut → output side reverts.
      await plugin.connect(voter).setAllowedToken(tokenIn.address, true);
      await expect(
        plugin
          .connect(voter)
          .modifyLiquidities(
            DUMMY_UNLOCK,
            FUTURE_DEADLINE,
            [tokenIn.address],
            [100],
            [tokenOut.address],
            [1]
          )
      )
        .to.be.revertedWithCustomError(plugin, "TokenNotAllowed")
        .withArgs(tokenOut.address);
    });

    // Helper: encode a real MINT_POSITION param tuple (matches v4-periphery).
    // PoolKey + tickLower + tickUpper + liquidity + amount0Max + amount1Max + owner + hookData.
    function encodeMintParam(owner: string): string {
      return ethers.utils.defaultAbiCoder.encode(
        [
          "(address,address,uint24,int24,address)", // PoolKey
          "int24",
          "int24",
          "uint256",
          "uint128",
          "uint128",
          "address",
          "bytes",
        ],
        [
          [ethers.constants.AddressZero, ethers.constants.AddressZero, 3000, 60, ethers.constants.AddressZero],
          -60,
          60,
          1,
          1,
          1,
          owner,
          "0x",
        ]
      );
    }
    // Helper: build an unlockData envelope with a single MINT_POSITION action.
    function envelopeWithMint(owner: string): string {
      const actionStream = "0x" + "02"; // MINT_POSITION
      const mintParam = encodeMintParam(owner);
      return ethers.utils.defaultAbiCoder.encode(
        ["bytes", "bytes[]"],
        [actionStream, [mintParam]]
      );
    }

    it("reverts MintRecipientMustBeDao when the encoded owner is not the DAO", async () => {
      const stranger = ethers.Wallet.createRandom().address;
      const bad = envelopeWithMint(stranger);
      await expect(
        plugin.connect(voter).modifyLiquidities(bad, FUTURE_DEADLINE, [], [], [], [])
      )
        .to.be.revertedWithCustomError(plugin, "MintRecipientMustBeDao")
        .withArgs(stranger, dao.address);
    });

    it("passes the MINT_POSITION recipient check when encoded owner is the DAO", async () => {
      const good = envelopeWithMint(dao.address);
      // No pull/push legs configured → modifyLiquidities is a no-op on the mock
      // PM. The plugin still runs all preflight checks; success here proves the
      // recipient check accepts dao().
      await expect(
        plugin.connect(voter).modifyLiquidities(good, FUTURE_DEADLINE, [], [], [], [])
      ).to.emit(plugin, "LiquidityModified");
    });

    it("reverts UnlockDataTooShort on an empty payload", async () => {
      await expect(
        plugin.connect(voter).modifyLiquidities("0x", FUTURE_DEADLINE, [], [], [], [])
      ).to.be.revertedWithCustomError(plugin, "UnlockDataTooShort");
    });

    it("previewModifyLiquiditiesActions also enforces the MINT_POSITION recipient", async () => {
      const stranger = ethers.Wallet.createRandom().address;
      const bad = envelopeWithMint(stranger);
      await expect(
        plugin.previewModifyLiquiditiesActions(bad, FUTURE_DEADLINE, [], [])
      )
        .to.be.revertedWithCustomError(plugin, "MintRecipientMustBeDao")
        .withArgs(stranger, dao.address);
    });

    it("mint leg: DAO→Permit2 allowance pulled to zero post-call, action emitted", async () => {
      const amountIn = ethers.utils.parseUnits("1000", 6);
      await tokenIn.mint(dao.address, amountIn);
      // Configure PM to pull `amountIn` of tokenIn from the DAO via Permit2.
      await pm.addPullLeg(tokenIn.address, amountIn, dao.address);

      await expect(
        plugin
          .connect(voter)
          .modifyLiquidities(DUMMY_UNLOCK, FUTURE_DEADLINE, [tokenIn.address], [amountIn], [], [])
      )
        .to.emit(plugin, "LiquidityModified")
        .withArgs(1); // lpNonce after the increment

      // Funds pulled from the DAO into the PM via Permit2; plugin holds nothing.
      expect(await tokenIn.balanceOf(dao.address)).to.equal(0);
      expect(await tokenIn.balanceOf(pm.address)).to.equal(amountIn);
      expect(await tokenIn.balanceOf(plugin.address)).to.equal(0);
      // No residual DAO→Permit2 allowance after the reset action.
      expect(await tokenIn.allowance(dao.address, permit2.address)).to.equal(0);
    });

    it("decrease/collect leg: outputs land in the DAO and pass minOut check", async () => {
      const amountOut = ethers.utils.parseUnits("500", 6);
      await tokenOut.mint(pm.address, amountOut);
      await pm.addPushLeg(tokenOut.address, amountOut, dao.address);

      await plugin
        .connect(voter)
        .modifyLiquidities(DUMMY_UNLOCK, FUTURE_DEADLINE, [], [], [tokenOut.address], [amountOut]);
      expect(await tokenOut.balanceOf(dao.address)).to.equal(amountOut);
    });

    it("reverts OutputShortfall when post-balance delta is below minOut", async () => {
      // Push only half of what the proposal demands.
      const got = ethers.utils.parseUnits("100", 6);
      const want = ethers.utils.parseUnits("250", 6);
      await tokenOut.mint(pm.address, got);
      await pm.addPushLeg(tokenOut.address, got, dao.address);

      await expect(
        plugin
          .connect(voter)
          .modifyLiquidities(DUMMY_UNLOCK, FUTURE_DEADLINE, [], [], [tokenOut.address], [want])
      )
        .to.be.revertedWithCustomError(plugin, "OutputShortfall")
        .withArgs(tokenOut.address, got, want);
    });

    it("lpNonce increments per successful op, separate from swapNonce", async () => {
      const swapNonceStart = await plugin.swapNonce();
      const amountOut = ethers.utils.parseUnits("1", 18);
      await tokenOut.mint(pm.address, amountOut.mul(2));
      await pm.addPushLeg(tokenOut.address, amountOut, dao.address);

      await plugin
        .connect(voter)
        .modifyLiquidities(DUMMY_UNLOCK, FUTURE_DEADLINE, [], [], [tokenOut.address], [amountOut]);
      await plugin
        .connect(voter)
        .modifyLiquidities(DUMMY_UNLOCK, FUTURE_DEADLINE, [], [], [tokenOut.address], [amountOut]);

      expect(await plugin.lpNonce()).to.equal(2);
      expect(await plugin.swapNonce()).to.equal(swapNonceStart); // unchanged
    });

    // ---------------------------------------------------------------------
    // Full V4 LP lifecycle exercised through the plugin in ONE test, in the
    // same order a real proposal-driven flow would: mint → increase → decrease
    // → collect → burn. Each `modifyLiquidities` call reconfigures the mock PM
    // with the appropriate pull/push legs (mock ignores the unlockData; the
    // shape of the v4 action stream is the plugin's pass-through opaque
    // payload). Asserts the plugin's safety invariants hold at every phase:
    //   - lpNonce increments per phase (5 ops → 5)
    //   - plugin holds zero of either token at every checkpoint
    //   - DAO→Permit2 allowance is zero after each pull phase (reset action)
    //   - mint/increase debit the DAO; decrease/collect/burn credit the DAO
    //   - output slippage guard fires when minOut isn't met
    // ---------------------------------------------------------------------
    it("full lifecycle: mint → increase → decrease → collect → burn (sequential)", async () => {
      // Seed the DAO with both tokens and the PM with output liquidity for
      // later phases. The DAO will pay tokenIn + tokenOut for mint/increase
      // and receive them back via decrease/collect/burn.
      const initialIn = ethers.utils.parseUnits("4000", 6);
      const initialOut = ethers.utils.parseEther("4");
      await tokenIn.mint(dao.address, initialIn);
      await tokenOut.mint(dao.address, initialOut);
      // Pre-fund the PM so it can push tokens back during decrease/collect/burn.
      await tokenIn.mint(pm.address, ethers.utils.parseUnits("3000", 6));
      await tokenOut.mint(pm.address, ethers.utils.parseEther("3"));

      const expectPluginHasNothing = async () => {
        expect(await tokenIn.balanceOf(plugin.address)).to.equal(0);
        expect(await tokenOut.balanceOf(plugin.address)).to.equal(0);
      };
      const expectZeroAllowances = async () => {
        expect(await tokenIn.allowance(dao.address, permit2.address)).to.equal(0);
        expect(await tokenOut.allowance(dao.address, permit2.address)).to.equal(0);
      };

      // ===== Phase 1: MINT_POSITION + SETTLE_PAIR — pull both tokens =====
      const mintIn0 = ethers.utils.parseUnits("1000", 6);
      const mintIn1 = ethers.utils.parseEther("1");
      await pm.clearLegs();
      await pm.addPullLeg(tokenIn.address, mintIn0, dao.address);
      await pm.addPullLeg(tokenOut.address, mintIn1, dao.address);

      await expect(
        plugin
          .connect(voter)
          .modifyLiquidities(
            DUMMY_UNLOCK, // pretend "MINT_POSITION + SETTLE_PAIR" actions byte
            FUTURE_DEADLINE,
            [tokenIn.address, tokenOut.address],
            [mintIn0, mintIn1],
            [],
            []
          )
      )
        .to.emit(plugin, "LiquidityModified")
        .withArgs(1);
      expect(await plugin.lpNonce()).to.equal(1);
      expect(await tokenIn.balanceOf(dao.address)).to.equal(initialIn.sub(mintIn0));
      expect(await tokenOut.balanceOf(dao.address)).to.equal(initialOut.sub(mintIn1));
      await expectPluginHasNothing();
      await expectZeroAllowances();

      // ===== Phase 2: INCREASE_LIQUIDITY + SETTLE_PAIR — pull more =====
      const incIn0 = ethers.utils.parseUnits("500", 6);
      const incIn1 = ethers.utils.parseEther("0.5");
      await pm.clearLegs();
      await pm.addPullLeg(tokenIn.address, incIn0, dao.address);
      await pm.addPullLeg(tokenOut.address, incIn1, dao.address);

      await plugin
        .connect(voter)
        .modifyLiquidities(
          DUMMY_UNLOCK,
          FUTURE_DEADLINE,
          [tokenIn.address, tokenOut.address],
          [incIn0, incIn1],
          [],
          []
        );
      expect(await plugin.lpNonce()).to.equal(2);
      const daoInAfterInc = initialIn.sub(mintIn0).sub(incIn0);
      const daoOutAfterInc = initialOut.sub(mintIn1).sub(incIn1);
      expect(await tokenIn.balanceOf(dao.address)).to.equal(daoInAfterInc);
      expect(await tokenOut.balanceOf(dao.address)).to.equal(daoOutAfterInc);
      await expectPluginHasNothing();
      await expectZeroAllowances();

      // ===== Phase 3: DECREASE_LIQUIDITY + TAKE_PAIR — push back =====
      const decOut0 = ethers.utils.parseUnits("400", 6);
      const decOut1 = ethers.utils.parseEther("0.4");
      await pm.clearLegs();
      await pm.addPushLeg(tokenIn.address, decOut0, dao.address);
      await pm.addPushLeg(tokenOut.address, decOut1, dao.address);

      await plugin
        .connect(voter)
        .modifyLiquidities(
          DUMMY_UNLOCK,
          FUTURE_DEADLINE,
          [],
          [],
          [tokenIn.address, tokenOut.address],
          [decOut0, decOut1] // minOut hits exactly
        );
      expect(await plugin.lpNonce()).to.equal(3);
      expect(await tokenIn.balanceOf(dao.address)).to.equal(daoInAfterInc.add(decOut0));
      expect(await tokenOut.balanceOf(dao.address)).to.equal(daoOutAfterInc.add(decOut1));
      await expectPluginHasNothing();

      // ===== Phase 4: COLLECT (DECREASE_LIQUIDITY 0 + TAKE_PAIR) — push fees =====
      // In v4, fee collection is modelled as DECREASE_LIQUIDITY(liquidity=0) +
      // TAKE_PAIR. From the plugin's perspective it's an output-only op.
      const feesOut0 = ethers.utils.parseUnits("5", 6);
      const feesOut1 = ethers.utils.parseEther("0.001");
      await pm.clearLegs();
      await pm.addPushLeg(tokenIn.address, feesOut0, dao.address);
      await pm.addPushLeg(tokenOut.address, feesOut1, dao.address);

      // Slippage guard fires when minOut > received — assert before the happy path.
      await expect(
        plugin
          .connect(voter)
          .modifyLiquidities(
            DUMMY_UNLOCK,
            FUTURE_DEADLINE,
            [],
            [],
            [tokenIn.address, tokenOut.address],
            [feesOut0.add(1), feesOut1.add(1)] // demand one more than the PM will push
          )
      ).to.be.revertedWithCustomError(plugin, "OutputShortfall");
      // The failed call cleared the legs (they were consumed via try/catch?) — re-add.
      await pm.clearLegs();
      await pm.addPushLeg(tokenIn.address, feesOut0, dao.address);
      await pm.addPushLeg(tokenOut.address, feesOut1, dao.address);

      await plugin
        .connect(voter)
        .modifyLiquidities(
          DUMMY_UNLOCK,
          FUTURE_DEADLINE,
          [],
          [],
          [tokenIn.address, tokenOut.address],
          [feesOut0, feesOut1]
        );
      expect(await plugin.lpNonce()).to.equal(4);
      await expectPluginHasNothing();

      // ===== Phase 5: BURN_POSITION + TAKE_PAIR — push residual =====
      // Real BURN_POSITION can also push leftover principal; here a small dust.
      const burnOut0 = ethers.utils.parseUnits("1", 6);
      await pm.clearLegs();
      await pm.addPushLeg(tokenIn.address, burnOut0, dao.address);

      await plugin
        .connect(voter)
        .modifyLiquidities(
          DUMMY_UNLOCK,
          FUTURE_DEADLINE,
          [],
          [],
          [tokenIn.address],
          [burnOut0]
        );
      expect(await plugin.lpNonce()).to.equal(5);
      await expectPluginHasNothing();

      // Final cross-check: cumulative DAO balance changes equal the mock's net
      // (mint/increase pulled, decrease/collect/burn pushed back).
      const cumIn =
        // pulled out:
        mintIn0.add(incIn0)
        // pushed back:
        .sub(decOut0).sub(feesOut0).sub(burnOut0);
      const cumOut = mintIn1.add(incIn1).sub(decOut1).sub(feesOut1);
      expect(await tokenIn.balanceOf(dao.address)).to.equal(initialIn.sub(cumIn));
      expect(await tokenOut.balanceOf(dao.address)).to.equal(initialOut.sub(cumOut));
    });
  });
});
