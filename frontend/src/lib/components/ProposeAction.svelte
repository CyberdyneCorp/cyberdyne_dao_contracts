<!--
  Reusable "turn an action (or batch) into a proposal" widget.

  Pass either a single ProposalAction or a ProposalAction[]:
    • single-action  → encodes the direct call (admin/storage-only ops);
    • multi-action   → submits the whole batch atomically (governance-safe
                       path for fund-moving ops: V3 mint, V4 LP, AAVE).

  When a TokenVoting (governance) plugin is configured, the widget creates a
  TokenVoting proposal carrying the action[]. Otherwise it falls back to a
  copy-calldata view for an external proposal builder.
-->
<script lang="ts">
  import {wallet, signer} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {governanceConfigured, proposeActions} from "$lib/governance";
  import type {ProposalAction} from "$lib/actions";

  export let action: ProposalAction | ProposalAction[] | null = null;

  let msg: string | null = null;
  let busy = false;

  $: cfg = $wallet.status === "connected" ? chainConfig($wallet.chainId) : undefined;
  $: hasGov = cfg ? governanceConfigured(cfg) : false;
  // Normalize to an array — the rest of the component treats single + multi identically.
  $: actions = action == null ? [] : Array.isArray(action) ? action : [action];
  $: summary =
    actions.length === 0
      ? ""
      : actions.length === 1
        ? actions[0].summary
        : `${actions[0].summary.split(" (")[0]} — ${actions.length}-action batch`;

  async function submit(): Promise<void> {
    if (actions.length === 0 || !$signer || !cfg) return;
    msg = null;
    busy = true;
    try {
      const {hash, proposalId} = await proposeActions(cfg, $signer, actions, summary);
      msg = `Proposal ${proposalId ?? "?"} created (${hash.slice(0, 10)}…). See the Proposals page to vote.`;
    } catch (err) {
      msg = `Failed: ${(err as Error).message}`;
    } finally {
      busy = false;
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
  <pre>{JSON.stringify(
      actions.map((a) => ({to: a.to, value: a.value, data: a.data})),
      null,
      2
    )}</pre>
  <p class="muted">
    {summary}
    {#if actions.length > 1}
      <em>· atomic: all {actions.length} actions execute in one tx, or none.</em>
    {/if}
  </p>
  <div class="actions">
    {#if hasGov}
      <button on:click={submit} disabled={busy}>
        {busy ? "Submitting…" : `Submit as ${actions.length === 1 ? "proposal" : `${actions.length}-action proposal`}`}
      </button>
    {:else}
      <span class="muted">No governance plugin configured — copy the calldata for an external builder.</span>
    {/if}
    <button on:click={copy}>Copy calldata</button>
  </div>
  {#if msg}<p>{msg}</p>{/if}
{/if}

<style>
  pre {
    background: #f5f5f5;
    padding: 0.75rem;
    overflow-x: auto;
    font-size: 0.8rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
</style>
