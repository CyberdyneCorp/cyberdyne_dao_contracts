<!--
  Proposals — the governance hub.
  • Build an action (admin setters or a raw custom call) and either submit it as
    a TokenVoting proposal (when a governance plugin is configured) or copy the
    calldata JSON for an external builder.
  • List live proposals from ProposalCreated events; vote Yes/No/Abstain and
    execute when the proposal passes.
  Operational builders (swap, supply/borrow, add recipient…) live on each
  plugin's own page; this page covers admin actions + arbitrary contract calls.
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet, signer} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import * as actions from "$lib/actions";
  import type {ProposalAction} from "$lib/actions";
  import {
    governanceConfigured,
    proposeActions,
    castVote,
    executeProposal,
    fetchProposals,
    simulateProposalExecution,
    VoteOption,
    type ProposalView,
    type VoteOptionValue,
  } from "$lib/governance";

  type Kind =
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

  let kind: Kind = "uniswap-setRouter";
  let argA = "";
  let argB = "";
  let argC = ""; // raw: value (wei)
  let built: ProposalAction | null = null;
  let buildErr: string | null = null;

  function cfgOrThrow() {
    if ($wallet.status !== "connected") throw new Error("Connect a wallet");
    const cfg = chainConfig($wallet.chainId);
    if (!cfg?.dao) throw new Error(`No DAO configured for chain ${$wallet.chainId}`);
    return cfg;
  }

  function build(): void {
    built = null;
    buildErr = null;
    try {
      const cfg = cfgOrThrow();
      switch (kind) {
        case "raw":
          built = {
            to: ethers.utils.getAddress(argA),
            value: (argC || "0").trim(),
            data: argB || "0x",
            summary: `Raw call to ${argA} (value ${argC || "0"} wei)`,
          };
          break;
        case "uniswap-setRouter":
          built = actions.uniSetRouter(cfg, argA);
          break;
        case "uniswap-setAllowedToken":
          built = actions.uniSetAllowedToken(cfg, argA, argB.toLowerCase() === "true");
          break;
        case "uniswap-setV4PositionManager":
          built = actions.v4SetPositionManager(cfg, argA);
          break;
        case "uniswapV3-setPositionManager":
          built = actions.v3SetPositionManager(cfg, argA);
          break;
        case "uniswapV3-setAllowedToken":
          built = actions.v3SetAllowedToken(cfg, argA, argB.toLowerCase() === "true");
          break;
        case "aave-setAdapter":
          built = actions.aaveSetAdapter(cfg, argA);
          break;
        case "aave-setAllowedAsset":
          built = actions.aaveSetAllowedAsset(cfg, argA, argB.toLowerCase() === "true");
          break;
        case "payroll-removeRecipient":
          built = actions.payrollRemoveRecipient(cfg, argA);
          break;
        case "payroll-setAmount":
          built = actions.payrollSetAmount(cfg, argA, ethers.BigNumber.from(argB || "0"));
          break;
        case "payroll-setPayDayOfMonth":
          built = actions.payrollSetPayDay(cfg, parseInt(argA, 10));
          break;
      }
    } catch (err) {
      buildErr = (err as Error).message;
    }
  }

  let submitMsg: string | null = null;
  let submitting = false;

  async function submit(): Promise<void> {
    if (!built || !$signer) return;
    submitMsg = null;
    submitting = true;
    try {
      const cfg = cfgOrThrow();
      const {hash, proposalId} = await proposeActions(cfg, $signer, [built], built.summary);
      submitMsg = `Proposal ${proposalId ?? "?"} created (${hash.slice(0, 10)}…).`;
      await refresh();
    } catch (err) {
      submitMsg = `Failed: ${(err as Error).message}`;
    } finally {
      submitting = false;
    }
  }

  // --- Proposal list ---
  let proposals: ProposalView[] = [];
  let listErr: string | null = null;
  let loading = false;
  let rowBusy: Record<string, boolean> = {};

  async function refresh(): Promise<void> {
    listErr = null;
    if ($wallet.status !== "connected") return;
    const cfg = chainConfig($wallet.chainId);
    if (!cfg?.dao?.governance) return;
    loading = true;
    try {
      proposals = await fetchProposals(cfg, $wallet.provider, $wallet.address);
      // Stale sim results may be misleading after state changes; reset.
      simResults = {};
    } catch (err) {
      listErr = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function doVote(id: string, option: VoteOptionValue): Promise<void> {
    if (!$signer) return;
    rowBusy = {...rowBusy, [id]: true};
    try {
      const cfg = cfgOrThrow();
      await castVote(cfg, $signer, id, option);
      await refresh();
    } catch (err) {
      listErr = `Vote failed: ${(err as Error).message}`;
    } finally {
      rowBusy = {...rowBusy, [id]: false};
    }
  }

  // Per-proposal cached simulation result. Filled on demand by the "Simulate"
  // button so we don't blast the RPC for every list refresh. Resets when the
  // list is reloaded.
  type SimResult = "loading" | {ok: true} | {ok: false; reason: string};
  let simResults: Record<string, SimResult> = {};

  async function simulateRow(p: ProposalView): Promise<void> {
    simResults = {...simResults, [p.id]: "loading"};
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig($wallet.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const r = await simulateProposalExecution(cfg, $wallet.provider, p.actions);
      simResults = {...simResults, [p.id]: r};
    } catch (err) {
      simResults = {...simResults, [p.id]: {ok: false, reason: (err as Error).message}};
    }
  }

  async function doExecute(id: string): Promise<void> {
    if (!$signer) return;
    rowBusy = {...rowBusy, [id]: true};
    try {
      const cfg = cfgOrThrow();
      await executeProposal(cfg, $signer, id);
      await refresh();
    } catch (err) {
      listErr = `Execute failed: ${(err as Error).message}`;
    } finally {
      rowBusy = {...rowBusy, [id]: false};
    }
  }

  function voteLabel(v: VoteOptionValue | null): string {
    if (v === VoteOption.Yes) return "Yes";
    if (v === VoteOption.No) return "No";
    if (v === VoteOption.Abstain) return "Abstain";
    return "—";
  }
  function ts(n: number): string {
    return n === 0 ? "auto" : new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ");
  }

  // Auto-load the list whenever the connected chain provides a governance addr.
  $: cfg = $wallet.status === "connected" ? chainConfig($wallet.chainId) : undefined;
  $: hasGov = cfg ? governanceConfigured(cfg) : false;
  $: if (hasGov && proposals.length === 0 && !loading && !listErr) refresh();

  const needsArgB = new Set<Kind>([
    "uniswap-setAllowedToken",
    "uniswapV3-setAllowedToken",
    "aave-setAllowedAsset",
    "payroll-setAmount",
    "raw",
  ]);
</script>

<h1>Proposals</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect a wallet to build proposals and vote.</p>
{:else if !cfg?.dao}
  <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
{:else}
  {#if !hasGov}
    <p class="muted">
      No TokenVoting plugin configured for this DAO (5th address in
      <code>PUBLIC_DAO_*</code>). You can still build calldata below and paste it
      into an external proposal builder.
    </p>
  {/if}

  <h2>Build an action</h2>
  <div class="form">
    <label>
      Action
      <select bind:value={kind}>
        <option value="raw">Raw call (any contract) — to, data, value</option>
        <option value="uniswap-setRouter">Uniswap.setUniversalRouter(address)</option>
        <option value="uniswap-setAllowedToken">UniswapV4.setAllowedToken(address, bool)</option>
        <option value="uniswap-setV4PositionManager">UniswapV4.setV4PositionManager(address)</option>
        <option value="uniswapV3-setPositionManager">UniswapV3.setPositionManager(address)</option>
        <option value="uniswapV3-setAllowedToken">UniswapV3.setAllowedToken(address, bool)</option>
        <option value="aave-setAdapter">AAVE.setAdapter(address)</option>
        <option value="aave-setAllowedAsset">AAVE.setAllowedAsset(address, bool)</option>
        <option value="payroll-removeRecipient">Payroll.removeRecipient(address)</option>
        <option value="payroll-setAmount">Payroll.setAmount(payee, newAmount)</option>
        <option value="payroll-setPayDayOfMonth">Payroll.setPayDayOfMonth(1..28)</option>
      </select>
    </label>
    <label>
      {kind === "raw" ? "to (address)" : "Arg A"}
      <input bind:value={argA} placeholder="address / number" />
    </label>
    {#if needsArgB.has(kind)}
      <label>
        {kind === "raw" ? "data (0x…)" : "Arg B"}
        <input bind:value={argB} placeholder={kind === "raw" ? "0x…" : "value / true|false"} />
      </label>
    {/if}
    {#if kind === "raw"}
      <label>value (wei) <input bind:value={argC} placeholder="0" /></label>
    {/if}
    <button on:click={build}>Build</button>
  </div>
  {#if buildErr}<p class="error">{buildErr}</p>{/if}
  {#if built}
    <pre>{JSON.stringify({to: built.to, value: built.value, data: built.data}, null, 2)}</pre>
    <p class="muted">{built.summary}</p>
    {#if hasGov}
      <button on:click={submit} disabled={submitting}>
        {submitting ? "Submitting…" : "Submit as proposal"}
      </button>
    {/if}
    {#if submitMsg}<p>{submitMsg}</p>{/if}
  {/if}

  <h2>Open proposals</h2>
  {#if !hasGov}
    <p class="empty">Configure a TokenVoting address to list + vote.</p>
  {:else}
    <button on:click={refresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
    {#if listErr}<p class="error">{listErr}</p>{/if}
    {#if proposals.length === 0 && !loading}
      <p class="empty">No proposals in the lookback window.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Summary</th><th>Window</th><th>Tally (Y/N/A)</th>
            <th>State</th><th>Your vote</th>
            <th title="Simulate the proposal's actions via dao.callStatic.execute(...) from the TokenVoting plugin">Sim</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each proposals as p (p.id)}
            {@const sim = simResults[p.id]}
            <tr>
              <td>{p.id}</td>
              <td title={p.summary}>{p.summary.slice(0, 48)}{p.summary.length > 48 ? "…" : ""}<br /><span class="muted">{p.actions.length} action(s)</span></td>
              <td class="muted">{ts(p.startDate)}<br />→ {ts(p.endDate)}</td>
              <td>{p.tally ? `${p.tally.yes}/${p.tally.no}/${p.tally.abstain}` : "—"}</td>
              <td>
                {#if p.executed}<span class="ok">executed</span>
                {:else if p.canExecute}<span class="warn">passable</span>
                {:else if p.open === false}<span class="muted">closed</span>
                {:else}<span>open</span>{/if}
              </td>
              <td>{voteLabel(p.myVote)}</td>
              <td>
                {#if sim === undefined}
                  <button class="small" disabled={p.executed} on:click={() => simulateRow(p)}>
                    Simulate
                  </button>
                {:else if sim === "loading"}
                  <span class="muted">…</span>
                {:else if sim.ok}
                  <span class="ok" title="dao.execute(actions) would succeed against current state">✓ ok</span>
                {:else}
                  <span class="error" title={sim.reason}>✗ {sim.reason.slice(0, 32)}{sim.reason.length > 32 ? "…" : ""}</span>
                {/if}
              </td>
              <td class="row-actions">
                {#if !p.executed}
                  <button disabled={rowBusy[p.id]} on:click={() => doVote(p.id, VoteOption.Yes)}>Yes</button>
                  <button disabled={rowBusy[p.id]} on:click={() => doVote(p.id, VoteOption.No)}>No</button>
                  <button disabled={rowBusy[p.id]} on:click={() => doVote(p.id, VoteOption.Abstain)}>Abstain</button>
                  {#if p.canExecute}
                    <button class="exec" disabled={rowBusy[p.id]} on:click={() => doExecute(p.id)}>Execute</button>
                  {/if}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
{/if}

<style>
  .form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: flex-end;
    margin: 0.5rem 0 1rem;
  }
  .form label {
    display: flex;
    flex-direction: column;
    font-size: 0.85rem;
  }
  .form input,
  .form select {
    min-width: 260px;
  }
  pre {
    background: #f5f5f5;
    padding: 0.75rem;
    overflow-x: auto;
    font-size: 0.8rem;
  }
  .row-actions {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }
  .exec {
    background: #0a7;
    color: #fff;
  }
  .error {
    color: #b00020;
  }
  .ok {
    color: #0a7;
  }
  .warn {
    color: #b67;
    font-weight: 600;
  }
  button.small {
    padding: 0.1rem 0.4rem;
    font-size: 0.8rem;
  }
</style>
