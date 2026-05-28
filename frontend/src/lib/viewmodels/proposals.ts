// Proposals ViewModel (MVVM): the governance hub — build an admin/raw action,
// submit it as a TokenVoting proposal, list proposals, vote, simulate, execute.

import {ethers} from "ethers";
import {writable, get} from "svelte/store";
import {wallet} from "$lib/wallet";
import {chainConfig, explorerChainId} from "$lib/chains";
import * as actions from "$lib/actions";
import type {ProposalAction} from "$lib/actions";
import type {ChainConfig} from "$lib/types";
import {toasts} from "$lib/stores/toasts";
import {errorMessage} from "$lib/format";
import {
  bundledAbiFor,
  sourcifyAbi,
  parsePastedAbi,
  encodeCall,
  type LoadedAbi,
} from "$lib/abiExplorer";
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
  const buildSim = writable<SimResult | null>(null);

  const proposals = writable<ProposalView[]>([]);
  const loading = writable(false);
  const rowBusy = writable<Record<string, boolean>>({});
  const simResults = writable<Record<string, SimResult>>({});

  // --- ABI explorer (paste address → ABI → pick function → encode call) ------
  const exAddress = writable("");
  const exAbi = writable<LoadedAbi | null>(null);
  const exLoading = writable(false);
  const exError = writable<string | null>(null);
  const exPaste = writable(""); // manual ABI JSON / signatures
  const exFn = writable<string>(""); // selected function key
  const exArgs = writable<string[]>([]); // one raw value per input
  const exValue = writable(""); // wei, for payable fns

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
    buildSim.set(null);
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

  // Dry-run the just-built action via dao.callStatic.execute BEFORE creating a
  // proposal, so the user sees whether it would succeed (and why not).
  async function simulateBuilt(): Promise<void> {
    const action = get(built);
    if (!action) return;
    buildSim.set("loading");
    try {
      const w = get(wallet);
      if (w.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig(w.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");
      buildSim.set(await simulateProposalExecution(cfg, w.provider, [action]));
    } catch (err) {
      buildSim.set({ok: false, reason: errorMessage(err)});
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

  // When a new ABI is loaded, preselect the first function and size the args.
  function adoptAbi(loaded: LoadedAbi): void {
    exAbi.set(loaded);
    exError.set(null);
    const first = loaded.functions[0];
    selectExFn(first ? first.key : "");
  }

  function selectExFn(key: string): void {
    exFn.set(key);
    exValue.set("");
    const loaded = get(exAbi);
    const fn = loaded?.functions.find((f) => f.key === key);
    exArgs.set(fn ? fn.inputs.map(() => "") : []);
  }

  function setExArg(i: number, value: string): void {
    exArgs.update((a) => {
      const next = a.slice();
      next[i] = value;
      return next;
    });
  }

  // Resolve the ABI for the pasted address: bundled (our plugins/tokens) first,
  // then Sourcify on the mainnet chain id (the fork mirrors mainnet).
  async function loadAbi(): Promise<void> {
    const addr = get(exAddress).trim();
    exAbi.set(null);
    exError.set(null);
    if (!ethers.utils.isAddress(addr)) {
      exError.set("Enter a valid contract address (0x…40 hex).");
      return;
    }
    const w = get(wallet);
    if (w.status !== "connected") {
      exError.set("Connect a wallet first.");
      return;
    }
    const cfg = chainConfig(w.chainId);
    const bundled = bundledAbiFor(cfg, addr);
    if (bundled) {
      adoptAbi(bundled);
      return;
    }
    exLoading.set(true);
    try {
      adoptAbi(await sourcifyAbi(explorerChainId(w.chainId), addr));
    } catch (err) {
      exError.set(errorMessage(err));
    } finally {
      exLoading.set(false);
    }
  }

  // Parse the manually pasted ABI / signatures.
  function applyPastedAbi(): void {
    exError.set(null);
    try {
      adoptAbi(parsePastedAbi(get(exPaste)));
    } catch (err) {
      exError.set(errorMessage(err));
    }
  }

  // Encode the selected function + args into a ProposalAction, surfacing it in
  // the shared decode/simulate/submit panel.
  function buildFromExplorer(): void {
    built.set(null);
    buildSim.set(null);
    try {
      const loaded = get(exAbi);
      if (!loaded) throw new Error("Load an ABI first");
      const addr = ethers.utils.getAddress(get(exAddress).trim());
      const key = get(exFn);
      const fn = loaded.functions.find((f) => f.key === key);
      if (!fn) throw new Error("Pick a function");
      const {data, value} = encodeCall(loaded, key, get(exArgs), get(exValue));
      built.set({
        to: addr,
        value,
        data,
        summary: `Call ${fn.name}(${fn.inputs.map((p) => p.type).join(",")}) on ${addr}${
          value !== "0" ? ` (value ${value} wei)` : ""
        }`,
      });
    } catch (err) {
      toasts.error(`Encode failed: ${errorMessage(err)}`);
    }
  }

  return {
    kind,
    argA,
    argB,
    argC,
    built,
    buildSim,
    exAddress,
    exAbi,
    exLoading,
    exError,
    exPaste,
    exFn,
    exArgs,
    exValue,
    loadAbi,
    applyPastedAbi,
    selectExFn,
    setExArg,
    buildFromExplorer,
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
    simulateBuilt,
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
