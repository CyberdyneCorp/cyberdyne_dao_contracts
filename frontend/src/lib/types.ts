// Per-DAO address bundle — hand-maintained in .env.local per PUBLIC_DAO_<CHAIN>
// or pasted into the UI's "switch DAO" prompt at runtime.
//
// `governance` is the TokenVoting plugin instance (optional 5th field). When
// present, the UI can create proposals + vote/execute; when absent it falls
// back to emitting calldata JSON for an external proposal builder.
export type DaoAddresses = {
  dao: string;
  payroll: string;
  uniswap: string;
  aave: string;
  governance?: string;
  costRegistry?: string;
  uniswapV3?: string;
};

export type ChainConfig = {
  chainId: number;
  name: string;
  rpc?: string;
  dao?: DaoAddresses;
  external: Record<string, string>;
  osx: Record<string, string>;
};
