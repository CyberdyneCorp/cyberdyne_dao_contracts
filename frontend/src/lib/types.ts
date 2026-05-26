// Per-DAO address bundle — hand-maintained in .env.local per PUBLIC_DAO_<CHAIN>
// or pasted into the UI's "switch DAO" prompt at runtime.
export type DaoAddresses = {
  dao: string;
  payroll: string;
  uniswap: string;
  aave: string;
};

export type ChainConfig = {
  chainId: number;
  name: string;
  rpc?: string;
  dao?: DaoAddresses;
  external: Record<string, string>;
  osx: Record<string, string>;
};
