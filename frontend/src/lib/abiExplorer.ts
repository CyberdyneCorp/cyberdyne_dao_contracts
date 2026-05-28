// ABI explorer (Model): paste a contract address → get its ABI → list every
// function + its parameters → encode a call to one of them. Used by the
// Proposals "Call a contract function" builder to turn a human-typed function +
// args into a ProposalAction (which then flows through the existing
// decode/simulate/submit panel).
//
// ABI source order:
//   1. Bundled — our own plugins + ERC20, since locally-deployed plugins are on
//      no public explorer.
//   2. Sourcify — public verified-contract repo, no API key. Looked up on the
//      *mainnet* chain id (the 31337 fork mirrors mainnet state).
//   3. Manual paste — full ABI JSON, or human-readable signatures, as a fallback
//      for anything Sourcify doesn't have.

import {ethers} from "ethers";
import {getAbi} from "@cyberdyne/dao-contracts";
import type {ChainConfig} from "./types";

export type AbiSource = "bundled" | "sourcify" | "pasted";

export type FnParam = {name: string; type: string};
export type FnDesc = {
  key: string; // canonical signature: "transfer(address,uint256)"
  name: string;
  inputs: FnParam[];
  payable: boolean;
  stateMutability: string; // "view" | "pure" | "nonpayable" | "payable"
};

export type LoadedAbi = {
  iface: ethers.utils.Interface;
  source: AbiSource;
  label: string | null; // friendly contract name when known
  functions: FnDesc[];
};

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint256 amount)",
];

const PLUGIN_ABIS: Record<string, string> = {
  PayrollPlugin: "Payroll plugin",
  UniswapV4Plugin: "UniswapV4 plugin",
  AaveLendingPlugin: "AAVE plugin",
  CostRegistryPlugin: "CostRegistry plugin",
  UniswapV3Plugin: "UniswapV3 plugin",
};

/** Build the function list from any ethers Interface. */
function describeFunctions(iface: ethers.utils.Interface): FnDesc[] {
  return Object.values(iface.functions)
    .map((frag) => ({
      key: `${frag.name}(${frag.inputs.map((i) => i.type).join(",")})`,
      name: frag.name,
      inputs: frag.inputs.map((i, idx) => ({name: i.name || `arg${idx}`, type: i.type})),
      payable: frag.payable || frag.stateMutability === "payable",
      stateMutability: frag.stateMutability,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type AbiInput = ConstructorParameters<typeof ethers.utils.Interface>[0];

function toLoaded(abi: AbiInput, source: AbiSource, label: string | null): LoadedAbi {
  const iface = new ethers.utils.Interface(abi);
  return {iface, source, label, functions: describeFunctions(iface)};
}

/** If `address` is one of this DAO's plugins or a tracked token, return the
 *  bundled ABI + a friendly label. */
export function bundledAbiFor(cfg: ChainConfig | undefined, address: string): LoadedAbi | null {
  if (!cfg || !ethers.utils.isAddress(address)) return null;
  const lc = address.toLowerCase();
  const d = cfg.dao;
  if (d) {
    const pluginAddr: Record<string, string | undefined> = {
      PayrollPlugin: d.payroll,
      UniswapV4Plugin: d.uniswap,
      AaveLendingPlugin: d.aave,
      CostRegistryPlugin: d.costRegistry,
      UniswapV3Plugin: d.uniswapV3,
    };
    for (const [name, addr] of Object.entries(pluginAddr)) {
      if (addr && addr.toLowerCase() === lc) return toLoaded(getAbi(name), "bundled", PLUGIN_ABIS[name]);
    }
  }
  for (const [sym, addr] of Object.entries(cfg.external)) {
    if (addr && addr.toLowerCase() === lc) return toLoaded(ERC20_ABI, "bundled", `${sym} (ERC20)`);
  }
  return null;
}

/** Fetch a verified ABI from Sourcify for `address` on `lookupChainId`
 *  (mainnet = 1). Throws a readable error if not found / unreachable. */
export async function sourcifyAbi(lookupChainId: number, address: string): Promise<LoadedAbi> {
  const checksummed = ethers.utils.getAddress(address);
  const url = `https://sourcify.dev/server/files/any/${lookupChainId}/${checksummed}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Sourcify unreachable (${(e as Error).message})`);
  }
  if (res.status === 404) {
    throw new Error(`Not verified on Sourcify for chain ${lookupChainId}. Paste the ABI manually.`);
  }
  if (!res.ok) throw new Error(`Sourcify returned HTTP ${res.status}`);
  const body = (await res.json()) as {files?: Array<{name: string; content: string}>};
  const metaFile = body.files?.find((f) => f.name === "metadata.json");
  if (!metaFile) throw new Error("Sourcify response has no metadata.json");
  let abi: unknown;
  try {
    abi = (JSON.parse(metaFile.content) as {output?: {abi?: unknown}}).output?.abi;
  } catch {
    throw new Error("Could not parse Sourcify metadata.json");
  }
  if (!Array.isArray(abi) || abi.length === 0) throw new Error("Sourcify metadata has no ABI");
  return toLoaded(abi as AbiInput, "sourcify", null);
}

/** Parse a user-pasted ABI: either a full JSON ABI array, or one human-readable
 *  signature per line (e.g. `function transfer(address to, uint256 amount)`). */
export function parsePastedAbi(text: string): LoadedAbi {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste an ABI JSON array or function signatures");
  let abi: AbiInput;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    abi = JSON.parse(trimmed) as AbiInput;
  } else {
    abi = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (l.startsWith("function ") ? l : `function ${l}`));
  }
  const loaded = toLoaded(abi, "pasted", null);
  if (loaded.functions.length === 0) throw new Error("No callable functions found in the pasted ABI");
  return loaded;
}

/** Coerce a raw string input into the value ethers wants for `type`. Arrays and
 *  tuples are entered as JSON; numbers as decimal strings; bools as true/false. */
export function coerceArg(type: string, raw: string): unknown {
  const v = raw.trim();
  if (type.includes("[") || type.startsWith("tuple")) return JSON.parse(v);
  if (type === "bool") return v.toLowerCase() === "true";
  if (type.startsWith("uint") || type.startsWith("int")) return ethers.BigNumber.from(v || "0");
  return v; // address, string, bytes, bytesN
}

/** Encode a call to `fn` (canonical signature) with the given raw string args,
 *  returning {data, value} ready for a ProposalAction. */
export function encodeCall(
  loaded: LoadedAbi,
  fnKey: string,
  rawArgs: string[],
  valueWei: string
): {data: string; value: string} {
  const fn = loaded.functions.find((f) => f.key === fnKey);
  if (!fn) throw new Error(`Function ${fnKey} not in ABI`);
  const args = fn.inputs.map((inp, i) => coerceArg(inp.type, rawArgs[i] ?? ""));
  const data = loaded.iface.encodeFunctionData(fnKey, args);
  return {data, value: (valueWei || "0").trim()};
}
