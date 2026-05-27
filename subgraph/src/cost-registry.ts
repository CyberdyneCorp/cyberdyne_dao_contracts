// CostRegistry event handlers — see docs/EVENTS.md.
//
// Recurring operating costs paid in a single configured token (USDC by
// default; migratable via setPaymentToken). The crank pays due entries and
// emits CostPaid per entry + one CostsProcessed per batch.

import {Address, BigInt} from "@graphprotocol/graph-ts";
import {
  CostRegistryPlugin as CostRegistryPluginContract,
  EntryRegistered,
  EntryUpdated,
  EntryRemoved,
  CostPaid,
  CostsProcessed,
  PaymentTokenUpdated,
} from "../generated/CostRegistryPlugin/CostRegistryPlugin";
import {
  Dao,
  CostRegistryPlugin,
  CostEntry,
  CostPayment,
  CostCrankRun,
  PaymentTokenMigration,
} from "../generated/schema";
import {txEventId, pluginEntityId, costEntryId} from "./shared";

function getOrCreatePlugin(addr: Address, timestamp: BigInt): CostRegistryPlugin {
  let id = pluginEntityId(addr);
  let plugin = CostRegistryPlugin.load(id);
  if (plugin == null) {
    plugin = new CostRegistryPlugin(id);
    let contract = CostRegistryPluginContract.bind(addr);
    let daoAddr = contract.dao();
    let daoId = daoAddr.toHex();
    let dao = Dao.load(daoId);
    if (dao == null) {
      dao = new Dao(daoId);
      dao.createdAt = timestamp;
    }
    dao.costRegistryPlugin = id;
    dao.save();
    plugin.dao = daoId;
    plugin.paymentToken = contract.paymentToken();
  }
  return plugin as CostRegistryPlugin;
}

export function handleEntryRegistered(event: EntryRegistered): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  plugin.save();

  let id = costEntryId(event.address, event.params.id);
  let e = new CostEntry(id);
  e.dao = plugin.dao;
  e.plugin = plugin.id;
  e.entryId = event.params.id;
  e.payee = event.params.payee;
  e.costUsdc = event.params.costUsdc;
  e.frequencyDays = event.params.frequencyDays.toI32();
  e.name = event.params.name;
  e.active = true;
  e.registeredAt = event.block.timestamp;
  e.save();
}

export function handleEntryUpdated(event: EntryUpdated): void {
  let id = costEntryId(event.address, event.params.id);
  let e = CostEntry.load(id);
  if (e == null) return;
  e.payee = event.params.payee;
  e.costUsdc = event.params.costUsdc;
  e.frequencyDays = event.params.frequencyDays.toI32();
  e.save();
}

export function handleEntryRemoved(event: EntryRemoved): void {
  let id = costEntryId(event.address, event.params.id);
  let e = CostEntry.load(id);
  if (e == null) return;
  e.active = false;
  e.removedAt = event.block.timestamp;
  e.save();
}

export function handleCostPaid(event: CostPaid): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  let entryId = costEntryId(event.address, event.params.id);

  let id = txEventId(event);
  let p = new CostPayment(id);
  p.dao = plugin.dao;
  p.plugin = plugin.id;
  p.entry = entryId;
  p.payee = event.params.payee;
  p.amount = event.params.amount;
  p.paidAt = event.params.paidAt;
  p.block = event.block.number;
  p.txHash = event.transaction.hash;
  p.save();
}

export function handleCostsProcessed(event: CostsProcessed): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);

  let id = txEventId(event);
  let run = new CostCrankRun(id);
  run.dao = plugin.dao;
  run.plugin = plugin.id;
  run.fromIndex = event.params.fromIndex;
  run.count = event.params.count;
  run.failureMap = event.params.failureMap;
  run.timestamp = event.block.timestamp;
  run.block = event.block.number;
  run.txHash = event.transaction.hash;
  run.save();
}

export function handlePaymentTokenUpdated(event: PaymentTokenUpdated): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  plugin.paymentToken = event.params.current;
  plugin.save();

  let id = txEventId(event);
  let m = new PaymentTokenMigration(id);
  m.plugin = plugin.id;
  m.previous = event.params.previous;
  m.current = event.params.current;
  m.timestamp = event.block.timestamp;
  m.block = event.block.number;
  m.txHash = event.transaction.hash;
  m.save();
}
