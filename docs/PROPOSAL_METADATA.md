# Proposal metadata schema

All proposals authored against the Cyberdyne DAO carry an IPFS-pinned JSON blob as their `metadata` argument to `TokenVoting.createProposal(...)`. The schema is stable so the toy frontend (P6), the production UI (P7), and the subgraph all decode it consistently.

## Schema

```json
{
  "title":          "Migrate Universal Router to v3.1",
  "description":    "Markdown body of the proposal. **Bold**, links, lists are all fine.\n\nMultiple paragraphs OK.",
  "discussion":     "https://forum.cyberdyne.dao/t/router-migration/123",
  "encodedActions": [
    {
      "to":   "0xPlugin",
      "value": "0",
      "data":  "0x...",
      "humanReadable": "UniswapV4Plugin.setUniversalRouter(0xNewRouter)"
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string, ≤120 chars | ✓ | Single-line. Shown in proposal list. |
| `description` | string | ✓ | Markdown. Shown in proposal detail. |
| `discussion` | string (URL) | ✕ | Optional pointer to off-chain discussion (forum, Snapshot, Discord). UI renders as a link. |
| `encodedActions` | array | ✕ | Pre-decoded action descriptors for UI display. The actual on-chain `Action[]` is the source of truth; this field is for UX (showing "what this proposal will do" without re-decoding calldata client-side). |
| `encodedActions[].to` | address | ✓ if present | Action target. |
| `encodedActions[].value` | uint256 (as string — JSON doesn't represent uint256) | ✓ if present | ETH value attached. |
| `encodedActions[].data` | hex bytes | ✓ if present | Raw calldata. |
| `encodedActions[].humanReadable` | string | ✕ | Free-text caption ("UniswapV4Plugin.setUniversalRouter(0xNewRouter)"). |

Any additional top-level fields are tolerated by the UI but not displayed. Keep the JSON small (<10 kB) so it pins fast and IPFS gateways return it within the UI's read-budget.

## How it's pinned

`scripts/pin-metadata.js` (this repo) is the canonical pinner. Stages:

1. Validates against the schema above (fast-fails on missing required fields).
2. Sorts top-level keys so the same logical proposal always produces the same CID (avoids accidental double-pins from key-order differences).
3. Uploads to Pinata via `PINATA_JWT` (preferred) or web3.storage via `WEB3_STORAGE_TOKEN` (fallback). Add additional pinners by extending the script.
4. Prints the `ipfs://<cid>` URI on stdout; the bare CID lands on stderr for shell capture.

Usage:

```bash
cat <<'EOF' | PINATA_JWT=$PINATA_JWT node scripts/pin-metadata.js
{
  "title": "Migrate Universal Router to v3.1",
  "description": "Uniswap shipped router v3.1 last week...",
  "discussion": "https://forum.cyberdyne.dao/t/router-migration/123"
}
EOF
# → prints: ipfs://Qm...
```

Pin scripts that ship later (e.g. CI-side bulk-pin on proposal-batch import) should call this same script so the schema validation stays in one place.

## How it's consumed

- **Frontend (custom UI + toy)**: fetches `ipfs://<cid>` via a public gateway (cloudflare-ipfs.com, ipfs.io) or a configured private gateway. Parses, displays. Falls back to "metadata unavailable" if all gateways time out.
- **Subgraph**: does NOT resolve IPFS in mappings (Graph Node does support IPFS reads, but they make indexing fragile). The subgraph stores the IPFS URI on the `Proposal` entity (when TokenVoting integration lands); UI resolves at render time.

## Conventions

- Use plain ASCII in `title`. Markdown in `description` is fine.
- Reference action targets by their on-chain address in `humanReadable`; the UI joins to the plugin's canonical name via the published `frontend-abi/` package.
- One pin per proposal — re-using a CID across proposals breaks the subgraph's join.
- Pin IS NOT reversible; once a CID is on the network, treat the metadata as public.

## Open: alternate storage

The current scope pins to IPFS via Pinata + web3.storage. If/when the DAO migrates to a more permanent solution (Arweave, Filecoin via IPFS pinning service, self-hosted IPFS cluster), the schema stays the same — only the pinner script changes. The `ipfs://` URI scheme is preserved for backward compatibility.
