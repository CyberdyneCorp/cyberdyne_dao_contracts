// Uniswap V4 swap event handlers — see docs/EVENTS.md.

import {Address, BigInt} from "@graphprotocol/graph-ts";
import {
  UniswapV4Plugin as UniswapV4PluginContract,
  SwapExecuted,
  AllowedTokenSet,
  UniversalRouterUpdated,
} from "../generated/UniswapV4Plugin/UniswapV4Plugin";
import {
  Dao,
  UniswapV4Plugin,
  Swap,
  RouterMigration,
  TokenAllowlistEntry,
} from "../generated/schema";
import {txEventId, pluginEntityId, allowlistEntryId} from "./shared";

function getOrCreatePlugin(addr: Address, timestamp: BigInt): UniswapV4Plugin {
  let id = pluginEntityId(addr);
  let plugin = UniswapV4Plugin.load(id);
  if (plugin == null) {
    plugin = new UniswapV4Plugin(id);
    let contract = UniswapV4PluginContract.bind(addr);
    let daoAddr = contract.dao();
    let daoId = daoAddr.toHex();
    let dao = Dao.load(daoId);
    if (dao == null) {
      dao = new Dao(daoId);
      dao.createdAt = timestamp;
    }
    dao.uniswapPlugin = id;
    dao.save();
    plugin.dao = daoId;
    plugin.universalRouter = contract.universalRouter();
    plugin.permit2 = contract.permit2();
    plugin.poolManager = contract.poolManager();
    plugin.allowlistEnforced = contract.allowlistEnforced();
    plugin.swapNonce = contract.swapNonce();
  }
  return plugin as UniswapV4Plugin;
}

export function handleSwapExecuted(event: SwapExecuted): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  let contract = UniswapV4PluginContract.bind(event.address);
  plugin.swapNonce = contract.swapNonce();
  plugin.save();

  let id = txEventId(event);
  let s = new Swap(id);
  s.dao = plugin.dao;
  s.plugin = plugin.id;
  s.tokenIn = event.params.tokenIn;
  s.amountIn = event.params.amountIn;
  s.tokenOut = event.params.tokenOut;
  s.amountOutActual = event.params.amountOutActual;
  s.timestamp = event.block.timestamp;
  s.block = event.block.number;
  s.txHash = event.transaction.hash;
  s.save();
}

export function handleAllowedTokenSet(event: AllowedTokenSet): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  let contract = UniswapV4PluginContract.bind(event.address);
  plugin.allowlistEnforced = contract.allowlistEnforced();
  plugin.save();

  let id = allowlistEntryId(event.address, event.params.token);
  let e = TokenAllowlistEntry.load(id);
  if (e == null) {
    e = new TokenAllowlistEntry(id);
    e.plugin = plugin.id;
    e.token = event.params.token;
  }
  e.allowed = event.params.allowed;
  e.updatedAt = event.block.timestamp;
  e.save();
}

export function handleUniversalRouterUpdated(event: UniversalRouterUpdated): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  plugin.universalRouter = event.params.current;
  plugin.save();

  let id = txEventId(event);
  let m = new RouterMigration(id);
  m.plugin = plugin.id;
  m.previous = event.params.previous;
  m.current = event.params.current;
  m.timestamp = event.block.timestamp;
  m.block = event.block.number;
  m.txHash = event.transaction.hash;
  m.save();
}
