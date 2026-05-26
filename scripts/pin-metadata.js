#!/usr/bin/env node
/**
 * Pin a proposal-metadata JSON to IPFS via Pinata (primary) or web3.storage
 * (fallback). Returns the CID + the `ipfs://<cid>` URI ready to be passed as
 * the `metadata` field of `TokenVoting.createProposal(...)`.
 *
 * Schema (see docs/PROPOSAL_METADATA.md for full spec):
 *   {
 *     "title":            string,            // required, <= 120 chars
 *     "description":      string,            // required, markdown allowed
 *     "discussion":       string | null,     // optional URL (forum, snapshot, etc.)
 *     "encodedActions":   Action[] | null    // optional pre-decoded actions for UI display
 *   }
 *
 * Usage:
 *   echo '{"title":"...","description":"..."}' | \
 *     PINATA_JWT=$PINATA_JWT node scripts/pin-metadata.js
 *   # or
 *   node scripts/pin-metadata.js path/to/metadata.json
 *
 * Env:
 *   PINATA_JWT          — preferred. From pinata.cloud Dashboard → API Keys.
 *   WEB3_STORAGE_TOKEN  — fallback. From web3.storage account.
 *
 * Exit codes: 0 success, 1 schema/IO error, 2 upstream IPFS error.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const REQUIRED_FIELDS = ["title", "description"];

function readMetadata(arg) {
  if (arg && arg !== "-") {
    const file = path.resolve(arg);
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }
    return fs.readFileSync(file, "utf8");
  }
  // Read from stdin.
  return fs.readFileSync(0, "utf8");
}

function validate(meta) {
  for (const field of REQUIRED_FIELDS) {
    if (typeof meta[field] !== "string" || meta[field].length === 0) {
      console.error(`Missing or empty required field: ${field}`);
      process.exit(1);
    }
  }
  if (meta.title.length > 120) {
    console.error(`title exceeds 120 chars (${meta.title.length})`);
    process.exit(1);
  }
  if (meta.discussion != null && typeof meta.discussion !== "string") {
    console.error("discussion must be a string or null");
    process.exit(1);
  }
  if (meta.encodedActions != null && !Array.isArray(meta.encodedActions)) {
    console.error("encodedActions must be an array or null");
    process.exit(1);
  }
}

function postJson(host, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {host, path: pathname, method: "POST", headers},
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({status: res.statusCode, body: buf});
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${buf}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function pinViaPinata(jwt, json) {
  const body = JSON.stringify({
    pinataMetadata: {name: `cyberdyne-proposal-${Date.now()}.json`},
    pinataContent: JSON.parse(json),
  });
  const res = await postJson(
    "api.pinata.cloud",
    "/pinning/pinJSONToIPFS",
    {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body
  );
  const parsed = JSON.parse(res.body);
  if (!parsed.IpfsHash) throw new Error(`Pinata response missing IpfsHash: ${res.body}`);
  return parsed.IpfsHash;
}

async function pinViaWeb3Storage(token, json) {
  const res = await postJson(
    "api.web3.storage",
    "/upload",
    {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      "X-Name": `cyberdyne-proposal-${Date.now()}.json`,
    },
    json
  );
  const parsed = JSON.parse(res.body);
  if (!parsed.cid) throw new Error(`web3.storage response missing cid: ${res.body}`);
  return parsed.cid;
}

async function main() {
  const raw = readMetadata(process.argv[2]);
  const meta = JSON.parse(raw);
  validate(meta);

  // Normalize to a deterministic JSON ordering (sorted keys) so the same
  // logical proposal always pins to the same CID. Avoids accidental
  // double-pins from key-order differences.
  const normalized = JSON.stringify(meta, Object.keys(meta).sort());

  let cid;
  if (process.env.PINATA_JWT) {
    cid = await pinViaPinata(process.env.PINATA_JWT, normalized);
  } else if (process.env.WEB3_STORAGE_TOKEN) {
    cid = await pinViaWeb3Storage(process.env.WEB3_STORAGE_TOKEN, normalized);
  } else {
    console.error(
      "Set PINATA_JWT (preferred) or WEB3_STORAGE_TOKEN to authorize an upload."
    );
    process.exit(1);
  }

  // Emit both forms — the URI is what goes into `metadata` on
  // TokenVoting.createProposal, the bare CID is what some explorers want.
  console.log(`ipfs://${cid}`);
  console.error(`CID: ${cid}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(2);
});
