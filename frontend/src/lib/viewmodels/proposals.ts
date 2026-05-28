// Proposals ViewModel (MVVM): the governance hub — build an admin/raw action,
// submit it as a TokenVoting proposal, list proposals, vote, simulate, execute.

import {ethers} from "ethers";
import {writable, get} from "svelte/store";
import {wallet} from "$lib/wallet";
import {chainConfig} from "$lib/chains";
import * as actions from "$lib/actions";
import type {ProposalAction} from "$lib/actions";
import type {ChainConfig} from "$lib/types";
import {toasts} from "$lib/stores/toasts";
import {errorMessage} from "$lib/format";
import {
  proposeActions,
  castVote,
  executeProposal,
  fetchProposals,
  simulateProposalExecution,
  VoteOption,
  type ProposalView,
  type VoteOptionValue,
} from "$lib/governance";

export type Kind =
  | "raw"
  | "uniswap-setRouter"
  | "uniswap-setAllowedToken"
  | "uniswap-setV4PositionManager"
  | "uniswapV3-setPositionManager"
  | "uniswapV3-setAllowedToken"
  | "aave-setAdapter"
  | "aave-setAllowedAsset"
  | "payroll-removeRecipient"
  | "payroll-setAmount"
  | "payroll-setPayDayOfMonth";

export const needsArgB = new Set<Kind>([
  "uniswap-setAllowedToken",
  "uniswapV3-setAllowedToken",
  "aave-setAllowedAsset",
  "payroll-setAmount",
  "raw",
]);

export type SimResult = "loading" | {ok: true} | {ok: false; reason: string};

export function createProposalsVM() {
  const kind = writable<Kind>("uniswap-setRouter");
  const argA = writable("");
  const argB = writable("");
  const argC = writable("");
  const built = writable<ProposalAction | null>(null);

  const submitMsg = writable<string | null>(null);
  const submitting = writable(false);

  const proposals = writable<ProposalView[]>([]);
  const loading = writable(false);
  const rowBusy = writable<Record<string, boolean>>({});
  const simResults = writable<Record<string, SimResult>>({});

  function cfgOrThrow(): ChainConfig {
    const w = get(wallet);
    if (w.status !== "connected") throw new Error("Connect a wallet");
    const cfg = chainConfig(w.chainId);
    if (!cfg?.dao) throw new Error(`No DAO configured for chain ${w.chainId}`);
    return cfg;
  }
  function signer(): ethers.Signer {
    const w = get(wallet);
    if (w.status !== "connected") throw new Error("Connect a wallet");
    return w.provider.getSigner();
  }

  function build(): void {
    built.set(null);
    try {
      const cfg = cfgOrThrow();
      const a = get(argA);
      const b = get(argB);
      const isTrue = b.toLowerCase() === "true";
      let result: ProposalAction;
      switch (get(kind)) {
        case "raw":
          result = {
            to: ethers.utils.getAddress(a),
            value: (get(argC) || "0").trim(),
            data: b || "0x",
            summary: `Raw call to ${a} (value ${get(argC) || "0"} wei)`,
          };
          break;
        case "uniswap-setRouter":
          result = actions.uniSetRouter(cfg, a);
          break;
        case "uniswap-setAllowedToken":
          result = actions.uniSetAllowedToken(cfg, a, isTrue);
          break;
        case "uniswap-setV4PositionManager":
          result = actions.v4SetPositionManager(cfg, a);
          break;
        case "uniswapV3-setPositionManager":
          result = actions.v3SetPositionManager(cfg, a);
          break;
        case "uniswapV3-setAllowedToken":
          result = actions.v3SetAllowedToken(cfg, a, isTrue);
          break;
        case "aave-setAdapter":
          result = actions.aaveSetAdapter(cfg, a);
          break;
        case "aave-setAllowedAsset":
          result = actions.aaveSetAllowedAsset(cfg, a, isTrue);
          break;
        case "payroll-removeRecipient":
          result = actions.payrollRemoveRecipient(cfg, a);
          break;
        case "payroll-setAmount":
          result = actions.payrollSetAmount(cfg, a, ethers.BigNumber.from(b || "0"));
          break;
        case "payroll-setPayDayOfMonth":
          result = actions.payrollSetPayDay(cfg, parseInt(a, 10));
          break;
      }
      built.set(result!);
    } catch (err) {
      toasts.error(`Build failed: ${errorMessage(err)}`);
    }
  }

  async function submit(): Promise<void> {
    const action = get(built);
    if (!action) return;
    submitMsg.set(null);
    submitting.set(true);
    try {
      const cfg = cfgOrThrow();
      const {hash, proposalId, metadataUri} = await proposeActions(
        cfg,
        signer(),
        [action],
        action.summary
      );
      const meta = metadataUri.startsWith("ipfs://") ? ` · metadata ${metadataUri}` : "";
      submitMsg.set(`Proposal ${proposalId ?? "?"} created (${hash.slice(0, 10)}…)${meta}.`);
      await refresh();
    } catch (err) {
      submitMsg.set(`Failed: ${errorMessage(err)}`);
      toasts.error(`Proposal submit failed: ${errorMessage(err)}`);
    } finally {
      submitting.set(false);
    }
  }

  async function refresh(): Promise<void> {
    const w = get(wallet);
    if (w.status !== "connected") return;
    const cfg = chainConfig(w.chainId);
    if (!cfg?.dao?.governance) return;
    loading.set(true);
    try {
      proposals.set(await fetchProposals(cfg, w.provider, w.address));
      simResults.set({});
    } catch (err) {
      toasts.error(`Proposals load failed: ${errorMessage(err)}`);
    } finally {
      loading.set(false);
    }
  }

  function setRowBusy(id: string, busy: boolean): void {
    rowBusy.update((m) => ({...m, [id]: busy}));
  }

  async function doVote(id: string, option: VoteOptionValue): Promise<void> {
    setRowBusy(id, true);
    try {
      await castVote(cfgOrThrow(), signer(), id, option);
      await refresh();
    } catch (err) {
      toasts.error(`Vote failed: ${errorMessage(err)}`);
    } finally {
      setRowBusy(id, false);
    }
  }

  async function doExecute(id: string): Promise<void> {
    setRowBusy(id, true);
    try {
      await executeProposal(cfgOrThrow(), signer(), id);
      await refresh();
    } catch (err) {
      toasts.error(`Execute failed: ${errorMessage(err)}`);
    } finally {
      setRowBusy(id, false);
    }
  }

  async function simulateRow(p: ProposalView): Promise<void> {
    simResults.update((m) => ({...m, [p.id]: "loading"}));
    try {
      const w = get(wallet);
      if (w.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig(w.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const r = await simulateProposalExecution(cfg, w.provider, p.actions);
      simResults.update((m) => ({...m, [p.id]: r}));
    } catch (err) {
      simResults.update((m) => ({...m, [p.id]: {ok: false, reason: errorMessage(err)}}));
    }
  }

  return {
    kind,
    argA,
    argB,
    argC,
    built,
    submitMsg,
    submitting,
    proposals,
    loading,
    rowBusy,
    simResults,
    build,
    submit,
    refresh,
    doVote,
    doExecute,
    simulateRow,
  };
}

export function voteLabel(v: VoteOptionValue | null): string {
  if (v === VoteOption.Yes) return "Yes";
  if (v === VoteOption.No) return "No";
  if (v === VoteOption.Abstain) return "Abstain";
  return "—";
}
export function tsLabel(n: number): string {
  return n === 0 ? "auto" : new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ");
}
