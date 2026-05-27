// Per-chain config: addresses come from @cyberdyne/dao-contracts; per-DAO
// plugin instances come from env vars (operator pastes them in from
// deployments/<chain>-*.json).

import {addresses} from "@cyberdyne/dao-contracts";
import {env} from "$env/dynamic/public";
import type {ChainConfig, DaoAddresses} from "./types";

const RPC_BY_CHAIN_ID: Record<number, string | undefined> = {
  1: env.PUBLIC_RPC_MAINNET,
  8453: env.PUBLIC_RPC_BASE,
  11155111: env.PUBLIC_RPC_SEPOLIA,
  84532: env.PUBLIC_RPC_BASE_SEPOLIA,
};

const DAO_ENV_KEY: Record<number, string> = {
  1: "PUBLIC_DAO_MAINNET",
  8453: "PUBLIC_DAO_BASE",
  11155111: "PUBLIC_DAO_SEPOLIA",
  84532: "PUBLIC_DAO_BASE_SEPOLIA",
};

function parseDaoEnv(raw: string | undefined): DaoAddresses | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((p) => p.trim());
  // dao,payroll,uniswap,aave (4) + optional governance (5) + optional costRegistry (6).
  if (parts.length < 4 || parts.length > 6) {
    console.warn(`PUBLIC_DAO_* env var malformed (expected 4-6 comma-separated addrs): ${raw}`);
    return undefined;
  }
  return {
    dao: parts[0],
    payroll: parts[1],
    uniswap: parts[2],
    aave: parts[3],
    governance: parts[4] || undefined,
    costRegistry: parts[5] || undefined,
  };
}

export function chainConfig(chainId: number): ChainConfig | undefined {
  const entry = (addresses as Record<string, {name: string; osx: Record<string, string>; external: Record<string, string>}>)[
    String(chainId)
  ];
  if (!entry) return undefined;
  const daoKey = DAO_ENV_KEY[chainId];
  const daoRaw = daoKey ? (env as Record<string, string | undefined>)[daoKey] : undefined;
  return {
    chainId,
    name: entry.name,
    rpc: RPC_BY_CHAIN_ID[chainId],
    osx: entry.osx,
    external: entry.external,
    dao: parseDaoEnv(daoRaw),
  };
}

export function supportedChainIds(): number[] {
  return Object.keys(addresses).map(Number).sort((a, b) => a - b);
}
