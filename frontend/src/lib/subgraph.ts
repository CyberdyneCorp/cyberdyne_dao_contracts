// Thin, dependency-free GraphQL client for the Cyberdyne DAO subgraph.
//
// The subgraph is OPTIONAL: pages call `subgraphEnabled()` and, when a
// PUBLIC_SUBGRAPH_URL is configured, query rich indexed history here;
// otherwise they fall back to their existing direct-RPC event scans. This
// keeps the toy frontend usable on a bare `localFork` (no subgraph) while
// letting an operator point at a deployed subgraph for fast history.
//
// We deliberately avoid @urql/graphql-request to keep the bundle tiny — a
// single `fetch` POST covers everything we need.

import {env} from "$env/dynamic/public";

export function subgraphUrl(): string | undefined {
  const u = env.PUBLIC_SUBGRAPH_URL;
  return u && u.trim().length > 0 ? u.trim() : undefined;
}

export function subgraphEnabled(): boolean {
  return subgraphUrl() !== undefined;
}

type GraphQLResponse<T> = {data?: T; errors?: {message: string}[]};

/**
 * POST a GraphQL query to the configured subgraph. Throws if no subgraph is
 * configured (callers should gate on `subgraphEnabled()` first) or if the
 * endpoint returns GraphQL errors.
 */
export async function querySubgraph<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const url = subgraphUrl();
  if (!url) throw new Error("No PUBLIC_SUBGRAPH_URL configured");
  const res = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({query, variables}),
  });
  if (!res.ok) throw new Error(`Subgraph HTTP ${res.status}`);
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Subgraph error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("Subgraph returned no data");
  return json.data;
}

// ---- Typed query helpers ----

export type SwapRow = {
  id: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOutActual: string;
  timestamp: string;
  txHash: string;
};

export async function fetchSwaps(dao: string, first = 50): Promise<SwapRow[]> {
  const data = await querySubgraph<{swaps: SwapRow[]}>(
    `query Swaps($dao: ID!, $first: Int!) {
      swaps(
        where: {dao: $dao}
        orderBy: timestamp
        orderDirection: desc
        first: $first
      ) {
        id
        tokenIn
        amountIn
        tokenOut
        amountOutActual
        timestamp
        txHash
      }
    }`,
    {dao: dao.toLowerCase(), first}
  );
  return data.swaps;
}

export type CostPaymentRow = {
  id: string;
  payee: string;
  amount: string;
  paidAt: string;
  txHash: string;
  entry: {entryId: string; name: string};
};

export async function fetchCostPayments(
  dao: string,
  first = 50
): Promise<CostPaymentRow[]> {
  const data = await querySubgraph<{costPayments: CostPaymentRow[]}>(
    `query CostPayments($dao: ID!, $first: Int!) {
      costPayments(
        where: {dao: $dao}
        orderBy: paidAt
        orderDirection: desc
        first: $first
      ) {
        id
        payee
        amount
        paidAt
        txHash
        entry { entryId name }
      }
    }`,
    {dao: dao.toLowerCase(), first}
  );
  return data.costPayments;
}

export type V3PositionRow = {
  id: string;
  tokenId: string;
  token0: string;
  token1: string;
  fee: number;
  liquidity: string;
  burned: boolean;
};

export async function fetchV3Positions(
  dao: string,
  first = 100
): Promise<V3PositionRow[]> {
  const data = await querySubgraph<{v3Positions: V3PositionRow[]}>(
    `query V3Positions($dao: ID!, $first: Int!) {
      v3Positions(
        where: {dao: $dao}
        orderBy: mintedAt
        orderDirection: desc
        first: $first
      ) {
        id
        tokenId
        token0
        token1
        fee
        liquidity
        burned
      }
    }`,
    {dao: dao.toLowerCase(), first}
  );
  return data.v3Positions;
}
