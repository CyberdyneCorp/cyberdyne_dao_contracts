// Semantic humanizer — turns a DecodedCall into a one-line "what this proposal
// actually does" sentence. Per-function recipes per plugin (Payroll / V4 / V3 /
// AAVE / CostRegistry) plus common ERC-20 / WETH / OSx-DAO surfaces. Falls
// back to "<fn> on <target>" when no recipe matches.
//
// All amounts are formatted via resolveToken() so the user sees "1,000 USDC"
// instead of "1000000000". Addresses are short-formed or labeled when known.

import {ethers} from "ethers";
import type {ChainConfig} from "./types";
import type {DecodedCall} from "./decode";
import {formatUnits, resolveToken, shortAddress} from "./format";
import {labelAddress} from "./decode";

const NA = "N/A";

/** Display an address as its plugin/token label when known, else short hex. */
function addrLabel(cfg: ChainConfig | undefined, addr: string): string {
  if (!addr || !ethers.utils.isAddress(addr)) return addr || NA;
  const lab = labelAddress(cfg, addr);
  return lab ?? shortAddress(addr);
}

/** "1,000 USDC" for ERC-20 amounts where the token contract is known. */
function tokenAmount(cfg: ChainConfig | undefined, token: string, amountStr: string): string {
  const t = resolveToken(cfg, token);
  return `${formatUnits(amountStr, t.decimals)} ${t.symbol}`;
}

/** Ordinal: 1 → "1st", 21 → "21st", etc. */
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

type Recipe = (call: DecodedCall, cfg: ChainConfig | undefined) => string;

