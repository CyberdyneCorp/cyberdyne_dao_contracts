// Uniswap V3 LP event handlers — see docs/EVENTS.md.
//
// The DAO owns the NPM position NFTs (recipient is forced to the DAO on mint
// + collect). `liquidity` here is event-derived (mint/increase add, decrease
// subtract); the UI reads NPM.positions() for live state.

import {Address, BigInt} from "@graphprotocol/graph-ts";
import {
  UniswapV3Plugin as UniswapV3PluginContract,
  PositionMinted,
  LiquidityIncreased,
  LiquidityDecreased,
  FeesCollected,
  PositionBurned,
  PositionManagerUpdated,
  AllowedTokenSet,
} from "../generated/UniswapV3Plugin/UniswapV3Plugin";
import {
  Dao,
  UniswapV3Plugin,
  V3Position,
  V3Collect,
  V3TokenAllowlistEntry,
  V3ManagerMigration,
} from "../generated/schema";
import {txEventId, pluginEntityId, allowlistEntryId, v3PositionId} from "./shared";

function getOrCreatePlugin(addr: Address, timestamp: BigInt): UniswapV3Plugin {
  let id = pluginEntityId(addr);
  let plugin = UniswapV3Plugin.load(id);
  if (plugin == null) {
    plugin = new UniswapV3Plugin(id);
    let contract = UniswapV3PluginContract.bind(addr);
    let daoAddr = contract.dao();
    let daoId = daoAddr.toHex();
    let dao = Dao.load(daoId);
    if (dao == null) {
      dao = new Dao(daoId);
      dao.createdAt = timestamp;
    }
    dao.uniswapV3Plugin = id;
    dao.save();
    plugin.dao = daoId;
    plugin.positionManager = contract.positionManager();
    plugin.allowlistEnforced = contract.allowlistEnforced();
    // opNonce getter exists on the plugin; bind defensively in case of ABI drift.
    let nonce = contract.try_opNonce();
    plugin.opNonce = nonce.reverted ? BigInt.zero() : nonce.value;
  }
  return plugin as UniswapV3Plugin;
}

export function handlePositionMinted(event: PositionMinted): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  plugin.save();

  let id = v3PositionId(event.params.tokenId);
  let p = new V3Position(id);
  p.dao = plugin.dao;
  p.plugin = plugin.id;
  p.tokenId = event.params.tokenId;
  p.token0 = event.params.token0;
  p.token1 = event.params.token1;
  p.fee = event.params.fee;
  p.liquidity = event.params.liquidity;
  p.totalAmount0In = event.params.amount0;
  p.totalAmount1In = event.params.amount1;
  p.burned = false;
  p.mintedAt = event.block.timestamp;
  p.save();
}

export function handleLiquidityIncreased(event: LiquidityIncreased): void {
  let id = v3PositionId(event.params.tokenId);
  let p = V3Position.load(id);
  if (p == null) return; // increase before mint indexed — shouldn't happen
  p.liquidity = p.liquidity.plus(event.params.liquidity);
  p.totalAmount0In = p.totalAmount0In.plus(event.params.amount0);
  p.totalAmount1In = p.totalAmount1In.plus(event.params.amount1);
  p.save();
}

export function handleLiquidityDecreased(event: LiquidityDecreased): void {
  let id = v3PositionId(event.params.tokenId);
  let p = V3Position.load(id);
  if (p == null) return;
  // Guard against underflow if events arrive out of order.
  if (p.liquidity.ge(event.params.liquidity)) {
    p.liquidity = p.liquidity.minus(event.params.liquidity);
  } else {
    p.liquidity = BigInt.zero();
  }
  p.save();
}

export function handleFeesCollected(event: FeesCollected): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  let positionId = v3PositionId(event.params.tokenId);

  let id = txEventId(event);
  let c = new V3Collect(id);
  c.position = positionId;
  c.plugin = plugin.id;
  c.amount0 = event.params.amount0;
  c.amount1 = event.params.amount1;
  c.timestamp = event.block.timestamp;
  c.block = event.block.number;
  c.txHash = event.transaction.hash;
  c.save();
}

export function handlePositionBurned(event: PositionBurned): void {
  let id = v3PositionId(event.params.tokenId);
  let p = V3Position.load(id);
  if (p == null) return;
  p.burned = true;
  p.burnedAt = event.block.timestamp;
  p.liquidity = BigInt.zero();
  p.save();
}

export function handlePositionManagerUpdated(event: PositionManagerUpdated): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  plugin.positionManager = event.params.current;
  plugin.save();

  let id = txEventId(event);
  let m = new V3ManagerMigration(id);
  m.plugin = plugin.id;
  m.previous = event.params.previous;
  m.current = event.params.current;
  m.timestamp = event.block.timestamp;
  m.block = event.block.number;
  m.txHash = event.transaction.hash;
  m.save();
}

export function handleAllowedTokenSet(event: AllowedTokenSet): void {
  let plugin = getOrCreatePlugin(event.address, event.block.timestamp);
  let contract = UniswapV3PluginContract.bind(event.address);
  plugin.allowlistEnforced = contract.allowlistEnforced();
  plugin.save();

  let id = allowlistEntryId(event.address, event.params.token);
  let e = V3TokenAllowlistEntry.load(id);
  if (e == null) {
    e = new V3TokenAllowlistEntry(id);
    e.plugin = plugin.id;
    e.token = event.params.token;
  }
  e.allowed = event.params.allowed;
  e.updatedAt = event.block.timestamp;
  e.save();
}
