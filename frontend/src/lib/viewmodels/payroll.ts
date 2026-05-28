// Payroll ViewModel (MVVM). Owns all payroll-page state + commands as Svelte
// stores; the +page.svelte View only binds + renders. Model layer = $lib
// (payrollContract, actions). Errors surface via the toast store.

import {ethers} from "ethers";
import {writable, get, type Writable} from "svelte/store";
import {wallet} from "$lib/wallet";
import {chainConfig} from "$lib/chains";
import {payrollContract} from "$lib/contracts";
import * as actions from "$lib/actions";
import type {ProposalAction} from "$lib/actions";
import type {ChainConfig} from "$lib/types";
import {toasts} from "$lib/stores/toasts";
import {errorMessage} from "$lib/format";

const ZERO = ethers.constants.AddressZero;

export type Recipient = {payee: string; token: string; amount: ethers.BigNumber; active: boolean};
export type PayrollData = {
  cfg: ChainConfig;
  recipients: Recipient[];
  payDay: number;
  lastPeriod: ethers.BigNumber;
  cursor: ethers.BigNumber;
  cursorPeriod: ethers.BigNumber;
  perPage: ethers.BigNumber;
};

export function createPayrollVM() {
  const loading = writable(false);
  const loadError = writable<string | null>(null);
  const data = writable<PayrollData | null>(null);

  const crankBusy = writable(false);
  const crankResult = writable<string | null>(null);
  const pageSize = writable("100");

  // Form inputs + their built proposal actions.
  const newPayee = writable("");
  const newToken = writable(ZERO);
  const newAmount = writable("");
  const addAction = writable<ProposalAction | null>(null);

  const setAmtPayee = writable("");
  const setAmtToken = writable(ZERO);
  const setAmtValue = writable("");
  const setAmountAction = writable<ProposalAction | null>(null);

  const maxRecip = writable("");
  const setMaxAction = writable<ProposalAction | null>(null);

  const forceYear = writable("");
  const forceMonth = writable("");
  const forceActions = writable<ProposalAction[] | null>(null);

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
    loading.set(true);
    loadError.set(null);
    try {
      const payroll = payrollContract(cfg, w.provider);
      const [recipients, payDay, lastPeriod, cursor, cursorPeriod, perPage] = await Promise.all([
        payroll.allActiveRecipients(),
        payroll.payDayOfMonth(),
        payroll.lastPayoutPeriod(),
        payroll.payoutCursor(),
        payroll.cursorPeriod(),
        payroll.MAX_RECIPIENTS_PER_PAGE(),
      ]);
      data.set({cfg, recipients, payDay, lastPeriod, cursor, cursorPeriod, perPage});
    } catch (err) {
      loadError.set(errorMessage(err));
      toasts.error(`Payroll load failed: ${errorMessage(err)}`);
    } finally {
      loading.set(false);
    }
  }

  async function runCrank(full: boolean): Promise<void> {
    const w = get(wallet);
    if (w.status !== "connected") return;
    const cfg = chainConfig(w.chainId);
    if (!cfg?.dao) return;
    crankBusy.set(true);
    crankResult.set(null);
    try {
      const payroll = payrollContract(cfg, w.provider.getSigner());
      const tx = full
        ? await payroll.executePayroll()
        : await payroll.executePayrollPage(ethers.BigNumber.from(get(pageSize) || "100"));
      crankResult.set(`Submitted: ${tx.hash}. Waiting…`);
      const receipt = await tx.wait();
      crankResult.set(`Confirmed in block ${receipt.blockNumber}.`);
      toasts.success(`Payroll crank confirmed in block ${receipt.blockNumber}.`);
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

  function buildAddRecipient(): void {
    guardedBuild(addAction, (cfg) => {
      const token = get(newToken);
      const decimals = token === ZERO ? 18 : 6;
      const amount = ethers.utils.parseUnits(get(newAmount) || "0", decimals);
      addAction.set(actions.payrollAddRecipient(cfg, get(newPayee), token, amount));
    });
  }

  function buildSetAmount(): void {
    guardedBuild(setAmountAction, (cfg) => {
      const token = get(setAmtToken);
      const decimals = token === ZERO ? 18 : 6;
      const amount = ethers.utils.parseUnits(get(setAmtValue) || "0", decimals);
      setAmountAction.set(actions.payrollSetAmount(cfg, get(setAmtPayee), amount));
    });
  }

  function buildSetMaxRecipients(): void {
    guardedBuild(setMaxAction, (cfg) => {
      setMaxAction.set(actions.payrollSetMaxRecipients(cfg, parseInt(get(maxRecip) || "0", 10)));
    });
  }

  async function buildForcePay(): Promise<void> {
    forceActions.set(null);
    try {
      const w = get(wallet);
      if (w.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig(w.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const period =
        parseInt(get(forceYear) || "0", 10) * 12 + parseInt(get(forceMonth) || "0", 10);
      forceActions.set(await actions.previewPayrollForcePayPeriod(cfg, w.provider, period));
    } catch (err) {
      toasts.error(`Build failed: ${errorMessage(err)}`);
    }
  }

  return {
    loading,
    loadError,
    data,
    crankBusy,
    crankResult,
    pageSize,
    newPayee,
    newToken,
    newAmount,
    addAction,
    setAmtPayee,
    setAmtToken,
    setAmtValue,
    setAmountAction,
    maxRecip,
    setMaxAction,
    forceYear,
    forceMonth,
    forceActions,
    load,
    runCrank,
    buildAddRecipient,
    buildSetAmount,
    buildSetMaxRecipients,
    buildForcePay,
  };
}

/** Period (`year*12+month`) → "YYYY-MM" label, or "—" for 0. */
export function periodLabel(p: ethers.BigNumberish): string {
  const n = Number(p);
  if (n === 0) return "—";
  const year = Math.floor(n / 12);
  const month = n - year * 12;
  return `${year}-${String(month).padStart(2, "0")}`;
}
