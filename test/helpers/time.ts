// Re-export Hardhat's time utilities under a single, stable import path.
// Tests that need calendar math (e.g. payroll) compose these with a date lib.
export {time, mine, takeSnapshot, reset} from "@nomicfoundation/hardhat-network-helpers";

/** Seconds since unix epoch for a (UTC) calendar moment. */
export function utcTimestamp(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0
): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 1000);
}
