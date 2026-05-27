import {readFileSync, readdirSync, existsSync, statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

// Verify the local stack is up before running the suite, and surface the DAO
// addresses to the specs via env. We DON'T orchestrate anvil/deploy here —
// that's `just demo-up` — so failures point the user at the one command that
// fixes them rather than silently spinning up a half-stack.
const RPC = process.env.E2E_RPC || "http://127.0.0.1:8545";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// Candidate manifests, newest filesystem-mtime first. Filename timestamps
// embed the fork's block.timestamp (not real time) and aren't monotonic across
// fork restarts, so mtime is the reliable ordering.
function deploymentsByRecency(): Record<string, string>[] {
  const dir = path.join(REPO_ROOT, "deployments");
  if (!existsSync(dir)) throw new Error("no deployments/ — run `just demo-up`");
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("31337-") && f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) throw new Error("no deployments/31337-*.json — run `just demo-up`");
  return files.map((f) => JSON.parse(readFileSync(f, "utf8")));
}

export default async function globalSetup(): Promise<void> {
  let chainId: string;
  try {
    chainId = (await rpc("eth_chainId")) as string;
  } catch {
    throw new Error(`Cannot reach anvil at ${RPC}. Bring the stack up first:  just demo-up`);
  }
  if (parseInt(chainId, 16) !== 31337) {
    throw new Error(`Expected chainId 31337 at ${RPC}, got ${parseInt(chainId, 16)}`);
  }

  // Pick the most-recent manifest whose DAO actually has code on this node —
  // tolerates stale manifests and fork restarts.
  const candidates = deploymentsByRecency();
  let d: Record<string, string> | undefined;
  for (const c of candidates) {
    const code = (await rpc("eth_getCode", [c.dao, "latest"])) as string;
    if (code && code !== "0x") {
      d = c;
      break;
    }
  }
  if (!d) {
    throw new Error(
      `No deployment manifest in deployments/ has a live DAO on ${RPC} — run \`just demo-up\``
    );
  }

  // Hand addresses to the specs.
  process.env.E2E_DAO = d.dao;
  process.env.E2E_GOVERNANCE = d.governance;
  process.env.E2E_PAYROLL = d.payroll;
  process.env.E2E_COST = d.costRegistry;
  process.env.E2E_AAVE = d.aave;
  process.env.E2E_UNISWAPV3 = d.uniswapV3;
  process.env.E2E_UNISWAPV4 = d.uniswapV4;
  console.log(`[global-setup] stack OK — DAO ${d.dao} on ${RPC}`);
}
