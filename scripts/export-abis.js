#!/usr/bin/env node
/**
 * Export plain JSON ABIs from Hardhat artifacts into frontend-abi/,
 * so the in-repo Svelte toy frontend (P6) and the production UI repo (P7)
 * can consume them without TypeScript-only tooling.
 *
 * Run via `npm run build:abi` (also invoked from CI before publishing the
 * `@cyberdyne/dao-contracts` npm package in P7).
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const ARTIFACTS = path.join(ROOT, "artifacts", "src");
const OUT = path.join(ROOT, "frontend-abi");

if (!fs.existsSync(ARTIFACTS)) {
  console.error(`No artifacts dir at ${ARTIFACTS}. Run \`npx hardhat compile\` first.`);
  process.exit(1);
}

fs.rmSync(OUT, {recursive: true, force: true});
fs.mkdirSync(OUT, {recursive: true});

let count = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name.endsWith(".dbg.json")) continue;
    const artifact = JSON.parse(fs.readFileSync(full, "utf8"));
    if (!artifact.abi) continue;
    const name = path.basename(entry.name, ".json");
    fs.writeFileSync(
      path.join(OUT, `${name}.json`),
      JSON.stringify({contractName: name, abi: artifact.abi}, null, 2)
    );
    count++;
  }
}

walk(ARTIFACTS);
console.log(`Exported ${count} ABIs to ${path.relative(ROOT, OUT)}/`);