const RECIPES: Record<string, Recipe> = {
  // --- PayrollPlugin --------------------------------------------------------
  "addRecipient(address,address,uint256,string)": (c, cfg) => {
    const [payee, token, amount, description] = c.args!;
    const label = description.value ? ` — "${description.value}"` : "";
    return `Payroll: add ${addrLabel(cfg, payee.value)} as monthly recipient, ${tokenAmount(
      cfg,
      token.value,
      amount.value
    )}${label}`;
  },
  "removeRecipient(address)": (c, cfg) =>
    `Payroll: remove ${addrLabel(cfg, c.args![0].value)} from monthly recipients`,
  "setAmount(address,uint256)": (c, cfg) =>
    `Payroll: update ${addrLabel(cfg, c.args![0].value)}'s salary → ${c.args![1].value} atomic units`,
  "setRecipientDescription(address,string)": (c, cfg) => {
    const [payee, description] = c.args!;
    return description.value
      ? `Payroll: relabel ${addrLabel(cfg, payee.value)} → "${description.value}"`
      : `Payroll: clear ${addrLabel(cfg, payee.value)}'s description`;
  },
  "setPayDayOfMonth(uint8)": (c) => {
    const day = parseInt(c.args![0].value, 10);
    return `Payroll: move monthly pay day → ${ordinal(day)} of the month`;
  },
  "setMaxRecipients(uint256)": (c) =>
    `Payroll: raise active-recipient cap → ${c.args![0].value}`,
  "forcePayPeriod(uint256)": (c) => {
    const period = parseInt(c.args![0].value, 10);
    const year = Math.floor(period / 12);
    const month = (period % 12) + 1;
    return `Payroll: force-pay skipped period ${year}-${String(month).padStart(2, "0")}`;
  },
  "executePayroll()": () => "Payroll: run the monthly crank (permissionless)",
  "executePayrollPage(uint256)": (c) =>
    `Payroll: run a crank page of up to ${c.args![0].value} recipients`,

  // --- UniswapV4Plugin ------------------------------------------------------
  "swap(bytes,bytes[],uint256,address,uint256,address,uint256)": (c, cfg) => {
    const [, , , tokenIn, amountIn, tokenOut, minOut] = c.args!;
    return `Uniswap V4 swap: ${tokenAmount(cfg, tokenIn.value, amountIn.value)} → ≥ ${tokenAmount(
      cfg,
      tokenOut.value,
      minOut.value
    )}`;
  },
  "modifyLiquidities(bytes,uint256,address[],uint256[],address[],uint256[])": () =>
    "Uniswap V4: modify LP position (mint / increase / decrease / collect / burn — encoded in unlockData)",
  "setUniversalRouter(address)": (c, cfg) =>
    `Uniswap V4: set Universal Router → ${addrLabel(cfg, c.args![0].value)}`,
  "setV4PositionManager(address)": (c, cfg) =>
    `Uniswap V4: set V4 PositionManager → ${addrLabel(cfg, c.args![0].value)}`,

  // --- UniswapV3Plugin ------------------------------------------------------
  "increaseLiquidity(uint256,uint256,uint256,uint256,uint256,uint256)": (c) =>
    `Uniswap V3: increase liquidity on position #${c.args![0].value}`,
  "decreaseLiquidity(uint256,uint128,uint256,uint256,uint256)": (c) =>
    `Uniswap V3: decrease liquidity on position #${c.args![0].value}`,
  "collect(uint256,uint128,uint128)": (c) =>
    `Uniswap V3: collect fees from position #${c.args![0].value} to the DAO`,
  "burn(uint256)": (c) => `Uniswap V3: burn empty position #${c.args![0].value}`,
  "setPositionManager(address)": (c, cfg) =>
    `Uniswap V3: set NonfungiblePositionManager → ${addrLabel(cfg, c.args![0].value)}`,
  // setAllowedToken is shared by V3 + V4 — same humanization either way.
  "setAllowedToken(address,bool)": (c, cfg) => {
    const [token, allowed] = c.args!;
    const verb = allowed.value === "true" ? "allow" : "disallow";
    return `${
      c.targetLabel === "UniswapV3 plugin" ? "Uniswap V3" : "Uniswap V4"
    }: ${verb} ${addrLabel(cfg, token.value)} for swaps / LP`;
  },

  // --- AaveLendingPlugin ----------------------------------------------------
  "supply(address,uint256)": (c, cfg) =>
    `AAVE: supply ${tokenAmount(cfg, c.args![0].value, c.args![1].value)} from the DAO treasury`,
  "withdraw(address,uint256)": (c, cfg) =>
    `AAVE: withdraw ${tokenAmount(cfg, c.args![0].value, c.args![1].value)} back to the DAO treasury`,
  "borrow(address,uint256,uint256)": (c, cfg) => {
    const [asset, amount, mode] = c.args!;
    const modeLabel = mode.value === "1" ? "Stable" : "Variable";
    return `AAVE: borrow ${tokenAmount(cfg, asset.value, amount.value)} (${modeLabel} rate)`;
  },
  "repay(address,uint256,uint256)": (c, cfg) => {
    const [asset, amount, mode] = c.args!;
    const modeLabel = mode.value === "1" ? "Stable" : "Variable";
    return `AAVE: repay ${tokenAmount(cfg, asset.value, amount.value)} (${modeLabel} debt)`;
  },
  "setAdapter(address)": (c, cfg) =>
    `AAVE: swap adapter → ${addrLabel(cfg, c.args![0].value)}`,
  "setAllowedAsset(address,bool)": (c, cfg) => {
    const [asset, allowed] = c.args!;
    return `AAVE: ${allowed.value === "true" ? "allow" : "disallow"} ${addrLabel(
      cfg,
      asset.value
    )} as a lending asset`;
  },

  // --- CostRegistryPlugin ---------------------------------------------------
  "registerEntry(string,string,uint256,uint256,address)": (c, cfg) => {
    const [name, , cost, days, payee] = c.args!;
    return `Cost registry: register "${name.value}" — ${tokenAmount(
      cfg,
      cfg?.external?.USDC ?? ethers.constants.AddressZero,
      cost.value
    )} every ${days.value}d → ${addrLabel(cfg, payee.value)}`;
  },
  "updateEntry(uint256,string,string,uint256,uint256,address)": (c, cfg) => {
    const [id, name, , cost, days, payee] = c.args!;
    return `Cost registry: update #${id.value} "${name.value}" — ${tokenAmount(
      cfg,
      cfg?.external?.USDC ?? ethers.constants.AddressZero,
      cost.value
    )} every ${days.value}d → ${addrLabel(cfg, payee.value)}`;
  },
  "removeEntry(uint256)": (c) => `Cost registry: remove entry #${c.args![0].value}`,
  "setMaxEntries(uint256)": (c) =>
    `Cost registry: raise max-entry cap → ${c.args![0].value}`,
  "processDue()": () => "Cost registry: pay every due entry (permissionless crank)",

  // --- ERC-20 / WETH (when the target is a token) ---------------------------
  "transfer(address,uint256)": (c, cfg) =>
    `Treasury: send ${tokenAmount(cfg, c.to, c.args![1].value)} → ${addrLabel(
      cfg,
      c.args![0].value
    )}`,
  "approve(address,uint256)": (c, cfg) => {
    const [spender, amount] = c.args!;
    if (amount.value === "0") {
      return `Revoke ${addrLabel(cfg, c.to)} approval → ${addrLabel(cfg, spender.value)}`;
    }
    return `Approve ${tokenAmount(cfg, c.to, amount.value)} → ${addrLabel(cfg, spender.value)}`;
  },
  "deposit()": (c) => `WETH: wrap ${ethers.utils.formatEther(c.value || "0")} ETH → WETH`,
  "withdraw(uint256)": (c) => `WETH: unwrap ${ethers.utils.formatEther(c.args![0].value)} WETH → ETH`,
};

