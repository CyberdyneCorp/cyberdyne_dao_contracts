/**
 * AaveLendingPlugin fork integration tests.
 *
 * Runs against `mainnetFork` and `baseFork` so the DAO interacts with the
 * REAL AAVE v3 Pool. Validates that aTokens / debt tokens land on the DAO,
 * the plugin holds nothing, and the adapter swap mechanic doesn't lose
 * positions opened through the old adapter.
 *
 * Scope deviation from ROADMAP P4: we use the MinimalDAO mock rather than
 * the live DAOFactory + TokenVoting. End-to-end DAOFactory bootstrap lives
 * in P5; here we want focused, fast tests of lending behavior against the
 * real AAVE pool without the full governance dance.
 *
 * Skipped (describe block not registered) when running on a non-fork
 * network — see test/helpers/fork-guard.ts.
 */
import {expect} from "chai";
import {ethers, network} from "hardhat";
import type {Signer} from "ethers";
import {
  AaveLendingPlugin,
  AaveLendingPlugin__factory,
  AaveV3Adapter,
  AaveV3Adapter__factory,
  MinimalDAO,
  MinimalDAO__factory,
} from "../../../typechain-types";
import {onlyOn} from "../../helpers/fork-guard";
import {EXTERNAL, type ExternalChain} from "../../helpers/addresses";
import {fundFromWhale, setEthBalance} from "../../helpers/impersonate";
import {takeSnapshot} from "../../helpers/time";
import type {SnapshotRestorer} from "@nomicfoundation/hardhat-network-helpers";

const TRIGGER_LENDING_PERMISSION_ID = ethers.utils.id("TRIGGER_LENDING_PERMISSION");
const UPDATE_ADAPTER_PERMISSION_ID = ethers.utils.id("UPDATE_ADAPTER_PERMISSION");
const EXECUTE_PERMISSION_ID = ethers.utils.id("EXECUTE_PERMISSION");

