#!/usr/bin/env node
/**
 * Copy ABIs from the parent contracts package's frontend-abi/ into
 * subgraph/abis/. Run via `npm run prepare:abis` before `graph codegen`.
 *
 * If frontend-abi/ is empty (fresh checkout), run `npm run build:abi` in
 * the repo root first.
 */
const fs = require("fs");
const path = require("path");

const SUBGRAPH_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SUBGRAPH_ROOT, "..");
const SRC = path.join(REPO_ROOT, "frontend-abi");
const DST = path.join(SUBGRAPH_ROOT, "abis");

if (!fs.existsSync(SRC)) {
  console.error(
    `frontend-abi/ not found at ${SRC}. Run \`npm run build:abi\` in the repo root first.`
  );
  process.exit(1);
}

fs.mkdirSync(DST, {recursive: true});

const wanted = [
  "PayrollPlugin",
  "UniswapV4Plugin",
  "UniswapV3Plugin",
  "AaveLendingPlugin",
  "CostRegistryPlugin",
];
let copied = 0;
for (const name of wanted) {
  const srcFile = path.join(SRC, `${name}.json`);
  const dstFile = path.join(DST, `${name}.json`);
  if (!fs.existsSync(srcFile)) {
    console.warn(`Skipping ${name}.json (not in frontend-abi/)`);
    continue;
  }
  // The subgraph runtime wants ONLY the abi array, not the wrapping {contractName, abi}.
  const wrapped = JSON.parse(fs.readFileSync(srcFile, "utf8"));
  fs.writeFileSync(dstFile, JSON.stringify(wrapped.abi, null, 2));
  copied++;
}
console.log(`Copied ${copied} ABIs into subgraph/abis/`);
