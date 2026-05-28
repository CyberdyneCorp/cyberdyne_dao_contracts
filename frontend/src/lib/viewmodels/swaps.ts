// Swaps ViewModel (MVVM): swap history (subgraph or RPC scan) + a propose-swap
// builder. Swap route bytes (commands/inputs) are still user-supplied — the
// frontend only wraps them into a ProposalAction.

import {ethers} from "ethers";
import {writable, get} from "svelte/store";
import {wallet} from "$lib/wallet";
import {chainConfig} from "$lib/chains";
import {uniswapContract} from "$lib/contracts";
import * as actions from "$lib/actions";
import type {ProposalAction} from "$lib/actions";
import type {ChainConfig} from "$lib/types";
import {toasts} from "$lib/stores/toasts";
import {errorMessage} from "$lib/format";
import {subgraphEnabled, fetchSwaps} from "$lib/subgraph";

const LOOKBACK_BLOCKS = 7200; // ~24h on mainnet

export type SwapRow = {
  tokenIn: string;
  amountIn: ethers.BigNumberish;
  tokenOut: string;
  amountOutActual: ethers.BigNumberish;
  ref: string;
  txHash: string;
};
export type SwapsData = {cfg: ChainConfig; rows: SwapRow[]; source: "subgraph" | "rpc"; note: string};

export function createSwapsVM() {
  const loading = writable(false);
  const loadError = writable<string | null>(null);
  const noDao = writable(false);
  const data = writable<SwapsData | null>(null);

  const sCommands = writable("");
  const sInputs = writable("");
  const sDeadline = writable("");
  const sTokenIn = writable("");
  const sAmountIn = writable("");
  const sTokenOut = writable("");
  const sMinOut = writable("");
  const sDecIn = writable("18");
  const sDecOut = writable("18");
  const swapAction = writable<ProposalAction | null>(null);

  async function load(): Promise<void> {
    const w = get(wallet);
    noDao.set(false);
    if (w.status !== "connected") {
      data.set(null);
      return;
    }
    const cfg = chainConfig(w.chainId);
    if (!cfg?.dao) {
      noDao.set(true);
      data.set(null);
      return;
    }
    loading.set(true);
    loadError.set(null);
    try {
      if (subgraphEnabled()) {
        const swaps = await fetchSwaps(cfg.dao.dao);
        const rows: SwapRow[] = swaps.map((s) => ({
          tokenIn: s.tokenIn,
          amountIn: s.amountIn,
          tokenOut: s.tokenOut,
          amountOutActual: s.amountOutActual,
          ref: new Date(Number(s.timestamp) * 1000).toISOString().slice(0, 16).replace("T", " "),
          txHash: s.txHash,
        }));
        data.set({cfg, rows, source: "subgraph", note: `${rows.length} swap(s) from the subgraph (full history).`});
      } else {
        const uni = uniswapContract(cfg, w.provider);
        const tip = await w.provider.getBlockNumber();
        const from = Math.max(0, tip - LOOKBACK_BLOCKS);
        const events = await uni.queryFilter(uni.filters.SwapExecuted(), from, tip);
        const rows: SwapRow[] = events.reverse().map((e) => ({
          tokenIn: e.args?.tokenIn,
          amountIn: e.args?.amountIn.toString(),
          tokenOut: e.args?.tokenOut,
          amountOutActual: e.args?.amountOutActual.toString(),
          ref: e.blockNumber.toString(),
          txHash: e.transactionHash,
        }));
        data.set({
          cfg,
          rows,
          source: "rpc",
          note: `Scanning blocks ${from} → ${tip} via RPC. Set PUBLIC_SUBGRAPH_URL for full history.`,
        });
      }
    } catch (err) {
      loadError.set(errorMessage(err));
      toasts.error(`Swap history failed: ${errorMessage(err)}`);
    } finally {
      loading.set(false);
    }
  }

  function buildSwap(): void {
    swapAction.set(null);
    try {
      const w = get(wallet);
      const cfg = chainConfig(w.status === "connected" ? w.chainId : 1);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const inputs = JSON.parse(get(sInputs) || "[]") as string[];
      if (!Array.isArray(inputs)) throw new Error("inputs must be a JSON array of hex strings");
      const dl = get(sDeadline).trim();
      const deadline = dl
        ? ethers.BigNumber.from(dl)
        : ethers.BigNumber.from(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
      swapAction.set(
        actions.uniSwap(cfg, {
          commands: get(sCommands) || "0x",
          inputs,
          deadline,
          tokenIn: get(sTokenIn),
          amountIn: ethers.utils.parseUnits(get(sAmountIn) || "0", parseInt(get(sDecIn), 10)),
          tokenOut: get(sTokenOut),
          minAmountOut: ethers.utils.parseUnits(get(sMinOut) || "0", parseInt(get(sDecOut), 10)),
        })
      );
    } catch (err) {
      toasts.error(`Build failed: ${errorMessage(err)}`);
    }
  }

  return {
    loading,
    loadError,
    noDao,
    data,
    sCommands,
    sInputs,
    sDeadline,
    sTokenIn,
    sAmountIn,
    sTokenOut,
    sMinOut,
    sDecIn,
    sDecOut,
    swapAction,
    load,
    buildSwap,
  };
}
