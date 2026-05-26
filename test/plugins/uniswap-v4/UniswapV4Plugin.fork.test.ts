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
 * as opaque bytes — encoding choices belong to the proposal builder. For
 * the fork happy-path test we use the V3 SWAP_EXACT_IN_SINGLE command
 * (0x00 in the Universal Router command set), because:
 *   - Universal Router routes V2/V3/V4 commands; V3 is well-documented and
 *     has the most reliable pool liquidity on mainnet+Base today.
 *   - V4 single-hop encoding requires PoolKey + hook config + currency
 *     deltas that are non-trivial to assemble by hand here.
 * Full end-to-end V4 swap verification (with PoolKey + currency settlement)
 * is deferred to P5's e2e tests where the proposal builder is part of the
 * scenario. See `it.skip` markers below for the V4-specific assertions.
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
    initialAllowlist,
  ]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await Proxy.deploy(impl.address, initData);
  await proxy.deployed();
  return UniswapV4Plugin__factory.connect(proxy.address, signer);
}

function chainKey(): ExternalChain {
  if (network.name === "mainnetFork") return "mainnet";
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

onlyOn(["mainnetFork", "baseFork"], () => {
  describe(`UniswapV4Plugin (fork: ${network.name}) [fork]`, () => {
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

    // V4-native single-hop swap encoding deferred to P5's e2e tests. The
    // plugin doesn't care which router command it's passing; the V3 happy-path
    // test above already proves the approve/Permit2/route action batch flows
    // end-to-end against the real Universal Router. P5 builds the V4 proposal
    // payload with the production PoolKey/hook config.
    it.skip("V4-native single-hop USDC → WETH swap (deferred to P5 e2e)", async () => {
      /* see preamble */
    });
  });
});
