// Populate the local DAO with a varied set of proposals so the toy frontend
// has interesting things to display. Mix of EXECUTED (history) + OPEN (so the
// connected wallet can vote / execute via the UI).
//
// Run after `bash scripts/demo-up.sh` (which sets PUBLIC_DAO_MAINNET in
// frontend/.env.local) — this script reads the same env to discover the
// addresses, impersonates the gov-token holder (anvil acct #0 = the deployer
// = 0xf39F…2266), and submits proposals via TokenVoting.
//
// Usage:  node scripts/seed-proposals.mjs

import {ethers} from "ethers";
import fs from "fs";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const provider = new ethers.providers.JsonRpcProvider(RPC);
// Anvil acct #0 — holds the entire 1M-CYBR voting supply after deploy.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);
const VOTE = {None: 0, Abstain: 1, Yes: 2, No: 3};

function envAddresses() {
  // Parse frontend/.env.local for the canonical 7-address tuple. demo-up.sh
  // wrote it; we read it back here so the script never has to embed addrs.
  const env = fs.readFileSync("frontend/.env.local", "utf8");
  const line = env.match(/^PUBLIC_DAO_MAINNET=(.*)$/m);
  if (!line) throw new Error("PUBLIC_DAO_MAINNET not in frontend/.env.local");
  const [dao, payroll, uniswap, aave, governance, costRegistry, uniswapV3] = line[1].split(",");
  return {dao, payroll, uniswap, aave, governance, costRegistry, uniswapV3};
}

// Mainnet external addresses.
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const V3_NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

const ABI = {
  tv: [
    "function createProposal(bytes _metadata, tuple(address to, uint256 value, bytes data)[] _actions, uint256 _allowFailureMap, uint64 _startDate, uint64 _endDate, uint8 _voteOption, bool _tryEarlyExecution) returns (uint256 proposalId)",
    "event ProposalCreated(uint256 indexed proposalId, address indexed creator, uint64 startDate, uint64 endDate, bytes metadata, tuple(address to, uint256 value, bytes data)[] actions, uint256 allowFailureMap)",
  ],
  erc20: ["function transfer(address,uint256)"],
  weth: ["function deposit() payable"],
  payroll: [
    "function addRecipient(address payee, address token, uint256 amount, string description)",
  ],
  aavePlugin: [
    "function previewSupplyActions(address asset, uint256 amount) view returns (tuple(address to, uint256 value, bytes data)[])",
    "function previewBorrowActions(address asset, uint256 amount, uint256 interestRateMode) view returns (tuple(address to, uint256 value, bytes data)[])",
  ],
  v3Plugin: [
    "function previewMintActions(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) p) view returns (tuple(address to, uint256 value, bytes data)[])",
  ],
  v4Plugin: [
    "function swap(bytes commands, bytes[] inputs, uint256 deadline, address tokenIn, uint256 amountIn, address tokenOut, uint256 minAmountOut)",
  ],
  costRegistry: [
    "function registerEntry(string name, string description, uint256 costUsdc, uint32 frequencyDays, address payee)",
  ],
};

const FUTURE = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

