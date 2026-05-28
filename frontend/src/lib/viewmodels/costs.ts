// CostRegistry ViewModel (MVVM). Owns the cost-registry page state + commands.

import {ethers} from "ethers";
import {writable, get, type Writable} from "svelte/store";
import {wallet} from "$lib/wallet";
import {chainConfig} from "$lib/chains";
import {costRegistryContract} from "$lib/contracts";
import * as actions from "$lib/actions";
import type {ProposalAction} from "$lib/actions";
import type {ChainConfig} from "$lib/types";
import {toasts} from "$lib/stores/toasts";
import {errorMessage} from "$lib/format";
import {fetchCostPayments, type CostPaymentRow} from "$lib/subgraph";

export const PAGE = 20;

export type CostRow = {
  id: number;
  name: string;
  description: string;
  payee: string;
  costUsdc: ethers.BigNumber;
  frequencyDays: number;
  active: boolean;
  lastPaidAt: number;
  nextAt: number;
};
export type CostsData = {cfg: ChainConfig; token: string; rows: CostRow[]; total: number};

export function createCostsVM() {
  const loading = writable(false);
  const loadError = writable<string | null>(null);
  const noPlugin = writable(false);
  const data = writable<CostsData | null>(null);
  const offset = writable(0);

  const crankBusy = writable(false);
  const crankResult = writable<string | null>(null);
  const crankOffset = writable("0");
  const crankLimit = writable("100");

  const payments = writable<CostPaymentRow[] | null>(null);
  const payLoading = writable(false);

  const rId = writable("");
  const rName = writable("");
  const rDesc = writable("");
  const rCost = writable("");
  const rFreq = writable("");
  const rPayee = writable("");
  const regAction = writable<ProposalAction | null>(null);

  const removeId = writable("");
  const removeAction = writable<ProposalAction | null>(null);

  const maxEntries = writable("");
  const setMaxEntriesAction = writable<ProposalAction | null>(null);

  function connectedCfg(): ChainConfig | undefined {
    const w = get(wallet);
    return chainConfig(w.status === "connected" ? w.chainId : 1);
  }

  async function load(): Promise<void> {
    const w = get(wallet);
    if (w.status !== "connected") {
      data.set(null);
      return;
    }
    const cfg = chainConfig(w.chainId);
    if (!cfg?.dao) {
      data.set(null);
      loadError.set(`No DAO configured for chain ${w.chainId}`);
      return;
    }
    if (!cfg.dao.costRegistry) {
      data.set(null);
      noPlugin.set(true);
      return;
    }
    loading.set(true);
    loadError.set(null);
    noPlugin.set(false);
    try {
      const reg = costRegistryContract(cfg, w.provider);
      const off = get(offset);
      const [token, raw] = await Promise.all([reg.paymentToken(), reg.getEntries(off, PAGE)]);
      const page = raw[0] as Array<{
        payee: string;
        costUsdc: ethers.BigNumber;
        frequencyDays: number;
        lastPaidAt: ethers.BigNumber;
        active: boolean;
        name: string;
        description: string;
      }>;
      const total: ethers.BigNumber = raw[1];
      const rows: CostRow[] = page.map((e, i) => ({
        id: off + i,
        name: e.name,
        description: e.description,
        payee: e.payee,
        costUsdc: e.costUsdc,
        frequencyDays: e.frequencyDays,
        active: e.active,
        lastPaidAt: Number(e.lastPaidAt),
        nextAt: Number(e.lastPaidAt) + e.frequencyDays * 86_400,
      }));
      data.set({cfg, token, rows, total: total.toNumber()});
    } catch (err) {
      loadError.set(errorMessage(err));
      toasts.error(`Cost registry load failed: ${errorMessage(err)}`);
    } finally {
      loading.set(false);
    }
  }

  function setOffset(next: number): void {
    offset.set(Math.max(0, next));
    void load();
  }

  async function loadPayments(): Promise<void> {
    payLoading.set(true);
    try {
      const w = get(wallet);
      if (w.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig(w.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");
      payments.set(await fetchCostPayments(cfg.dao.dao));
    } catch (err) {
      toasts.error(`Payment history failed: ${errorMessage(err)}`);
    } finally {
      payLoading.set(false);
    }
  }

  async function runCrank(): Promise<void> {
    const w = get(wallet);
    if (w.status !== "connected") return;
    const cfg = chainConfig(w.chainId);
    if (!cfg?.dao?.costRegistry) return;
    crankBusy.set(true);
    crankResult.set(null);
    try {
      const tx = await costRegistryContract(cfg, w.provider.getSigner()).processDue(
        ethers.BigNumber.from(get(crankOffset) || "0"),
        ethers.BigNumber.from(get(crankLimit) || "100")
      );
      crankResult.set(`Submitted: ${tx.hash}. Waiting…`);
      const receipt = await tx.wait();
      crankResult.set(`Confirmed in block ${receipt.blockNumber}.`);
      toasts.success(`processDue confirmed in block ${receipt.blockNumber}.`);
      await load();
    } catch (err) {
      crankResult.set(`Failed: ${errorMessage(err)}`);
      toasts.error(`Crank failed: ${errorMessage(err)}`);
    } finally {
      crankBusy.set(false);
    }
  }

  function guardedBuild(target: Writable<unknown>, build: (cfg: ChainConfig) => void): void {
    target.set(null);
    try {
      const cfg = connectedCfg();
      if (!cfg?.dao) throw new Error("No DAO configured");
      build(cfg);
    } catch (err) {
      toasts.error(`Build failed: ${errorMessage(err)}`);
    }
  }

  function buildRegisterOrUpdate(): void {
    guardedBuild(regAction, (cfg) => {
      const cost = ethers.utils.parseUnits(get(rCost) || "0", 6);
      const freq = parseInt(get(rFreq) || "0", 10);
      const id = get(rId).trim();
      regAction.set(
        id === ""
          ? actions.costRegister(cfg, get(rName), get(rDesc), cost, freq, get(rPayee))
          : actions.costUpdate(cfg, parseInt(id, 10), get(rName), get(rDesc), cost, freq, get(rPayee))
      );
    });
  }

  function buildRemove(): void {
    guardedBuild(removeAction, (cfg) => {
      removeAction.set(actions.costRemove(cfg, parseInt(get(removeId), 10)));
    });
  }

  function buildSetMaxEntries(): void {
    guardedBuild(setMaxEntriesAction, (cfg) => {
      setMaxEntriesAction.set(actions.costSetMaxEntries(cfg, parseInt(get(maxEntries) || "0", 10)));
    });
  }

  return {
    loading,
    loadError,
    noPlugin,
    data,
    offset,
    crankBusy,
    crankResult,
    crankOffset,
    crankLimit,
    payments,
    payLoading,
    rId,
    rName,
    rDesc,
    rCost,
    rFreq,
    rPayee,
    regAction,
    removeId,
    removeAction,
    maxEntries,
    setMaxEntriesAction,
    load,
    setOffset,
    loadPayments,
    runCrank,
    buildRegisterOrUpdate,
    buildRemove,
    buildSetMaxEntries,
  };
}

export function isDue(r: CostRow): boolean {
  return r.active && Date.now() / 1000 >= r.nextAt;
}
export function fmtDate(n: number): string {
  return n === 0 ? "—" : new Date(n * 1000).toISOString().slice(0, 10);
}
