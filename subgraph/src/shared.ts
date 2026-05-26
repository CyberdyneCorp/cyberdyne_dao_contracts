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
