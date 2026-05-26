<!--
  Swap history — recent SwapExecuted events from the UniswapV4Plugin.
  Pages back N blocks from head (events backend; subgraph not required for
  the toy frontend).
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {uniswapContract} from "$lib/contracts";

  // ~24h on mainnet (12s blocks). Reduce on testnets if RPC paginates.
  const LOOKBACK_BLOCKS = 7200;

  async function load(chainId: number, provider: ethers.providers.Provider) {
    const cfg = chainConfig(chainId);
    if (!cfg?.dao) throw new Error("No DAO configured");
    const uni = uniswapContract(cfg, provider);
    const tip = await provider.getBlockNumber();
    const from = Math.max(0, tip - LOOKBACK_BLOCKS);
    const filter = uni.filters.SwapExecuted();
    const events = await uni.queryFilter(filter, from, tip);
    return {events: events.reverse(), from, tip};
  }
</script>

<h1>Swap history</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect to load swap history.</p>
{:else}
  {@const cfg = chainConfig($wallet.chainId)}
  {#if !cfg?.dao}
    <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
  {:else}
    {#await load($wallet.chainId, $wallet.provider)}
      <p class="muted">Loading…</p>
    {:then data}
      <p class="muted">
        Scanning blocks {data.from} → {data.tip}. For richer history, query the subgraph
        instead (see <code>subgraph/README.md</code>).
      </p>
      {#if data.events.length === 0}
        <p class="empty">No swaps in the lookback window.</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th>Block</th>
              <th>Token in</th>
              <th>Amount in</th>
              <th>Token out</th>
              <th>Amount out (actual)</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {#each data.events as e}
              <tr>
                <td>{e.blockNumber}</td>
                <td><code>{e.args?.tokenIn.slice(0, 10)}…</code></td>
                <td>{e.args?.amountIn.toString()}</td>
                <td><code>{e.args?.tokenOut.slice(0, 10)}…</code></td>
                <td>{e.args?.amountOutActual.toString()}</td>
                <td><code>{e.transactionHash.slice(0, 10)}…</code></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:catch err}
      <p class="error">Failed: {err.message}</p>
    {/await}
  {/if}
{/if}

<style>
  .error {
    color: #b00020;
  }
</style>
