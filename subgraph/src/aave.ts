// AAVE lending event handlers — see docs/EVENTS.md.

import {Address, BigInt} from "@graphprotocol/graph-ts";
import {
  AaveLendingPlugin as AavePluginContract,
  Supplied,
  Withdrawn,
  Borrowed,
  Repaid,
  AdapterUpdated,
  AllowedAssetSet,
} from "../generated/AaveLendingPlugin/AaveLendingPlugin";
import {
  Dao,
  AaveLendingPlugin,
  LendingAction,
  AdapterMigration,
  AssetAllowlistEntry,
} from "../generated/schema";
import {txEventId, pluginEntityId, allowlistEntryId} from "./shared";

function getOrCreatePlugin(addr: Address, timestamp: BigInt): AaveLendingPlugin {
  let id = pluginEntityId(addr);
  let plugin = AaveLendingPlugin.load(id);
  if (plugin == null) {
    plugin = new AaveLendingPlugin(id);
    let contract = AavePluginContract.bind(addr);
    let daoAddr = contract.dao();
    let daoId = daoAddr.toHex();
    let dao = Dao.load(daoId);
    if (dao == null) {
      dao = new Dao(daoId);
      dao.createdAt = timestamp;
    }
    dao.aavePlugin = id;
    dao.save();
    plugin.dao = daoId;
    plugin.adapter = contract.adapter();
    plugin.allowlistEnforced = contract.allowlistEnforced();
    plugin.opNonce = contract.opNonce();
  }
  return plugin as AaveLendingPlugin;
}

function recordAction(
  event_addr: Address,
  daoId: string,
  pluginId: string,
  kind: string,
  asset: Address,
  amount: BigInt,
  amountActual: BigInt | null,
  interestRateMode: BigInt | null,
  evt: ethereum.Event
): void {
  let id = txEventId(evt);
  let a = new LendingAction(id);
  a.dao = daoId;
  a.plugin = pluginId;
  a.kind = kind;
  a.asset = asset;
  a.amount = amount;
  a.amountActual = amountActual;
  a.interestRateMode = interestRateMode;
  a.timestamp = evt.block.timestamp;
  a.block = evt.block.number;
  a.txHash = evt.transaction.hash;
  a.save();
}

// Workaround: AssemblyScript wants `ethereum.Event` imported here too.
import {ethereum} from "@graphprotocol/graph-ts";

function syncNonce(plugin: AaveLendingPlugin, addr: Address): void {
  let contract = AavePluginContract.bind(addr);
  plugin.opNonce = contract.opNonce();
  plugin.save();
}

export function handleSupplied(event: Supplied): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  syncNonce(plugin, event.address);
  recordAction(event.address, plugin.dao, plugin.id, "SUPPLY", event.params.asset, event.params.amount, null, null, event);
}

export function handleWithdrawn(event: Withdrawn): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  syncNonce(plugin, event.address);
  recordAction(event.address, plugin.dao, plugin.id, "WITHDRAW", event.params.asset, event.params.amount, event.params.received, null, event);
}

export function handleBorrowed(event: Borrowed): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  syncNonce(plugin, event.address);
  recordAction(event.address, plugin.dao, plugin.id, "BORROW", event.params.asset, event.params.amount, null, event.params.interestRateMode, event);
}

export function handleRepaid(event: Repaid): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  syncNonce(plugin, event.address);
  recordAction(event.address, plugin.dao, plugin.id, "REPAY", event.params.asset, event.params.amount, event.params.paid, event.params.interestRateMode, event);
}

export function handleAdapterUpdated(event: AdapterUpdated): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  plugin.adapter = event.params.current;
  plugin.save();

  let id = txEventId(event);
  let m = new AdapterMigration(id);
  m.plugin = plugin.id;
  m.previous = event.params.previous;
  m.current = event.params.current;
  m.timestamp = event.block.timestamp;
  m.block = event.block.number;
  m.txHash = event.transaction.hash;
  m.save();
}

export function handleAllowedAssetSet(event: AllowedAssetSet): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  let contract = AavePluginContract.bind(event.address);
  plugin.allowlistEnforced = contract.allowlistEnforced();
  plugin.save();

  let id = allowlistEntryId(event.address, event.params.asset);
  let e = AssetAllowlistEntry.load(id);
  if (e == null) {
    e = new AssetAllowlistEntry(id);
    e.plugin = plugin.id;
    e.asset = event.params.asset;
  }
  e.allowed = event.params.allowed;
  e.updatedAt = event.block.timestamp;
  e.save();
}