async function submit(tv, metadata, actions, autoExecute) {
  let tx;
  try {
    tx = await tv.createProposal(
      ethers.utils.toUtf8Bytes(metadata),
      actions,
      0, // allowFailureMap — every action must succeed
      0,
      0,
      autoExecute ? VOTE.Yes : VOTE.None,
      autoExecute
    );
  } catch (err) {
    console.log(`  [FAILED-SEND] — ${metadata}: ${err.reason || err.message}`);
    return null;
  }
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    console.log(`  [REVERTED] — ${metadata}`);
    return null;
  }
  const parsed = receipt.logs
    .map((l) => {
      try {
        return tv.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const created = parsed.find((p) => p.name === "ProposalCreated");
  const id = created ? created.args.proposalId.toString() : "?";
  const verb = autoExecute ? "EXECUTED" : "OPEN";
  console.log(`  [${verb}] proposal ${id} — ${metadata}`);
  return id;
}

async function main() {
  const a = envAddresses();
  console.log(`Seeding proposals into DAO ${a.dao} via TokenVoting ${a.governance}`);
  console.log(`Submitter: ${await wallet.getAddress()}\n`);
  const tv = new ethers.Contract(a.governance, ABI.tv, wallet);
  const erc20 = new ethers.utils.Interface(ABI.erc20);
  const weth = new ethers.utils.Interface(ABI.weth);
  const payroll = new ethers.utils.Interface(ABI.payroll);

  // --- Executed history --------------------------------------------------
  // 1. Treasury USDC transfer to a clean burner (executed).
  await submit(
    tv,
    "Treasury: send 1,000 USDC to grants reserve",
    [
      {
        to: USDC,
        value: 0,
        data: erc20.encodeFunctionData("transfer", [
          "0x0000000000000000000000000000000000C0FFEE",
          ethers.utils.parseUnits("1000", 6),
        ]),
      },
    ],
    true
  );

  // 2. AAVE supply 2,000 USDC — uses previewSupplyActions to produce the
  //    approve / supply / approve-0 batch (executed).
  const aavePlugin = new ethers.Contract(a.aave, ABI.aavePlugin, provider);
  const supplyBatch = await aavePlugin.previewSupplyActions(USDC, ethers.utils.parseUnits("2000", 6));
  await submit(
    tv,
    "AAVE: supply 2,000 USDC into the v3 pool",
    supplyBatch.map((x) => ({to: x.to, value: x.value, data: x.data})),
    true
  );

  // --- Open (pending) — the user can vote / execute these from the UI ----
  // 3. Treasury ETH transfer (open).
  await submit(
    tv,
    "Treasury: send 0.01 ETH to ops reserve",
    [
      {
        to: "0x0000000000000000000000000000000000C0FFEE",
        value: ethers.utils.parseEther("0.01"),
        data: "0x",
      },
    ],
    false
  );

  // 4. Custom call: WETH.deposit{value: 0.5 ETH}() — wrap ETH (open).
  await submit(
    tv,
    "Custom: wrap 0.5 ETH → WETH (treasury rebalance)",
    [
      {to: WETH, value: ethers.utils.parseEther("0.5"), data: weth.encodeFunctionData("deposit", [])},
    ],
    false
  );

  // 5. Payroll: add a new recipient with a human description (open).
  await submit(
    tv,
    "Payroll: add 0x70997970…dc79C8 — \"Senior dev monthly salary\" (5,000 USDC)",
    [
      {
        to: a.payroll,
        value: 0,
        data: payroll.encodeFunctionData("addRecipient", [
          "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          USDC,
          ethers.utils.parseUnits("5000", 6),
          "Senior dev monthly salary",
        ]),
      },
    ],
    false
  );

  // 6. Uniswap V3 mint (open) — full-range USDC/WETH 0.30% via the plugin's
  //    previewMintActions helper.
  const v3Plugin = new ethers.Contract(a.uniswapV3, ABI.v3Plugin, provider);
  const v3Batch = await v3Plugin.previewMintActions({
    token0: USDC,
    token1: WETH,
    fee: 3000,
    tickLower: -887220,
    tickUpper: 887220,
    amount0Desired: ethers.utils.parseUnits("500", 6),
    amount1Desired: ethers.utils.parseEther("0.2"),
    amount0Min: 0,
    amount1Min: 0,
    deadline: FUTURE,
  });
  await submit(
    tv,
    "Uniswap V3: mint full-range USDC/WETH 0.30% LP (500 USDC + 0.2 WETH)",
    v3Batch.map((x) => ({to: x.to, value: x.value, data: x.data})),
    false
  );

  // 7. Cost Registry: register a recurring USDC cost (open). Uses the plugin's
  //    registerEntry ABI directly so the proposals list shows the typed call
  //    via the decoder + humanizer; executes cleanly.
  const costIface = new ethers.utils.Interface(ABI.costRegistry);
  await submit(
    tv,
    "Cost Registry: register \"AWS hosting\" — 12,000 USDC every 30d",
    [
      {
        to: a.costRegistry,
        value: 0,
        data: costIface.encodeFunctionData("registerEntry", [
          "AWS hosting",
          "Cloud infra retainer",
          ethers.utils.parseUnits("12000", 6),
          30,
          "0x000000000000000000000000000000000000abcd",
        ]),
      },
    ],
    false
  );

  console.log("\nDone — open /proposals in the frontend to see them.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
