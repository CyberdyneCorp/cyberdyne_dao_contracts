<!--
  Reusable "turn an action (or batch) into a proposal" widget.

  Pass either a single ProposalAction or a ProposalAction[]:
    • single-action  → encodes the direct call (admin/storage-only ops);
    • multi-action   → submits the whole batch atomically (governance-safe
                       path for fund-moving ops: V3 mint, V4 LP, AAVE).

  Renders a decoded preview per action (target chip, function signature, typed
  args with address labels) instead of raw calldata, plus a pre-submit Simulate
  button (dry-runs the whole batch via `dao.callStatic.execute` from the
  TokenVoting plugin), and the existing Submit + Copy controls. Raw calldata is
  tucked into a collapsible <details>.

  When a TokenVoting (governance) plugin is configured, the widget creates a
  TokenVoting proposal carrying the action[]. Otherwise it falls back to a
  copy-calldata view for an external proposal builder.
-->
<script lang="ts">
  import {wallet, signer} from "$lib/wallet";
  import {chainConfig, supportedChainIds} from "$lib/chains";
  import {governanceConfigured, proposeActions, simulateProposalExecution} from "$lib/governance";
  import type {ProposalAction} from "$lib/actions";
  import {decodeCall, targetDisplay} from "$lib/decode";
  import {errorMessage} from "$lib/format";

  export let action: ProposalAction | ProposalAction[] | null = null;

  let msg: string | null = null;
  let busy = false;
  type SimVerdict = "loading" | {ok: true} | {ok: false; reason: string} | null;
  let sim: SimVerdict = null;

  $: connected = $wallet.status === "connected";
  $: connectedChainId =
    $wallet.status === "connected" ? ($wallet.chainId as number) : undefined;
  $: cfg = connectedChainId !== undefined ? chainConfig(connectedChainId) : undefined;
  $: hasGov = cfg ? governanceConfigured(cfg) : false;
  $: chainKnown = connected ? cfg !== undefined : true;
  $: chainListLabel = supportedChainIds().join(", ");

  // Normalize to an array — the rest of the component treats single + multi identically.
  $: actions = action == null ? [] : Array.isArray(action) ? action : [action];
  $: summary =
    actions.length === 0
      ? ""
      : actions.length === 1
        ? actions[0].summary
        : `${actions[0].summary.split(" (")[0]} — ${actions.length}-action batch`;
  // Drop any stale Simulate verdict whenever the action input changes.
  $: if (actions) sim = null;

  $: decoded = actions.map((a) => decodeCall(cfg, a.to, a.data));

  async function submit(): Promise<void> {
    if (actions.length === 0 || !$signer || !cfg) return;
    msg = null;
    busy = true;
    try {
      const {hash, proposalId} = await proposeActions(cfg, $signer, actions, summary);
      msg = `Proposal ${proposalId ?? "?"} created (${hash.slice(0, 10)}…). See the Proposals page to vote.`;
    } catch (err) {
      msg = `Failed: ${errorMessage(err)}`;
    } finally {
      busy = false;
    }
  }

  async function simulate(): Promise<void> {
    if (actions.length === 0) return;
    sim = "loading";
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      if (!cfg) throw new Error("Unsupported chain");
      sim = await simulateProposalExecution(cfg, $wallet.provider, actions);
    } catch (err) {
      sim = {ok: false, reason: errorMessage(err)};
    }
  }

  async function copy(): Promise<void> {
    if (actions.length === 0) return;
    const json = JSON.stringify(
      actions.map((a) => ({to: a.to, value: a.value, data: a.data})),
      null,
      2
    );
    try {
      await navigator.clipboard.writeText(json);
      msg = `Calldata copied to clipboard (${actions.length} action${actions.length === 1 ? "" : "s"}).`;
    } catch {
      msg = "Copy failed — select the JSON above manually.";
    }
  }
</script>