/** Turn a DecodedCall into a one-line "what this proposal does" sentence.
 *  Falls back to "<fn> on <target>" / "Raw call to <target>" when no recipe
 *  matches the function signature. */
export function humanize(call: DecodedCall, cfg: ChainConfig | undefined): string {
  // Pure ETH transfer (no calldata, but a non-zero value).
  if (!call.signature && (!call.args || call.args.length === 0)) {
    if (call.value && call.value !== "0") {
      return `Treasury: send ${ethers.utils.formatEther(call.value)} ETH → ${addrLabel(cfg, call.to)}`;
    }
    return `Raw call to ${addrLabel(cfg, call.to)} (selector ${call.selector})`;
  }
  if (call.signature && RECIPES[call.signature]) {
    try {
      return RECIPES[call.signature](call, cfg);
    } catch {
      /* fall through to the generic fallback below */
    }
  }
  if (call.fn) {
    return `${call.fn}() on ${addrLabel(cfg, call.to)}`;
  }
  return `Unrecognized call (selector ${call.selector}) on ${addrLabel(cfg, call.to)}`;
}

/** For a batch (e.g. V3 mint = 5 actions), produce a single sentence that says
 *  what the whole batch achieves, falling back to a numbered list. Recognizes
 *  the common "approve → op → revoke" pattern around a known plugin call. */
export function humanizeBatch(calls: DecodedCall[], cfg: ChainConfig | undefined): string {
  if (calls.length === 0) return "Empty batch";
  if (calls.length === 1) return humanize(calls[0], cfg);

  // Approve-sandwich pattern: ERC-20 approves bracketing a single op (V3 mint,
  // V3 increase, AAVE supply/repay all follow this shape).
  const center = calls[Math.floor(calls.length / 2)];
  const allApprovesAround = calls.every((c, i) => {
    if (i === Math.floor(calls.length / 2)) return true;
    return c.signature === "approve(address,uint256)";
  });
  if (allApprovesAround && center.signature && RECIPES[center.signature]) {
    return humanize(center, cfg);
  }

  return `${calls.length}-action batch: ${calls.map((c) => humanize(c, cfg)).join(" · ")}`;
}
