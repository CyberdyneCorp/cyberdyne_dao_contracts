#!/usr/bin/env node
/**
 * Coverage gate: fails (exit 1) if any of {lines, branches, functions, statements}
 * for files under an "enforced" plugin path falls below the threshold.
 *
 * Implemented one plugin at a time: P2 ships PayrollPlugin; P3 adds UniswapV4Plugin;
 * P4 adds AaveLendingPlugin. Add the path here when its phase merges.
 *
 * Reads coverage/coverage-summary.json produced by `npx hardhat coverage`.
 */

const fs = require("fs");
const path = require("path");

const THRESHOLD = 90;
const SUMMARY = path.join(process.cwd(), "coverage", "coverage-summary.json");

// Sub-paths under src/ that the gate enforces. Add others as their phase lands.
const ENFORCED = [
  path.join("src", "plugins", "payroll") + path.sep,
  path.join("src", "plugins", "uniswap-v4") + path.sep,
  path.join("src", "plugins", "aave") + path.sep,
];

if (!fs.existsSync(SUMMARY)) {
  console.error(`coverage-summary.json not found at ${SUMMARY}`);
  console.error("Run `npx hardhat coverage` first.");
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(SUMMARY, "utf8"));
const cwd = process.cwd();

let failed = false;
const targets = Object.entries(summary).filter(([file]) => {
  if (file === "total") return false;
  const rel = path.relative(cwd, file);
  return ENFORCED.some((p) => rel.startsWith(p));
});

if (targets.length === 0) {
  console.log("Coverage gate: no files under the enforced phase paths — skipping.");
  process.exit(0);
}

for (const [file, metrics] of targets) {
  const rel = path.relative(cwd, file);
  for (const k of ["lines", "branches", "functions", "statements"]) {
    const pct = metrics[k].pct;
    const status = pct >= THRESHOLD ? "OK" : "FAIL";
    if (pct < THRESHOLD) failed = true;
    console.log(`[${status}] ${rel} — ${k}: ${pct}%`);
  }
}

if (failed) {
  console.error(`\nCoverage gate FAILED: at least one metric is below ${THRESHOLD}%.`);
  process.exit(1);
}
console.log(`\nCoverage gate passed (>= ${THRESHOLD}% on all metrics for enforced paths).`);
