#!/usr/bin/env node
// Seed the locally-deployed DAO with realistic activity so the toy frontend
// (and the Playwright suite) have data on every page. Idempotency is NOT a
// goal — run once against a fresh `just demo-up`.
//
// It impersonates the DAO (which holds the plugins' TRIGGER_*/MANAGE_*
// permissions) and known whales via anvil cheatcodes, then drives each plugin
// directly. This produces the exact on-chain state + events the frontend
// reads — identical to governance-driven ops, just faster to set up.
//
// Usage: node scripts/seed-local.mjs [rpcUrl]
import {readFileSync, readdirSync, statSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {ethers} from "ethers";

const RPC = process.argv[2] || "http://127.0.0.1:8545";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// External mainnet addresses (the fork mirrors mainnet).
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC_WHALE = "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf";
const WETH_WHALE = "0x8EB8a3b98659Cce290402893d0123abb75E3ab28";
// anvil default accounts (payees).
const [A1, A2, A3, A4] = [
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
];
const ZERO = ethers.constants.AddressZero;
const FAR = 99999999999;

// Pick the most-recent manifest (by filesystem mtime) whose DAO actually has
// code on this node. Filenames embed the fork's block.timestamp, which is NOT
// monotonic across fork restarts, so a lexicographic filename sort can grab a
// stale manifest from an unrelated deploy — mtime + a live-code check is the
// reliable selector (mirrors frontend/tests/global-setup.ts).
async function latestDeployment(p) {
  const dir = path.join(ROOT, "deployments");
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("31337-") && f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) throw new Error("No deployments/31337-*.json — run `just deploy-local` first");
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, "utf8"));
    const code = await p.getCode(d.dao);
    if (code && code !== "0x") return d;
  }
  throw new Error("No deployments/31337-*.json has a live DAO on this node — redeploy first");
}

async function main() {
  const p = new ethers.providers.JsonRpcProvider(RPC);
  const d = await latestDeployment(p);
  console.log(`Seeding DAO ${d.dao} via ${RPC}`);

  const TEN_ETH = "0x8AC7230489E80000";
  for (const a of [USDC_WHALE, WETH_WHALE, d.dao]) {
    await p.send("anvil_impersonateAccount", [a]);
    await p.send("anvil_setBalance", [a, TEN_ETH]);
  }
  const usdcW = new ethers.Contract(USDC, ["function transfer(address,uint256) returns (bool)"], p.getSigner(USDC_WHALE));
  const wethW = new ethers.Contract(WETH, ["function transfer(address,uint256) returns (bool)"], p.getSigner(WETH_WHALE));
  const dao = p.getSigner(d.dao);

  const u = (n) => ethers.utils.parseUnits(String(n), 6);
  const e = (n) => ethers.utils.parseEther(String(n));

  console.log("· funding treasury: 80,000 USDC + 8 WETH");
  await (await usdcW.transfer(d.dao, u(80000))).wait();
  await (await wethW.transfer(d.dao, e(8))).wait();

  const payroll = new ethers.Contract(d.payroll, ["function addRecipient(address,address,uint256)"], dao);
  console.log("· payroll: 4 recipients");
  await (await payroll.addRecipient(A1, USDC, u(5000))).wait();
  await (await payroll.addRecipient(A2, USDC, u(3500))).wait();
  await (await payroll.addRecipient(A3, ZERO, e(1.5))).wait();
  await (await payroll.addRecipient(A4, WETH, e(0.8))).wait();

  const cost = new ethers.Contract(d.costRegistry, ["function registerEntry(string,string,uint256,uint32,address)"], dao);
  console.log("· cost registry: 5 entries");
  await (await cost.registerEntry("AWS", "cloud infra", u(1200), 30, A1)).wait();
  await (await cost.registerEntry("Datadog", "monitoring", u(250), 30, A2)).wait();
  await (await cost.registerEntry("OpenAI", "API credits", u(500), 30, A3)).wait();
  await (await cost.registerEntry("GitHub", "seats", u(84), 30, A4)).wait();
  await (await cost.registerEntry("Cloudflare", "CDN+WAF", u(20), 7, A1)).wait();

  const aave = new ethers.Contract(d.aave, ["function supply(address,uint256)"], dao);
  console.log("· AAVE: supply 15,000 USDC + 2 WETH");
  await (await aave.supply(USDC, u(15000))).wait();
  await (await aave.supply(WETH, e(2))).wait();

  const v3 = new ethers.Contract(
    d.uniswapV3,
    ["function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,uint256))"],
    dao
  );
  console.log("· UniswapV3: 2 positions (0.3% + 0.05%)");
  await (await v3.mint([USDC, WETH, 3000, -887220, 887220, u(2000), e(1), 0, 0, FAR])).wait();
  await (await v3.mint([USDC, WETH, 500, -887270, 887270, u(1500), e(0.75), 0, 0, FAR])).wait();

  const v4 = new ethers.Contract(
    d.uniswapV4,
    ["function swap(bytes,bytes[],uint256,address,uint256,address,uint256)"],
    dao
  );
  console.log("· UniswapV4: 2 swaps (USDC -> WETH via V3 route)");
  for (const amt of [2000, 3000]) {
    const a = u(amt);
    const path0 = ethers.utils.solidityPack(["address", "uint24", "address"], [USDC, 3000, WETH]);
    const input = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256", "uint256", "bytes", "bool"],
      [d.dao, a, 0, path0, true]
    );
    await (await v4.swap("0x00", [input], FAR, USDC, a, WETH, 1)).wait();
  }

  console.log("Seed complete.");
}
main().catch((err) => {
  console.error("Seed failed:", err.reason || err.message);
  process.exit(1);
});