{#if actions.length > 0}
  <div class="built">
    <div class="built-summary">
      {summary}
      {#if actions.length > 1}
        <em class="muted">· atomic: all {actions.length} actions execute in one tx, or none.</em>
      {/if}
    </div>

    {#each actions as a, i}
      {@const d = decoded[i]}
      <div class="act">
        {#if actions.length > 1}<div class="act-head">action {i + 1} / {actions.length}</div>{/if}
        <table class="decode">
          <tbody>
            <tr>
              <th>Target</th>
              <td>
                {#if d.targetLabel}
                  <span class="chip ok-chip">{d.targetLabel}</span>
                {:else}
                  <span class="chip warn-chip" title="Not one of this DAO's plugins or tracked tokens">unknown contract</span>
                {/if}
                <code>{a.to}</code>
              </td>
            </tr>
            <tr>
              <th>Function</th>
              <td>
                {#if d.signature}<code>{d.signature}</code>
                {:else}<span class="warn">unrecognized selector {d.selector}</span>{/if}
              </td>
            </tr>
            {#if d.args}
              {#each d.args as arg}
                <tr>
                  <th class="arg">{arg.name} <span class="muted">({arg.type})</span></th>
                  <td>
                    {#if arg.label}<span class="chip ok-chip">{arg.label}</span>{/if}
                    <code>{arg.value}</code>
                  </td>
                </tr>
              {/each}
            {/if}
            {#if a.value !== "0"}
              <tr><th>ETH value</th><td>{a.value} wei</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    {/each}

    <details class="raw">
      <summary class="muted">raw calldata</summary>
      <pre>{JSON.stringify(
          actions.map((a) => ({to: a.to, value: a.value, data: a.data})),
          null,
          2
        )}</pre>
    </details>

    <div class="actions">
      <button class="ghost" on:click={simulate} disabled={sim === "loading"}>
        {sim === "loading" ? "Simulating…" : "Simulate"}
      </button>
      {#if sim && sim !== "loading"}
        {#if sim.ok}
          <span class="ok">✓ would execute successfully</span>
        {:else}
          <span class="error" title={sim.reason}>✗ {sim.reason.slice(0, 80)}{sim.reason.length > 80 ? "…" : ""}</span>
        {/if}
      {/if}
      {#if hasGov}
        <button class="primary" on:click={submit} disabled={busy}>
          {busy ? "Submitting…" : `Submit as ${actions.length === 1 ? "proposal" : `${actions.length}-action proposal`}`}
        </button>
      {:else if !connected}
        <span class="warn">Connect a wallet to submit a proposal.</span>
      {:else if !chainKnown}
        <span class="warn">
          Wrong network: chainId <strong>{connectedChainId}</strong> is not in <code>chains.ts</code>.
          Switch to one of: <code>{chainListLabel}</code>.
        </span>
      {:else}
        <span class="muted">
          Connected to <strong>{cfg?.name ?? "?"}</strong> (chainId {connectedChainId}) but no
          governance plugin is wired in <code>PUBLIC_DAO_*</code> for this chain — paste the
          calldata into your DAO's proposal builder, or set the governance addr in your env.
        </span>
      {/if}
      <button on:click={copy}>Copy calldata</button>
    </div>
    {#if msg}<p class="msg">{msg}</p>{/if}
  </div>
{/if}

<style>
  .built {
    border: 1px solid #e2e6ef;
    border-radius: 8px;
    padding: 0.85rem 1rem;
    margin: 0.5rem 0 1.25rem;
    background: #fbfcfe;
  }
  .built-summary {
    font-weight: 600;
    margin-bottom: 0.6rem;
  }
  .act + .act {
    margin-top: 0.75rem;
    padding-top: 0.5rem;
    border-top: 1px dashed #d6deef;
  }
  .act-head {
    font-size: 0.78rem;
    color: #5a6b8a;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.3rem;
  }
  table.decode {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 0.4rem;
  }
  table.decode th,
  table.decode td {
    text-align: left;
    vertical-align: top;
    padding: 0.25rem 0.6rem 0.25rem 0;
    font-size: 0.85rem;
    border: none;
  }
  table.decode th {
    color: #555;
    font-weight: 600;
    white-space: nowrap;
    width: 1%;
  }
  table.decode th.arg {
    padding-left: 1rem;
    font-weight: 500;
  }
  table.decode code {
    word-break: break-all;
  }
  .chip {
    display: inline-block;
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 600;
    margin-right: 0.35rem;
    white-space: nowrap;
  }
  .ok-chip {
    background: #e7f3ec;
    color: #1a7f37;
    border: 1px solid #b9e0c6;
  }
  .warn-chip {
    background: #fdf3e7;
    color: #8a4a00;
    border: 1px solid #f0d9b9;
  }
  .raw {
    margin-bottom: 0.5rem;
  }
  .raw summary {
    cursor: pointer;
    font-size: 0.8rem;
  }
  .raw pre {
    background: #f5f5f5;
    padding: 0.6rem;
    overflow-x: auto;
    font-size: 0.78rem;
    margin: 0.3rem 0 0;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .actions .primary {
    background: #1a3f7f;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.3rem 0.8rem;
  }
  .actions .ghost {
    background: #fff;
    border: 1px solid #ccd3e0;
    border-radius: 4px;
    padding: 0.3rem 0.8rem;
    cursor: pointer;
  }
  .ok {
    color: #1a7f37;
    font-size: 0.85rem;
  }
  .warn {
    color: #8a4a00;
    background: #fff3cd;
    padding: 0.4rem 0.6rem;
    border-radius: 3px;
    border: 1px solid #ffe7a0;
    font-size: 0.9rem;
  }
  .warn code {
    background: rgba(0, 0, 0, 0.05);
    padding: 0.05rem 0.25rem;
    border-radius: 2px;
  }
  .error {
    color: #b00020;
    font-size: 0.85rem;
  }
  .msg {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
  }
</style>
