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
  import {chainConfig, supportedChainIds} from "$lib/chains";
  import {governanceConfigured, proposeActions} from "$lib/governance";
  import type {ProposalAction} from "$lib/actions";

  export let action: ProposalAction | ProposalAction[] | null = null;

  let msg: string | null = null;
  let busy = false;

  $: connected = $wallet.status === "connected";
  $: connectedChainId =
    $wallet.status === "connected" ? ($wallet.chainId as number) : undefined;
  $: cfg = connectedChainId !== undefined ? chainConfig(connectedChainId) : undefined;
  $: hasGov = cfg ? governanceConfigured(cfg) : false;
  // Distinguish three failure modes so the user gets a useful message:
  //   1. wallet not connected                    → connect-wallet prompt
  //   2. connected to a chain absent from chains → wrong-network warning
  //   3. connected to a known chain but governance addr not set in env → existing copy-calldata fallback
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
</style>
