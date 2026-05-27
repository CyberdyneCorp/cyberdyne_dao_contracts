// Optional IPFS proposal-metadata pinning.
//
// Aragon TokenVoting stores proposal `metadata` as arbitrary bytes — by
// convention an `ipfs://<cid>` pointer to a JSON document. The toy frontend
// works without IPFS (it just stores the summary string inline as UTF-8
// bytes), but when a Pinata JWT is configured we pin a structured metadata
// document and submit the CID instead — matching the production schema the
// custom UI + subgraph expect.
//
// Feature-flagged on PUBLIC_PINATA_JWT. Pinata is the default because its
// pinJSONToIPFS endpoint is a single authenticated POST; other pinning
// services can be added behind the same `pinProposalMetadata` interface.

import {env} from "$env/dynamic/public";

// Bump when the document shape changes so consumers can branch on it.
export const METADATA_SCHEMA_VERSION = "cyberdyne-proposal/1";

// Matches the canonical schema in docs/PROPOSAL_METADATA.md so the toy
// frontend, the production UI, and the subgraph all decode it consistently.
// `schema`/`createdAt` are extra top-level fields (tolerated per the doc).
export type ProposalMetadata = {
  schema: string;
  title: string;
  description: string;
  // Pre-decoded action descriptors for UI display; the on-chain Action[] is
  // the source of truth. `humanReadable` is the action's summary line.
  encodedActions: {to: string; value: string; data: string; humanReadable?: string}[];
  createdAt: number; // unix seconds (extra field; not in the required set)
};

export function ipfsEnabled(): boolean {
  const jwt = env.PUBLIC_PINATA_JWT;
  return !!jwt && jwt.trim().length > 0;
}

/**
 * Build the canonical metadata document for a proposal. Kept pure so callers
 * can preview/hash it without pinning.
 */
export function buildProposalMetadata(
  title: string,
  description: string,
  actions: {to: string; value: string; data: string; summary?: string}[]
): ProposalMetadata {
  return {
    schema: METADATA_SCHEMA_VERSION,
    title,
    description,
    encodedActions: actions.map((a) => ({
      to: a.to,
      value: a.value,
      data: a.data,
      humanReadable: a.summary,
    })),
    createdAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Pin `meta` to IPFS via Pinata and return an `ipfs://<cid>` URI. Throws if
 * IPFS isn't configured (callers should gate on `ipfsEnabled()`) or the pin
 * request fails. The gateway prefix is intentionally `ipfs://` (not an HTTP
 * gateway) so consumers resolve via their own preferred gateway.
 */
export async function pinProposalMetadata(meta: ProposalMetadata): Promise<string> {
  const jwt = env.PUBLIC_PINATA_JWT;
  if (!jwt) throw new Error("No PUBLIC_PINATA_JWT configured");
  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt.trim()}`,
    },
    body: JSON.stringify({
      pinataContent: meta,
      pinataMetadata: {name: `proposal-${meta.createdAt}`},
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pinata pin failed (HTTP ${res.status})${body ? `: ${body.slice(0, 120)}` : ""}`);
  }
  const json = (await res.json()) as {IpfsHash?: string};
  if (!json.IpfsHash) throw new Error("Pinata returned no IpfsHash");
  return `ipfs://${json.IpfsHash}`;
}

// Public gateway used to RESOLVE metadata for display (read path). Override
// with PUBLIC_IPFS_GATEWAY if you run your own. Defaults to ipfs.io.
function gatewayUrl(cid: string): string {
  const base = (env.PUBLIC_IPFS_GATEWAY || "https://ipfs.io/ipfs/").trim();
  const sep = base.endsWith("/") ? "" : "/";
  return `${base}${sep}${cid}`;
}

/**
 * Best-effort resolve a proposal's `metadata` string to a human title.
 *  - `ipfs://<cid>`: fetch the JSON from the gateway, return `.title`.
 *  - anything else: return it unchanged (inline summary / raw bytes).
 * Never throws — returns the raw input on any failure so the UI degrades
 * gracefully (shows the CID instead of a title).
 */
export async function resolveMetadataTitle(metadata: string): Promise<string> {
  if (!metadata.startsWith("ipfs://")) return metadata;
  const cid = metadata.slice("ipfs://".length);
  try {
    const res = await fetch(gatewayUrl(cid), {signal: AbortSignal.timeout(4000)});
    if (!res.ok) return metadata;
    const doc = (await res.json()) as {title?: string};
    return doc.title && doc.title.length > 0 ? doc.title : metadata;
  } catch {
    return metadata;
  }
}