// Variable-rate borrows on AAVE v3.
const VARIABLE_RATE = 2;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// AAVE v3 Pool surface we need from the fork test.
const POOL_ABI = [
  // AAVE v3 getReserveData returns a single DataTypes.ReserveData struct → one
  // outer tuple (configuration is a nested tuple). Access via
  // `(await pool.getReserveData(x)).aTokenAddress`.
  "function getReserveData(address asset) view returns (tuple(tuple(uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt) reserveData)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];

// Known whales by chain. Verified holders at recent block heights — if CI
// pins drift far enough these may need refreshing from etherscan.
const USDC_WHALES: Record<ExternalChain, string> = {
  mainnet: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
  base: "0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3",
};
const WETH_WHALES: Record<ExternalChain, string> = {
  mainnet: "0x8EB8a3b98659Cce290402893d0123abb75E3ab28", // Avalanche bridge
  base: "0x4200000000000000000000000000000000000006", // WETH itself often holds WETH on Base — fallback
};

function chainKey(): ExternalChain {
  if (network.name === "mainnetFork") return "mainnet";
  if (network.name === "baseFork") return "base";
  throw new Error(`Unsupported fork network: ${network.name}`);
}

async function deployProxied(
  signer: Signer,
  dao: string,
  adapter: string,
  allowlist: string[]
): Promise<AaveLendingPlugin> {
  const impl = await new AaveLendingPlugin__factory(signer).deploy();
  await impl.deployed();
  const initData = impl.interface.encodeFunctionData("initialize", [dao, adapter, allowlist]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
  const proxy = await Proxy.deploy(impl.address, initData);
  await proxy.deployed();
  return AaveLendingPlugin__factory.connect(proxy.address, signer);
}

onlyOn(["mainnetFork", "baseFork"], () => {
  describe(`AaveLendingPlugin (fork: ${network.name}) [fork]`, function () {
    // Public-RPC forks intermittently return a zeroed state read under load
    // (anvil lazy-fetches state on demand). Retry transient failures; a real
    // contract bug still fails all attempts. Block-pinning reduces this further.
    this.retries(2);

    let deployer: Signer;
    let voter: Signer;
    let dao: MinimalDAO;
    let adapter: AaveV3Adapter;
    let plugin: AaveLendingPlugin;
    let usdc: import("ethers").Contract;
    let weth: import("ethers").Contract;
    let pool: import("ethers").Contract;
    let usdcAddress: string;
    let wethAddress: string;
    let poolAddress: string;
    let aUsdcAddress: string;
    let snapshot: SnapshotRestorer;

    before(async () => {
      [deployer, voter] = await ethers.getSigners();

      const chain = chainKey();
      usdcAddress = EXTERNAL[chain].USDC;
      wethAddress = EXTERNAL[chain].WETH;
      poolAddress = EXTERNAL[chain].AAVE_V3_POOL;

      usdc = new ethers.Contract(usdcAddress, ERC20_ABI, ethers.provider);
      weth = new ethers.Contract(wethAddress, ERC20_ABI, ethers.provider);
      pool = new ethers.Contract(poolAddress, POOL_ABI, ethers.provider);

      // Read aUSDC address directly from the AAVE pool so we don't hardcode.
      const reserveData = await pool.getReserveData(usdcAddress);
      aUsdcAddress = reserveData.aTokenAddress;
    });

    beforeEach(async () => {
      dao = await new MinimalDAO__factory(deployer).deploy();
      await dao.deployed();

      adapter = await new AaveV3Adapter__factory(deployer).deploy(poolAddress);
      await adapter.deployed();

      plugin = await deployProxied(deployer, dao.address, adapter.address, []);

      await dao.grant(plugin.address, await voter.getAddress(), TRIGGER_LENDING_PERMISSION_ID);
      await dao.grant(plugin.address, await voter.getAddress(), UPDATE_ADAPTER_PERMISSION_ID);
      await dao.grant(dao.address, plugin.address, EXECUTE_PERMISSION_ID);

      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      if (snapshot) await snapshot.restore();
    });

    it("supplies USDC and mints aUSDC to the DAO (plugin holds nothing)", async () => {
      const amount = ethers.utils.parseUnits("1000", 6);
      await fundFromWhale(usdcAddress, USDC_WHALES[chainKey()], dao.address, amount);

      const aUsdc = new ethers.Contract(aUsdcAddress, ERC20_ABI, ethers.provider);
      const daoBefore = await usdc.balanceOf(dao.address);
      const aBefore = await aUsdc.balanceOf(dao.address);

      await plugin.connect(voter).supply(usdcAddress, amount);

      // DAO's USDC decreased by amount; aUSDC increased by ~amount. aTokens
      // round down on mint (liquidity-index math) — allow a few wei.
      expect(await usdc.balanceOf(dao.address)).to.equal(daoBefore.sub(amount));
      const aAfter = await aUsdc.balanceOf(dao.address);
      expect(aAfter.sub(aBefore)).to.be.closeTo(amount, 10);

      // Plugin never holds funds.
      expect(await usdc.balanceOf(plugin.address)).to.equal(0);
      expect(await aUsdc.balanceOf(plugin.address)).to.equal(0);
      // Adapter is stateless too.
      expect(await usdc.balanceOf(adapter.address)).to.equal(0);
      expect(await aUsdc.balanceOf(adapter.address)).to.equal(0);
    });

    it("withdraws USDC, burns aUSDC, and returns underlying to the DAO", async () => {
      const amount = ethers.utils.parseUnits("500", 6);
      await fundFromWhale(usdcAddress, USDC_WHALES[chainKey()], dao.address, amount);
      await plugin.connect(voter).supply(usdcAddress, amount);

      const aUsdc = new ethers.Contract(aUsdcAddress, ERC20_ABI, ethers.provider);
      const half = amount.div(2);
      const usdcBefore = await usdc.balanceOf(dao.address);
      const aBefore = await aUsdc.balanceOf(dao.address);

      await plugin.connect(voter).withdraw(usdcAddress, half);

      expect((await usdc.balanceOf(dao.address)).sub(usdcBefore)).to.equal(half);
      expect(aBefore.sub(await aUsdc.balanceOf(dao.address))).to.be.closeTo(half, 10);
    });

    it("borrows USDC against WETH collateral with debt issued to the DAO", async () => {
      // Supply WETH as collateral first.
      const collateral = ethers.utils.parseEther("5");
      await fundFromWhale(wethAddress, WETH_WHALES[chainKey()], dao.address, collateral);
      await plugin.connect(voter).supply(wethAddress, collateral);

      // Now borrow a modest amount of USDC at variable rate. AAVE caps
      // borrows at the available-borrows ceiling — we keep well under it.
      const borrowAmount = ethers.utils.parseUnits("500", 6);

      const acctBefore = await pool.getUserAccountData(dao.address);
      expect(acctBefore.totalCollateralBase).to.be.gt(0);
      expect(acctBefore.totalDebtBase).to.equal(0);

      const usdcBefore = await usdc.balanceOf(dao.address);
      await plugin.connect(voter).borrow(usdcAddress, borrowAmount, VARIABLE_RATE);

      // DAO got the borrowed USDC.
      expect((await usdc.balanceOf(dao.address)).sub(usdcBefore)).to.equal(borrowAmount);

      // Health factor is finite and > 1e18 (above liquidation threshold).
      const acctAfter = await pool.getUserAccountData(dao.address);
      expect(acctAfter.totalDebtBase).to.be.gt(0);
      expect(acctAfter.healthFactor).to.be.gt(ethers.utils.parseEther("1"));

      // Read the variable debt token address from AAVE and assert non-zero balance.
      const reserveData = await pool.getReserveData(usdcAddress);
      const variableDebtUsdc = new ethers.Contract(
        reserveData.variableDebtTokenAddress,
        ERC20_ABI,
        ethers.provider
      );
      expect(await variableDebtUsdc.balanceOf(dao.address)).to.be.closeTo(borrowAmount, 10);
    });

    it("repays USDC debt (partial) and reduces the variable debt token balance", async () => {
      // Set up: supply WETH, borrow USDC.
      const collateral = ethers.utils.parseEther("5");
      await fundFromWhale(wethAddress, WETH_WHALES[chainKey()], dao.address, collateral);
      await plugin.connect(voter).supply(wethAddress, collateral);

      // Read account data after supplying collateral. Besides validating the
      // collateral, this warms AAVE's reserve/user-config storage in the fork
      // — without it, anvil's lazy state fetch can leave the subsequent borrow
      // computing against incomplete state and silently borrowing nothing.
      const acct = await pool.getUserAccountData(dao.address);
      expect(acct.totalCollateralBase).to.be.gt(0);

      const borrowAmount = ethers.utils.parseUnits("500", 6);
      await plugin.connect(voter).borrow(usdcAddress, borrowAmount, VARIABLE_RATE);

      const reserveData = await pool.getReserveData(usdcAddress);
      const variableDebtUsdc = new ethers.Contract(
        reserveData.variableDebtTokenAddress,
        ERC20_ABI,
        ethers.provider
      );
      const debtBefore = await variableDebtUsdc.balanceOf(dao.address);
      expect(debtBefore).to.be.gt(0); // borrow established debt

      // Repay half. DAO already has the borrowed USDC sitting in its treasury.
      const repayAmount = borrowAmount.div(2);
      await plugin.connect(voter).repay(usdcAddress, repayAmount, VARIABLE_RATE);

      const debtAfter = await variableDebtUsdc.balanceOf(dao.address);
      // Debt decreased by ~repayAmount (within accrued interest tolerance — 1
      // block's worth at most).
      expect(debtBefore.sub(debtAfter)).to.be.closeTo(repayAmount, repayAmount.div(1000));
    });

    it("adapter migration: legacy supply readable through old adapter; new ops via new adapter", async () => {
      const amount = ethers.utils.parseUnits("250", 6);
      await fundFromWhale(usdcAddress, USDC_WHALES[chainKey()], dao.address, amount.mul(2));

      // Supply via Adapter A (the default).
      await plugin.connect(voter).supply(usdcAddress, amount);
      const aUsdc = new ethers.Contract(aUsdcAddress, ERC20_ABI, ethers.provider);
      const aBalAfterA = await aUsdc.balanceOf(dao.address);
      expect(aBalAfterA).to.be.closeTo(amount, 10);

      // Vote to swap to a second AaveV3Adapter (simulating a v4 adapter
      // wrapper — same shape, different deployment).
      const adapterB = await new AaveV3Adapter__factory(deployer).deploy(poolAddress);
      await adapterB.deployed();
      await plugin.connect(voter).setAdapter(adapterB.address);
      expect(await plugin.adapter()).to.equal(adapterB.address);

      // New supply routes through Adapter B. Both adapters point at the same
      // pool here (since v4 isn't deployed yet), so aUSDC balance on the DAO
      // simply increases — the read of the legacy position through the AAVE
      // protocol is unchanged for the DAO.
      await plugin.connect(voter).supply(usdcAddress, amount);
      const aBalAfterB = await aUsdc.balanceOf(dao.address);
      expect(aBalAfterB.sub(aBalAfterA)).to.be.closeTo(amount, 10);

      // The "legacy adapter readability" guarantee in v1: the adapter is
      // stateless, the position lives on AAVE. Adapter A still answers
      // queries against the same pool, so the position is still reachable
      // by anyone holding the underlying pool address.
      expect(await adapter.poolAddress()).to.equal(poolAddress);
      expect(await adapterB.poolAddress()).to.equal(poolAddress);
    });
  });
});
