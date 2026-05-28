<!-- An address with copy-to-clipboard. Shows the full address (mono) by default
     plus a label chip when known (DAO / plugin / token). Compact mode shows a
     short address instead. -->
<script lang="ts">
  import {shortAddress} from "$lib/format";
  export let address: string;
  export let label: string | null = null;
  export let compact = false;

  let copied = false;
  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }
</script>

<span class="addr">
  {#if label}<span class="chip">{label}</span>{/if}
  <code title={address}>{compact ? shortAddress(address) : address}</code>
  <button class="copy" type="button" title="Copy address" aria-label="Copy address" on:click={copy}>
    {copied ? "✓" : "⧉"}
  </button>
</span>

<style>
  .addr {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .chip {
    background: #eef1f8;
    color: #2d3f6b;
    border: 1px solid #d6deef;
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 600;
    white-space: nowrap;
  }
  code {
    font-size: 0.85rem;
  }
  .copy {
    background: none;
    border: 1px solid #ddd;
    border-radius: 4px;
    cursor: pointer;
    padding: 0 0.35rem;
    line-height: 1.4;
    color: #666;
    font-size: 0.8rem;
  }
  .copy:hover {
    background: #f3f3f3;
    color: #222;
  }
</style>
