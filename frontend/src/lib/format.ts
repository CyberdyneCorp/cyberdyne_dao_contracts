// Human-readable formatting helpers for the inspector UI. The contracts deal
// in raw integer amounts (e.g. 5000000000 = 5,000 USDC); these turn those into
// grouped, symbol-tagged strings for display. View-only — never feed the
// formatted string back into a contract call.

import {ethers} from "ethers";
import type {ChainConfig} from "./types";

const ZERO = ethers.constants.AddressZero;

/** {symbol, decimals} for a token address, using the chain's known externals.
 *  Falls back to a short address + 18 decimals for unknown tokens. */
export function resolveToken(
  cfg: ChainConfig | undefined,
  token: string
): {symbol: string; decimals: number} {
  if (!token || token === ZERO) return {symbol: "ETH", decimals: 18};
  const ext = cfg?.external ?? {};
  const lc = token.toLowerCase();
  if (ext.USDC && lc === ext.USDC.toLowerCase()) return {symbol: "USDC", decimals: 6};
  if (ext.WETH && lc === ext.WETH.toLowerCase()) return {symbol: "WETH", decimals: 18};
  return {symbol: `${token.slice(0, 6)}…${token.slice(-4)}`, decimals: 18};
}

/** Group the integer part with thousands separators and trim trailing zeros
 *  from the fraction. `formatUnits(5000000000, 6)` → "5,000". */
export function formatUnits(raw: ethers.BigNumberish, decimals: number): string {
  const s = ethers.utils.formatUnits(raw, decimals);
  const [intPart, fracPart] = s.split(".");
  const sign = intPart.startsWith("-") ? "-" : "";
  const grouped = BigInt(intPart.replace("-", "")).toLocaleString("en-US");
  const frac = fracPart ? fracPart.replace(/0+$/, "") : "";
  return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/** `formatToken(5000000000, {symbol:"USDC",decimals:6})` → "5,000 USDC". */
export function formatToken(
  raw: ethers.BigNumberish,
  token: {symbol: string; decimals: number}
): string {
  return `${formatUnits(raw, token.decimals)} ${token.symbol}`;
}

/** Convenience: resolve the token from a chain config + format in one call. */
export function formatAmount(
  cfg: ChainConfig | undefined,
  rawAmount: ethers.BigNumberish,
  token: string
): string {
  return formatToken(rawAmount, resolveToken(cfg, token));
}

/** Short 0x… address for display. */
export function shortAddress(addr: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
}

/** Reduce a thrown error to a concise, user-facing message (strips ethers'
 *  verbose envelope, surfaces a revert reason or custom-error name). */
export function errorMessage(err: unknown): string {
  const e = err as {reason?: string; data?: {message?: string}; error?: {message?: string}; message?: string};
  return (
    e?.reason ||
    e?.data?.message ||
    e?.error?.message ||
    (e?.message ? e.message.split("(")[0].trim() : "Unknown error")
  );
}
