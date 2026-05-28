// Human-readable decoding of a proposal action's calldata. Turns an opaque
// `{to, data}` (especially a Raw Call) into "Target: Payroll plugin · function
// addRecipient(payee, token, amount)" with each argument decoded and addresses
// labeled. View-only — best-effort: unknown selectors degrade gracefully.

import {ethers} from "ethers";
import {getAbi} from "@cyberdyne/dao-contracts";
import type {ChainConfig} from "./types";
import {resolveToken, shortAddress} from "./format";

const PLUGINS = [
  "PayrollPlugin",
  "UniswapV4Plugin",
  "AaveLendingPlugin",
  "CostRegistryPlugin",
  "UniswapV3Plugin",
] as const;

// Common surfaces a Raw Call might target that aren't one of our plugins.
const EXTRA_ABIS = [
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function execute(bytes32 callId, (address to,uint256 value,bytes data)[] actions, uint256 allowFailureMap)",
];

let _ifaces: ethers.utils.Interface[] | null = null;
function interfaces(): ethers.utils.Interface[] {
  if (_ifaces) return _ifaces;
  _ifaces = PLUGINS.map((p) => new ethers.utils.Interface(getAbi(p)));
  _ifaces.push(new ethers.utils.Interface(EXTRA_ABIS));
  return _ifaces;
}

/** Friendly name for a known address (a DAO plugin or a tracked token), else null. */
export function labelAddress(cfg: ChainConfig | undefined, addr: string): string | null {
  if (!addr || !ethers.utils.isAddress(addr)) return null;
  const lc = addr.toLowerCase();
  const d = cfg?.dao;
  if (d) {
    const map: Record<string, string | undefined> = {
      DAO: d.dao,
      "Payroll plugin": d.payroll,
      "UniswapV4 plugin": d.uniswap,
      "AAVE plugin": d.aave,
      "CostRegistry plugin": d.costRegistry,
      "UniswapV3 plugin": d.uniswapV3,
      "TokenVoting plugin": d.governance,
    };
    for (const [label, a] of Object.entries(map)) {
      if (a && a.toLowerCase() === lc) return label;
    }
  }
  const tok = resolveToken(cfg, addr);
  if (["ETH", "USDC", "WETH"].includes(tok.symbol)) return tok.symbol;
  return null;
}

export type DecodedArg = {name: string; type: string; value: string; label: string | null};
export type DecodedCall = {
  to: string;
  targetLabel: string | null; // "Payroll plugin" / "USDC" / null (unknown)
  selector: string; // 0xabcd1234
  fn: string | null; // "addRecipient"
  signature: string | null; // "addRecipient(address,address,uint256)"
  args: DecodedArg[] | null; // decoded inputs, or null if selector unknown
  value: string; // wei
};

function formatArg(type: string, raw: unknown): string {
  if (type === "bool") return raw ? "true" : "false";
  if (type.startsWith("uint") || type.startsWith("int")) return (raw as ethers.BigNumber).toString();
  return String(raw);
}

/** Best-effort decode of `data` (4-byte selector + args) against the known
 *  plugin ABIs + common ERC20/DAO surfaces. */
export function decodeCall(cfg: ChainConfig | undefined, to: string, data: string): DecodedCall {
  const selector = (data || "0x").slice(0, 10);
  const base: DecodedCall = {
    to,
    targetLabel: labelAddress(cfg, to),
    selector,
    fn: null,
    signature: null,
    args: null,
    value: "0",
  };
  if (!data || data.length < 10) return base;
  for (const iface of interfaces()) {
    try {
      const frag = iface.getFunction(selector);
      const decoded = iface.decodeFunctionData(frag, data);
      const args: DecodedArg[] = frag.inputs.map((inp, i) => ({
        name: inp.name || `arg${i}`,
        type: inp.type,
        value: formatArg(inp.type, decoded[i]),
        label: inp.type === "address" ? labelAddress(cfg, decoded[i] as string) : null,
      }));
      return {
        ...base,
        fn: frag.name,
        signature: `${frag.name}(${frag.inputs.map((x) => x.type).join(",")})`,
        args,
      };
    } catch {
      /* selector not in this interface — try the next */
    }
  }
  return base;
}

/** One-line readable target for display: the label, or a short address. */
export function targetDisplay(d: DecodedCall): string {
  return d.targetLabel ?? shortAddress(d.to);
}
