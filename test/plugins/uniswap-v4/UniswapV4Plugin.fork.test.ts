/**
 * UniswapV4Plugin fork integration tests.
 *
 * Runs against a forked chain (mainnetFork or baseFork) so the DAO swaps
 * REAL USDC → WETH through the REAL Universal Router + Permit2 contracts.
 *
 * Scope deviation from ROADMAP P3: we use the MinimalDAO mock rather than
 * the live DAOFactory. End-to-end bootstrap via DAOFactory belongs to P5's
 * CustomDaoBootstrap.fork.test.ts; for P3 we want focused, fast tests of
 * the plugin's swap path against real on-chain assets without the full
 * TokenVoting + PluginRepo dance.
 *
 * Universal Router command encoding: the plugin treats `commands`/`inputs`
 * as opaque bytes — encoding choices belong to the proposal builder. Two
 * swap routes are exercised here against the real Universal Router:
 *   - the V3 SWAP_EXACT_IN_SINGLE command (0x00) — deepest liquidity, the
 *     "happy path" + slippage + allowance assertions; and
 *   - the V4-native V4_SWAP command (0x10) against the live v4 USDC/WETH
 *     pool (fee 3000, tickSpacing 60, no hooks), proving a genuine V4 route.
 *
 * The full V4 LP lifecycle (mint → decrease → collect → burn) is also
 * fork-verified below against the canonical v4-periphery PositionManager
 * (mainnet-only — those tests self-skip on Base).
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
  UniswapV4Plugin,
  UniswapV4Plugin__factory,
} from "../../../typechain-types";
import {onlyOn} from "../../helpers/fork-guard";
import {EXTERNAL, type ExternalChain} from "../../helpers/addresses";
import {fundFromWhale} from "../../helpers/impersonate";
import {takeSnapshot} from "../../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

const TRIGGER_SWAP_PERMISSION_ID = ethers.utils.id("TRIGGER_SWAP_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");
const UPDATE_ROUTER_PERMISSION_ID = ethers.utils.id("UPDATE_ROUTER_PERMISSION");
const MANAGE_POSITIONS_PERMISSION_ID = ethers.utils.id("MANAGE_POSITIONS_PERMISSION");

// v4-periphery PositionManager (mainnet). The LP test is mainnet-only — Base
// has a different PM and pool set, and the v4 LP path is identical code.
const V4_POSITION_MANAGER_MAINNET = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e";
// Known WETH whale (same as the V3 fork test).
const WETH_WHALE = "0x8EB8a3b98659Cce290402893d0123abb75E3ab28";

// v4 Actions enum opcodes (v4-periphery).
const V4_MINT_POSITION = 0x02;
const V4_DECREASE_LIQUIDITY = 0x01;
const V4_BURN_POSITION = 0x03;
const V4_SETTLE_PAIR = 0x0d;
const V4_TAKE_PAIR = 0x11;

function packActions(bytes: number[]): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

// Known USDC whales on each fork target. Same set as PayrollPlugin.fork.test.ts.
const WHALES: Record<ExternalChain, string> = {
  mainnet: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
  base: "0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3",
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

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
    ethers.constants.AddressZero, // v4PositionManager — swap fork test doesn't exercise LP
    initialAllowlist,
  ]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await Proxy.deploy(impl.address, initData);
  await proxy.deployed();
  return UniswapV4Plugin__factory.connect(proxy.address, signer);
}

function chainKey(): ExternalChain {
  if (network.name === "mainnetFork") return "mainnet";
  // localFork is an anvil fork of mainnet state with chainId 31337.
  if (network.name === "localFork") return "mainnet";
  if (network.name === "baseFork") return "base";
  throw new Error(`Unsupported fork network: ${network.name}`);
}

// Encode the V3 SWAP_EXACT_IN_SINGLE command via the Universal Router.
//
// command byte: 0x00 (V3_SWAP_EXACT_IN)
// inputs[0]   : abi.encode(recipient, amountIn, amountOutMin, path, payerIsUser)
//   recipient    : address that receives tokenOut
//   amountIn     : exact input
//   amountOutMin : min output (we set a sentinel here; the PLUGIN's slippage
//                  guard is the real protection)
//   path         : packed (tokenIn, fee, tokenOut) — 20 + 3 + 20 = 43 bytes
//   payerIsUser  : true → router pulls funds via Permit2 from msg.sender (DAO)
function encodeV3ExactInSingle(opts: {
  recipient: string;
  amountIn: ReturnType<typeof ethers.utils.parseUnits>;
  amountOutMin: ReturnType<typeof ethers.utils.parseUnits>;
  tokenIn: string;
  fee: number; // pool fee tier, e.g. 500 for the 0.05% USDC/WETH pool
  tokenOut: string;
}): {commands: string; inputs: string[]} {
  const commands = "0x00"; // V3_SWAP_EXACT_IN
  const path = ethers.utils.solidityPack(
    ["address", "uint24", "address"],
    [opts.tokenIn, opts.fee, opts.tokenOut]
  );
  const inputs = [
    ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256", "uint256", "bytes", "bool"],
      [opts.recipient, opts.amountIn, opts.amountOutMin, path, true]
    ),
  ];
  return {commands, inputs};
}

onlyOn(["mainnetFork", "baseFork", "localFork"], () => {
  describe(`UniswapV4Plugin (fork: ${network.name}) [fork]`, function () {
    // Retry transient public-RPC zero-reads (see AAVE fork test for rationale).
    this.retries(2);

    let deployer: Signer;
    let voter: Signer;
    let dao: MinimalDAO;
    let plugin: UniswapV4Plugin;
    let usdcAddress: string;
    let wethAddress: string;
    let universalRouter: string;
    let permit2: string;
    let poolManager: string;
    let usdc: import("ethers").Contract;
    let weth: import("ethers").Contract;
    let snapshot: SnapshotRestorer;

    before(async () => {
      [deployer, voter] = await ethers.getSigners();
      const key = chainKey();
      usdcAddress = EXTERNAL[key].USDC;
      wethAddress = EXTERNAL[key].WETH;
      universalRouter = EXTERNAL[key].UNIVERSAL_ROUTER;
      permit2 = EXTERNAL[key].PERMIT2;
      poolManager = EXTERNAL[key].UNISWAP_V4_POOL_MANAGER;
      usdc = new ethers.Contract(usdcAddress, ERC20_ABI, ethers.provider);
      weth = new ethers.Contract(wethAddress, ERC20_ABI, ethers.provider);
    });

    beforeEach(async () => {
      dao = await new MinimalDAO__factory(deployer).deploy();
      await dao.deployed();
      plugin = await deployProxied(
        deployer,
        dao.address,
        universalRouter,
        permit2,
        poolManager,
        []
      );
      await dao.grant(plugin.address, await voter.getAddress(), TRIGGER_SWAP_PERMISSION_ID);
      await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);
      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      if (snapshot) await snapshot.restore();
    });

    it("DAO USDC → WETH swap via real Universal Router (V3 command)", async () => {
      const amountIn = ethers.utils.parseUnits("1000", 6); // 1000 USDC
      // ~0.99 % slippage on a $1000 swap is fine for a smoke test; the plugin's
      // post-swap balance check (`received >= minAmountOut`) is the real guard.
      // We use a wildly-low `minAmountOut` here and tighten in the slippage test.
      const minAmountOut = 1; // 1 wei of WETH — sanity floor only

      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, amountIn);
      expect(await usdc.balanceOf(dao.address)).to.equal(amountIn);

      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
      const fee = 500; // 0.05% USDC/WETH pool (deepest liquidity on mainnet+Base)

      const {commands, inputs} = encodeV3ExactInSingle({
        recipient: dao.address,
        amountIn,
        amountOutMin: 0, // plugin enforces slippage; router-side min is sentinel
        tokenIn: usdcAddress,
        fee,
        tokenOut: wethAddress,
      });

      const wethBefore = await weth.balanceOf(dao.address);
      const tx = await plugin
        .connect(voter)
        .swap(commands, inputs, deadline, usdcAddress, amountIn, wethAddress, minAmountOut);
      await tx.wait();

      const wethAfter = await weth.balanceOf(dao.address);
      const received = wethAfter.sub(wethBefore);

      // Sanity: we got SOMETHING. The exact amount depends on pool state at the
      // pinned block; CI pins via PIN_MAINNET/PIN_BASE for determinism.
      expect(received).to.be.gt(0);
      // DAO sold all the USDC.
      expect(await usdc.balanceOf(dao.address)).to.equal(0);

      // SwapExecuted emitted with the actual delta.
      await expect(tx)
        .to.emit(plugin, "SwapExecuted")
        .withArgs(usdcAddress, amountIn, wethAddress, received);
    });

    it("reverts SlippageExceeded when minAmountOut is set artificially high", async () => {
      const amountIn = ethers.utils.parseUnits("1000", 6);
      // 10× a fair price — guaranteed to be unreachable.
      const minAmountOut = ethers.utils.parseEther("5");

      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, amountIn);
      const usdcBefore = await usdc.balanceOf(dao.address);
      const wethBefore = await weth.balanceOf(dao.address);

      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
      const {commands, inputs} = encodeV3ExactInSingle({
        recipient: dao.address,
        amountIn,
        amountOutMin: 0,
        tokenIn: usdcAddress,
        fee: 500,
        tokenOut: wethAddress,
      });

      await expect(
        plugin
          .connect(voter)
          .swap(commands, inputs, deadline, usdcAddress, amountIn, wethAddress, minAmountOut)
      ).to.be.revertedWithCustomError(plugin, "SlippageExceeded");

      // Balances unchanged — the entire batch reverted.
      expect(await usdc.balanceOf(dao.address)).to.equal(usdcBefore);
      expect(await weth.balanceOf(dao.address)).to.equal(wethBefore);
    });

    it("leaves zero leftover allowance from DAO → Permit2 after a successful swap", async () => {
      const amountIn = ethers.utils.parseUnits("1000", 6);

      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, amountIn);

      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
      const {commands, inputs} = encodeV3ExactInSingle({
        recipient: dao.address,
        amountIn,
        amountOutMin: 0,
        tokenIn: usdcAddress,
        fee: 500,
        tokenOut: wethAddress,
      });

      await plugin
        .connect(voter)
        .swap(commands, inputs, deadline, usdcAddress, amountIn, wethAddress, 1);

      // Plugin approved Permit2 for exactly amountIn. Permit2 then pulled
      // amountIn during the router execute, leaving zero leftover.
      const remaining = await usdc.allowance(dao.address, permit2);
      expect(remaining).to.equal(0);
    });

    // V4-native single-hop swap: routes USDC → WETH through the real Universal
    // Router V4_SWAP command (0x10) against the live v4 USDC/WETH pool (fee
    // 3000, tickSpacing 60, no hooks). Proves the plugin handles a genuine V4
    // route — not just the V3 command used in the happy-path test above.
    // Mainnet-only (the pinned v4 pool is mainnet).
    it("V4-native single-hop USDC → WETH swap via the real Universal Router", async function () {
      if (chainKey() !== "mainnet") {
        this.skip();
        return;
      }
      this.timeout(600_000);

      const amountIn = ethers.utils.parseUnits("1000", 6); // 1000 USDC
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, amountIn);

      // currency0 < currency1. USDC < WETH on mainnet → USDC is currency0, so
      // selling USDC for WETH is zeroForOne = true.
      const [c0, c1] =
        usdcAddress.toLowerCase() < wethAddress.toLowerCase()
          ? [usdcAddress, wethAddress]
          : [wethAddress, usdcAddress];
      const zeroForOne = usdcAddress.toLowerCase() === c0.toLowerCase();
      const poolKey = [c0, c1, 3000, 60, ethers.constants.AddressZero];
      const enc = ethers.utils.defaultAbiCoder;

      // V4Router action opcodes (distinct from the PositionManager set):
      // SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f.
      const SWAP_EXACT_IN_SINGLE = 0x06;
      const SETTLE_ALL = 0x0c;
      const TAKE_ALL = 0x0f;

      const exactInSingle = enc.encode(
        ["((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"],
        [[poolKey, zeroForOne, amountIn, 0, "0x"]]
      );
      const settleAll = enc.encode(["address", "uint256"], [usdcAddress, amountIn]);
      const takeAll = enc.encode(["address", "uint256"], [wethAddress, 0]);
      const v4Input = enc.encode(
        ["bytes", "bytes[]"],
        [
          packActions([SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]),
          [exactInSingle, settleAll, takeAll],
        ]
      );

      // Universal Router command 0x10 = V4_SWAP; its single input is the v4
      // action stream above.
      const commands = "0x10";
      const inputs = [v4Input];

      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const wethBefore = await weth.balanceOf(dao.address);

      await plugin
        .connect(voter)
        .swap(commands, inputs, deadline, usdcAddress, amountIn, wethAddress, 1);

      // DAO received WETH; the plugin's post-swap delta guard (minOut=1) passed.
      const received = (await weth.balanceOf(dao.address)).sub(wethBefore);
      expect(received).to.be.gt(0);
      // No residual allowance, no plugin custody.
      expect(await usdc.allowance(dao.address, permit2)).to.equal(0);
      expect(await usdc.balanceOf(plugin.address)).to.equal(0);
      expect(await weth.balanceOf(plugin.address)).to.equal(0);
    });

    // ----- V4 LP lifecycle against the REAL v4 PositionManager -----
    //
    // Mints a real V4 USDC/WETH position owned by the DAO via the
    // modifyLiquidities pass-through, exercising the full
    // approve → Permit2 → PM.modifyLiquidities → reset batch + the on-chain
    // MintRecipientMustBeDao guard. Mainnet-only (the PM address + pool are
    // mainnet-specific); the LP code path itself is chain-agnostic.
    //
    // Pool (probed live at the pinned block): USDC/WETH, fee 3000,
    // tickSpacing 60, no hooks, current tick ~199951.
    it("mints a real V4 USDC/WETH position owned by the DAO", async function () {
      if (chainKey() !== "mainnet") {
        this.skip();
        return;
      }
      // First touch of v4 PoolManager storage on a cold fork is heavy.
      this.timeout(600_000);

      // Wire the v4 PositionManager via the vote-gated setter.
      await dao.grant(plugin.address, await voter.getAddress(), UPDATE_ROUTER_PERMISSION_ID);
      await dao.grant(plugin.address, await voter.getAddress(), MANAGE_POSITIONS_PERMISSION_ID);
      await plugin.connect(voter).setV4PositionManager(V4_POSITION_MANAGER_MAINNET);

      // Fund the DAO generously; the PM pulls only what the chosen liquidity
      // needs (well under these maxes for the small liquidity below).
      const maxUsdc = ethers.utils.parseUnits("10000", 6);
      const maxWeth = ethers.utils.parseEther("5");
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, maxUsdc);
      await fundFromWhale(wethAddress, WETH_WHALE, dao.address, maxWeth);

      // currency0 < currency1 (USDC < WETH numerically on mainnet).
      const [c0, c1] =
        usdcAddress.toLowerCase() < wethAddress.toLowerCase()
          ? [usdcAddress, wethAddress]
          : [wethAddress, usdcAddress];
      const poolKey = {
        currency0: c0,
        currency1: c1,
        fee: 3000,
        tickSpacing: 60,
        hooks: ethers.constants.AddressZero,
      };

      // Range straddling the current tick (199951), aligned to tickSpacing 60.
      const tickLower = 199800; // 199800 / 60 = 3330
      const tickUpper = 200100; // 200100 / 60 = 3335
      const liquidity = ethers.BigNumber.from("1000000000000"); // 1e12, ~10% of pool's

      const mintParams = ethers.utils.defaultAbiCoder.encode(
        [
          "(address,address,uint24,int24,address)",
          "int24",
          "int24",
          "uint256",
          "uint128",
          "uint128",
          "address",
          "bytes",
        ],
        [
          [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
          tickLower,
          tickUpper,
          liquidity,
          maxUsdc, // amount0Max
          maxWeth, // amount1Max
          dao.address, // owner — MUST be the DAO or the plugin reverts
          "0x",
        ]
      );
      const settleParams = ethers.utils.defaultAbiCoder.encode(
        ["address", "address"],
        [poolKey.currency0, poolKey.currency1]
      );
      const unlockData = ethers.utils.defaultAbiCoder.encode(
        ["bytes", "bytes[]"],
        [packActions([V4_MINT_POSITION, V4_SETTLE_PAIR]), [mintParams, settleParams]]
      );

      const pm = new ethers.Contract(
        V4_POSITION_MANAGER_MAINNET,
        [
          "function nextTokenId() view returns (uint256)",
          "function ownerOf(uint256) view returns (address)",
        ],
        ethers.provider
      );
      const expectedTokenId = await pm.nextTokenId();

      // Derive the deadline from the FORK's clock, not wall-clock: a shared
      // anvil fork may have had block.timestamp advanced far into the future
      // by earlier time-travel tests (payroll jumps to 2027/2028).
      const nowTs = (await ethers.provider.getBlock("latest")).timestamp;
      const deadline = nowTs + 3600;
      await expect(
        plugin.connect(voter).modifyLiquidities(
          unlockData,
          deadline,
          [usdcAddress, wethAddress], // input currencies
          [maxUsdc, maxWeth], // maxIn
          [], // no output-side slippage assertions on a pure mint
          []
        )
      ).to.emit(plugin, "LiquidityModified");

      // The freshly-minted NFT is owned by the DAO.
      expect(await pm.ownerOf(expectedTokenId)).to.equal(dao.address);
      // The plugin custodies nothing; residual DAO→Permit2 allowance is zero.
      expect(await usdc.balanceOf(plugin.address)).to.equal(0);
      expect(await weth.balanceOf(plugin.address)).to.equal(0);
      expect(await usdc.allowance(dao.address, permit2)).to.equal(0);
      expect(await weth.allowance(dao.address, permit2)).to.equal(0);
    });

    it("reverts a V4 mint whose encoded owner is not the DAO", async function () {
      if (chainKey() !== "mainnet") {
        this.skip();
        return;
      }
      this.timeout(600_000);
      await dao.grant(plugin.address, await voter.getAddress(), UPDATE_ROUTER_PERMISSION_ID);
      await dao.grant(plugin.address, await voter.getAddress(), MANAGE_POSITIONS_PERMISSION_ID);
      await plugin.connect(voter).setV4PositionManager(V4_POSITION_MANAGER_MAINNET);

      const [c0, c1] =
        usdcAddress.toLowerCase() < wethAddress.toLowerCase()
          ? [usdcAddress, wethAddress]
          : [wethAddress, usdcAddress];
      const stranger = ethers.Wallet.createRandom().address;
      const mintParams = ethers.utils.defaultAbiCoder.encode(
        [
          "(address,address,uint24,int24,address)",
          "int24",
          "int24",
          "uint256",
          "uint128",
          "uint128",
          "address",
          "bytes",
        ],
        [[c0, c1, 3000, 60, ethers.constants.AddressZero], 199800, 200100, 1, 1, 1, stranger, "0x"]
      );
      const settleParams = ethers.utils.defaultAbiCoder.encode(["address", "address"], [c0, c1]);
      const unlockData = ethers.utils.defaultAbiCoder.encode(
        ["bytes", "bytes[]"],
        [packActions([V4_MINT_POSITION, V4_SETTLE_PAIR]), [mintParams, settleParams]]
      );

      const nowTs2 = (await ethers.provider.getBlock("latest")).timestamp;
      await expect(
        plugin.connect(voter).modifyLiquidities(unlockData, nowTs2 + 3600, [], [], [], [])
      ).to.be.revertedWithCustomError(plugin, "MintRecipientMustBeDao");
    });

    // Full V4 LP wind-down against the REAL PositionManager: mint a position,
    // then decrease + TAKE_PAIR (funds back to the DAO, exercising the output
    // slippage guard), collect (DECREASE_LIQUIDITY 0 + TAKE_PAIR), and finally
    // BURN_POSITION. Complements the mint-only test above so the whole LP
    // lifecycle is fork-verified, not just unit-verified against the mock PM.
    it("decreases, collects, and burns a real V4 position (funds back to the DAO)", async function () {
      if (chainKey() !== "mainnet") {
        this.skip();
        return;
      }
      this.timeout(600_000);

      await dao.grant(plugin.address, await voter.getAddress(), UPDATE_ROUTER_PERMISSION_ID);
      await dao.grant(plugin.address, await voter.getAddress(), MANAGE_POSITIONS_PERMISSION_ID);
      await plugin.connect(voter).setV4PositionManager(V4_POSITION_MANAGER_MAINNET);

      const [c0, c1] =
        usdcAddress.toLowerCase() < wethAddress.toLowerCase()
          ? [usdcAddress, wethAddress]
          : [wethAddress, usdcAddress];
      const poolKey = [c0, c1, 3000, 60, ethers.constants.AddressZero] as const;
      const tickLower = 199800;
      const tickUpper = 200100;
      const liquidity = ethers.BigNumber.from("1000000000000"); // 1e12

      const maxUsdc = ethers.utils.parseUnits("10000", 6);
      const maxWeth = ethers.utils.parseEther("5");
      await fundFromWhale(usdcAddress, WHALES[chainKey()], dao.address, maxUsdc);
      await fundFromWhale(wethAddress, WETH_WHALE, dao.address, maxWeth);

      const pm = new ethers.Contract(
        V4_POSITION_MANAGER_MAINNET,
        [
          "function nextTokenId() view returns (uint256)",
          "function ownerOf(uint256) view returns (address)",
          "function getPositionLiquidity(uint256) view returns (uint128)",
        ],
        ethers.provider
      );
      const tokenId = await pm.nextTokenId();
      const enc = ethers.utils.defaultAbiCoder;
      const dl = async () => (await ethers.provider.getBlock("latest")).timestamp + 3600;

      // ---- 1. MINT ----
      const mintParams = enc.encode(
        [
          "(address,address,uint24,int24,address)",
          "int24",
          "int24",
          "uint256",
          "uint128",
          "uint128",
          "address",
          "bytes",
        ],
        [poolKey, tickLower, tickUpper, liquidity, maxUsdc, maxWeth, dao.address, "0x"]
      );
      const settlePair = enc.encode(["address", "address"], [c0, c1]);
      await plugin
        .connect(voter)
        .modifyLiquidities(
          enc.encode(
            ["bytes", "bytes[]"],
            [packActions([V4_MINT_POSITION, V4_SETTLE_PAIR]), [mintParams, settlePair]]
          ),
          await dl(),
          [usdcAddress, wethAddress],
          [maxUsdc, maxWeth],
          [],
          []
        );
      expect(await pm.ownerOf(tokenId)).to.equal(dao.address);
      const liqAfterMint = await pm.getPositionLiquidity(tokenId);
      expect(liqAfterMint).to.equal(liquidity);

      // ---- 2. DECREASE half + TAKE_PAIR (funds back to DAO) ----
      const daoUsdcBefore = await usdc.balanceOf(dao.address);
      const daoWethBefore = await weth.balanceOf(dao.address);
      const half = liquidity.div(2);
      const decParams = enc.encode(
        ["uint256", "uint256", "uint128", "uint128", "bytes"],
        [tokenId, half, 0, 0, "0x"]
      );
      const takePair = enc.encode(["address", "address", "address"], [c0, c1, dao.address]);
      await plugin.connect(voter).modifyLiquidities(
        enc.encode(
          ["bytes", "bytes[]"],
          [packActions([V4_DECREASE_LIQUIDITY, V4_TAKE_PAIR]), [decParams, takePair]]
        ),
        await dl(),
        [],
        [],
        [usdcAddress, wethAddress], // output-side slippage guard exercised
        [0, 0]
      );
      expect(await pm.getPositionLiquidity(tokenId)).to.equal(liquidity.sub(half));
      // At least one currency must have flowed back to the DAO.
      const gotUsdc = (await usdc.balanceOf(dao.address)).sub(daoUsdcBefore);
      const gotWeth = (await weth.balanceOf(dao.address)).sub(daoWethBefore);
      expect(gotUsdc.add(gotWeth)).to.be.gt(0);

      // ---- 3. COLLECT = DECREASE_LIQUIDITY(0) + TAKE_PAIR (fees only) ----
      const collectParams = enc.encode(
        ["uint256", "uint256", "uint128", "uint128", "bytes"],
        [tokenId, 0, 0, 0, "0x"]
      );
      await plugin
        .connect(voter)
        .modifyLiquidities(
          enc.encode(
            ["bytes", "bytes[]"],
            [packActions([V4_DECREASE_LIQUIDITY, V4_TAKE_PAIR]), [collectParams, takePair]]
          ),
          await dl(),
          [],
          [],
          [],
          []
        );

      // ---- 4. BURN_POSITION + TAKE_PAIR (removes remaining liquidity, deletes NFT) ----
      const burnParams = enc.encode(
        ["uint256", "uint128", "uint128", "bytes"],
        [tokenId, 0, 0, "0x"]
      );
      await plugin
        .connect(voter)
        .modifyLiquidities(
          enc.encode(
            ["bytes", "bytes[]"],
            [packActions([V4_BURN_POSITION, V4_TAKE_PAIR]), [burnParams, takePair]]
          ),
          await dl(),
          [],
          [],
          [],
          []
        );
      // NFT no longer exists → ownerOf reverts.
      await expect(pm.ownerOf(tokenId)).to.be.reverted;
      // Plugin still custodies nothing.
      expect(await usdc.balanceOf(plugin.address)).to.equal(0);
      expect(await weth.balanceOf(plugin.address)).to.equal(0);
    });
  });
});
