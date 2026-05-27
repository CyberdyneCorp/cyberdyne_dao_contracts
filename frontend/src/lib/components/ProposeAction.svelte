<!--
  Reusable "turn this action into a proposal" widget. Pass a built
  ProposalAction; renders the calldata + a submit button (when a governance
  plugin is configured) or a copy-JSON fallback otherwise.
-->
<script lang="ts">
  import {wallet, signer} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {governanceConfigured, proposeActions} from "$lib/governance";
  import type {ProposalAction} from "$lib/actions";

  export let action: ProposalAction | null = null;

  let msg: string | null = null;
  let busy = false;

  $: cfg = $wallet.status === "connected" ? chainConfig($wallet.chainId) : undefined;
  $: hasGov = cfg ? governanceConfigured(cfg) : false;

  async function submit(): Promise<void> {
    if (!action || !$signer || !cfg) return;
    msg = null;
    busy = true;
    try {
      const {hash, proposalId} = await proposeActions(cfg, $signer, [action], action.summary);
      msg = `Proposal ${proposalId ?? "?"} created (${hash.slice(0, 10)}…). See the Proposals page to vote.`;
    } catch (err) {
      msg = `Failed: ${(err as Error).message}`;
    } finally {
      busy = false;
    }
  }

  async function copy(): Promise<void> {
    if (!action) return;
    const json = JSON.stringify({to: action.to, value: action.value, data: action.data}, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      msg = "Calldata copied to clipboard.";
    } catch {
      msg = "Copy failed — select the JSON above manually.";
    }
  }
</script>

{#if action}
  <pre>{JSON.stringify({to: action.to, value: action.value, data: action.data}, null, 2)}</pre>
  <p class="muted">{action.summary}</p>
  <div class="actions">
    {#if hasGov}
      <button on:click={submit} disabled={busy}>{busy ? "Submitting…" : "Submit as proposal"}</button>
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
