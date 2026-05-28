<!--
  Swap history View (MVVM). Thin: binds the swaps ViewModel. Logic lives in
  $lib/viewmodels/swaps.ts.
-->
<script lang="ts">
  import {wallet} from "$lib/wallet";
  import {createSwapsVM} from "$lib/viewmodels/swaps";
  import {formatAmount, shortAddress} from "$lib/format";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import ProposeAction from "$lib/components/ProposeAction.svelte";
  import ConnectPrompt from "$lib/components/ConnectPrompt.svelte";

  const vm = createSwapsVM();
  const {
    loading,
    loadError,
    noDao,
    data,
    sCommands,
    sInputs,
    sDeadline,
    sTokenIn,
    sAmountIn,
    sTokenOut,
    sMinOut,
    sDecIn,
    sDecOut,
    swapAction,
  } = vm;

  let lastKey = "";
  $: {
    const key = $wallet.status === "connected" ? String($wallet.chainId) : "";
    if (key && key !== lastKey) {
      lastKey = key;
      vm.load();
    }
  }
</script>

<div class="hero">
  <h1>Swap history</h1>
  <p class="hero-sub">
    DAO-initiated Uniswap V4 swaps. Every entry is a vote-gated swap proposal that
    executed on-chain — the actual <code>amountOut</code> is read back from balances.
  </p>
</div>

{#if $wallet.status !== "connected"}
  <ConnectPrompt context="load swap history" />
{:else if $noDao}
  <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
{:else}
  {#if $loadError}
    <p class="empty">{$loadError}</p>
  {:else if $loading || !$data}
    <Skeleton rows={4} />
  {:else}
    {@const d = $data}
    <p class="muted">
      {d.note}
      <span class="badge">{d.source === "subgraph" ? "subgraph" : "rpc scan"}</span>
    </p>
    {#if d.rows.length === 0}
      <p class="empty">No swaps found.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>{d.source === "subgraph" ? "When" : "Block"}</th>
            <th>Token in</th>
            <th>Amount in</th>
            <th>Token out</th>
            <th>Amount out (actual)</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {#each d.rows as r}
            <tr>
              <td>{r.ref}</td>
              <td><code>{shortAddress(r.tokenIn)}</code></td>
              <td>{formatAmount(d.cfg, r.amountIn, r.tokenIn)}</td>
              <td><code>{shortAddress(r.tokenOut)}</code></td>
              <td>{formatAmount(d.cfg, r.amountOutActual, r.tokenOut)}</td>
              <td><code>{r.txHash.slice(0, 10)}…</code></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}

  <section class="card-section">
    <h2>Propose: swap</h2>
    <p class="muted">
      Vote-gated. <code>commands</code> / <code>inputs</code> are raw Universal Router bytes (encode the
      route with the Uniswap SDK off-chain). The slippage guard (<code>minAmountOut</code>) and
      <code>deadline</code> are checked at execution — set the deadline well past your voting window
      and <code>minAmountOut</code> conservatively.
    </p>
    <div class="form">
      <label>commands (0x) <input bind:value={$sCommands} placeholder="0x..." /></label>
      <label>inputs (JSON hex[]) <input bind:value={$sInputs} placeholder={'["0x..."]'} /></label>
      <label>deadline (unix, blank = +7d) <input bind:value={$sDeadline} placeholder="auto" /></label>
      <label>tokenIn <input bind:value={$sTokenIn} placeholder="0x..." /></label>
      <label>amountIn <input bind:value={$sAmountIn} placeholder="1.0" /></label>
      <label>decimals in <input bind:value={$sDecIn} style="min-width:70px" /></label>
      <label>tokenOut <input bind:value={$sTokenOut} placeholder="0x..." /></label>
      <label>minAmountOut <input bind:value={$sMinOut} placeholder="0.99" /></label>
      <label>decimals out <input bind:value={$sDecOut} style="min-width:70px" /></label>
      <button on:click={vm.buildSwap}>Build</button>
    </div>
    <ProposeAction action={$swapAction} />
  </section>
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
  .form input {
    min-width: 200px;
  }
  .badge {
    display: inline-block;
    margin-left: 0.5rem;
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    font-size: 0.75rem;
    background: #eef;
    color: #336;
  }
</style>
