<!--
  Pick an ERC20 from the chain's tracked tokens (USDC, WETH, …) or paste any
  address. Binds the resolved 0x address back to `value`. Use everywhere a
  pasted token address used to be a single text input.
-->
<script lang="ts">
  import {ethers} from "ethers";
  import type {ChainConfig} from "$lib/types";

  export let value: string;
  export let cfg: ChainConfig | undefined;
  export let placeholder = "0x… custom token";
  /** Width override for the select (and the custom input). */
  export let minWidth = "180px";

  // Curated list: ERC20 tokens we know decimals for. Skips protocol singletons
  // (PoolManager / Router / Permit2 / AAVE pool) which aren't user-pickable.
  const KNOWN = ["USDC", "WETH"] as const;
  $: knownPairs = (
    cfg
      ? KNOWN.map((sym) => ({sym: sym as string, addr: cfg.external[sym]})).filter((t) => !!t.addr)
      : []
  ) as Array<{sym: string; addr: string}>;

  // "mode" is what the <select> shows. CUSTOM keeps a separate text input
  // visible so the user can paste anything.
  const CUSTOM = "__custom__";
  let mode: string = CUSTOM;
  let custom = "";
  let initialized = false;

  // Sync the picker UI to the initial `value` prop, once cfg is in.
  $: if (!initialized && cfg && (knownPairs.length || value)) {
    const match = knownPairs.find((p) => p.addr.toLowerCase() === (value || "").toLowerCase());
    if (match) {
      mode = match.addr;
    } else {
      mode = CUSTOM;
      custom = value || "";
    }
    initialized = true;
  }

  // Push the user's pick back up through `value`.
  function onSelect(e: Event): void {
    mode = (e.target as HTMLSelectElement).value;
    if (mode !== CUSTOM) {
      value = mode;
    } else {
      value = custom;
    }
  }
  function onCustom(e: Event): void {
    custom = (e.target as HTMLInputElement).value.trim();
    value = custom;
  }

  $: valid = !value || ethers.utils.isAddress(value);
</script>

<span class="ts" style:--w={minWidth}>
  <select value={mode} on:change={onSelect}>
    {#each knownPairs as p}
      <option value={p.addr}>{p.sym}</option>
    {/each}
    <option value={CUSTOM}>Custom…</option>
  </select>
  {#if mode === CUSTOM}
    <input value={custom} on:input={onCustom} placeholder={placeholder} class:bad={!valid} />
  {/if}
</span>

<style>
  .ts {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  select {
    min-width: var(--w);
  }
  input {
    min-width: var(--w);
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
  }
  input.bad {
    border-color: #b00020;
  }
</style>
