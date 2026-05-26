// Payroll event handlers — see docs/EVENTS.md for the event→entity mapping.

import {Address, BigInt} from "@graphprotocol/graph-ts";
import {
  PayrollPlugin as PayrollPluginContract,
  RecipientAdded,
  RecipientRemoved,
  RecipientAmountUpdated,
  PayDayUpdated,
  PayrollExecuted,
} from "../generated/PayrollPlugin/PayrollPlugin";
import {
  Dao,
  PayrollPlugin,
  PayrollRecipient,
  RecipientAmountChange,
  PayrollPayout,
  PayrollPayoutItem,
} from "../generated/schema";
import {
  txEventId,
  pluginEntityId,
  recipientEntityId,
  payoutEntityId,
  payoutItemEntityId,
} from "./shared";

function getOrCreatePlugin(addr: Address, timestamp: BigInt): PayrollPlugin {
  let id = pluginEntityId(addr);
  let plugin = PayrollPlugin.load(id);
  if (plugin == null) {
    plugin = new PayrollPlugin(id);
    let contract = PayrollPluginContract.bind(addr);
    let daoAddr = contract.dao();
    let daoId = daoAddr.toHex();
    let dao = Dao.load(daoId);
    if (dao == null) {
      dao = new Dao(daoId);
      dao.createdAt = timestamp;
    }
    dao.payrollPlugin = id;
    dao.save();
    plugin.dao = daoId;
    plugin.payDayOfMonth = contract.payDayOfMonth();
    plugin.lastPayoutPeriod = contract.lastPayoutPeriod();
  }
  return plugin as PayrollPlugin;
}

export function handleRecipientAdded(event: RecipientAdded): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  plugin.save();

  let id = recipientEntityId(event.address, event.params.payee);
  let r = new PayrollRecipient(id);
  r.dao = plugin.dao;
  r.plugin = plugin.id;
  r.payee = event.params.payee;
  r.token = event.params.token;
  r.amount = event.params.amount;
  r.active = true;
  r.addedAt = event.block.timestamp;
  r.save();
}

export function handleRecipientRemoved(event: RecipientRemoved): void {
  let id = recipientEntityId(event.address, event.params.payee);
  let r = PayrollRecipient.load(id);
  if (r == null) return; // event before the subgraph started; ignore
  r.active = false;
  r.removedAt = event.block.timestamp;
  r.save();
}

export function handleRecipientAmountUpdated(event: RecipientAmountUpdated): void {
  let id = recipientEntityId(event.address, event.params.payee);
  let r = PayrollRecipient.load(id);
  if (r == null) return;
  r.amount = event.params.newAmount;
  r.save();

  let changeId = txEventId(event);
  let change = new RecipientAmountChange(changeId);
  change.recipient = id;
  change.oldAmount = event.params.oldAmount;
  change.newAmount = event.params.newAmount;
  change.timestamp = event.block.timestamp;
  change.block = event.block.number;
  change.txHash = event.transaction.hash;
  change.save();
}

export function handlePayDayUpdated(event: PayDayUpdated): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  plugin.payDayOfMonth = event.params.newDay;
  plugin.save();
}

export function handlePayrollExecuted(event: PayrollExecuted): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  plugin.lastPayoutPeriod = event.params.period;
  plugin.save();

  let payoutId = payoutEntityId(event.address, event.params.period);
  let payout = new PayrollPayout(payoutId);
  payout.dao = plugin.dao;
  payout.plugin = plugin.id;
  payout.period = event.params.period;
  payout.recipientCount = event.params.recipientCount.toI32();
  payout.failureMap = event.params.failureMap;
  payout.timestamp = event.block.timestamp;
  payout.block = event.block.number;
  payout.txHash = event.transaction.hash;
  payout.save();

  // Zip the failureMap bits against the contract's active recipients at the
  // time of the call. We read `allActiveRecipients()` post-event — the
  // subgraph is in a deterministic block context so this is reproducible.
  let contract = PayrollPluginContract.bind(event.address);
  let recipients = contract.try_allActiveRecipients();
  if (recipients.reverted) return;

  let active = recipients.value;
  let failureMap = event.params.failureMap;
  for (let i = 0; i < active.length; i++) {
    let r = active[i];
    let bit = failureMap.bitAnd(BigInt.fromI32(1).leftShift(i as u8));
    let itemId = payoutItemEntityId(event.address, event.params.period, r.payee);
    let item = new PayrollPayoutItem(itemId);
    item.payout = payoutId;
    item.recipient = recipientEntityId(event.address, r.payee);
    item.amount = r.amount;
    item.failed = !bit.isZero();
    item.save();
  }
}
