// Overview ViewModel (MVVM): treasury balances + plugin/framework addresses.

import {ethers} from "ethers";
import {writable, get} from "svelte/store";
import {wallet} from "$lib/wallet";
import {chainConfig} from "$lib/chains";
import {erc20} from "$lib/contracts";
import type {ChainConfig} from "$lib/types";
import {toasts} from "$lib/stores/toasts";
import {errorMessage} from "$lib/format";

const TRACKED_SYMBOLS = ["USDC", "WETH"] as const;

export type TokenBalance = {symbol: string; address: string; balance: ethers.BigNumber; decimals: number};
export type OverviewData = {
  cfg: ChainConfig;
  dao: NonNullable<ChainConfig["dao"]>;
  ethBalance: ethers.BigNumber;
  tokens: TokenBalance[];
};

export function createOverviewVM() {
  const loading = writable(false);
  const loadError = writable<string | null>(null);
  const unsupported = writable(false);
  const noDao = writable(false);
  const data = writable<OverviewData | null>(null);

  async function load(): Promise<void> {
    const w = get(wallet);
    unsupported.set(false);
    noDao.set(false);
    if (w.status !== "connected") {
      data.set(null);
      return;
    }
    const cfg = chainConfig(w.chainId);
    if (!cfg) {
      unsupported.set(true);
      data.set(null);
      return;
    }
    if (!cfg.dao) {
      noDao.set(true);
      data.set(null);
      return;
    }
    loading.set(true);
    loadError.set(null);
    try {
      const daoAddr = cfg.dao.dao;
      const ethBalance = await w.provider.getBalance(daoAddr);
      const tokens = (
        await Promise.all(
          TRACKED_SYMBOLS.map(async (sym) => {
            const addr = cfg.external[sym];
            if (!addr) return null;
            const tok = erc20(addr, w.provider);
            const [balance, decimals] = await Promise.all([tok.balanceOf(daoAddr), tok.decimals()]);
            return {symbol: sym, address: addr, balance, decimals};
          })
        )
      ).filter((t) => t !== null) as TokenBalance[];
      data.set({cfg, dao: cfg.dao, ethBalance, tokens});
    } catch (err) {
      loadError.set(errorMessage(err));
      toasts.error(`Overview load failed: ${errorMessage(err)}`);
    } finally {
      loading.set(false);
    }
  }

  return {loading, loadError, unsupported, noDao, data, load};
}
