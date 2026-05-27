// Shared helpers across plugin mappings. Keep type-light — the Graph
// runtime is AssemblyScript-flavored TypeScript, no JS standard lib.

import {BigInt, Bytes, ethereum} from "@graphprotocol/graph-ts";

export function txEventId(event: ethereum.Event): string {
  return event.transaction.hash.toHex() + "-" + event.logIndex.toString();
}

export function pluginEntityId(plugin: Bytes): string {
  return plugin.toHex();
}

export function recipientEntityId(plugin: Bytes, payee: Bytes): string {
  return plugin.toHex() + "." + payee.toHex();
}

export function payoutEntityId(plugin: Bytes, period: BigInt): string {
  return plugin.toHex() + "." + period.toString();
}

export function payoutItemEntityId(plugin: Bytes, period: BigInt, payee: Bytes): string {
  return plugin.toHex() + "." + period.toString() + "." + payee.toHex();
}

export function allowlistEntryId(plugin: Bytes, token: Bytes): string {
  return plugin.toHex() + "." + token.toHex();
}

// V3 positions are uniquely identified by the NPM-issued tokenId (a global
// across the chain). The schema id is the decimal string so it's stable
// across re-indexing.
export function v3PositionId(tokenId: BigInt): string {
  return tokenId.toString();
}

// CostRegistry entries are keyed by (plugin, entry id). One plugin instance
// has its own auto-incremented entry ids.
export function costEntryId(plugin: Bytes, entryId: BigInt): string {
  return plugin.toHex() + "." + entryId.toString();
}
