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
  import * as actions from "$lib/actions";
  import type {ProposalAction} from "$lib/actions";
  import ProposeAction from "$lib/components/ProposeAction.svelte";

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

  // --- Propose: swap ---
  // commands/inputs are raw Universal Router bytes (build them with the Uniswap
  // SDK off-chain). decimals: tokenIn=18, minOut=18 by default — refine per token.
  let sCommands = "";
  let sInputs = ""; // JSON array of hex strings, e.g. ["0x...","0x..."]
  let sDeadline = "";
  let sTokenIn = "";
  let sAmountIn = "";
  let sTokenOut = "";
  let sMinOut = "";
  let sDecIn = "18";
  let sDecOut = "18";
  let swapAction: ProposalAction | null = null;

  function buildSwap(): void {
    swapAction = null;
    try {
      const cfg = chainConfig($wallet.status === "connected" ? $wallet.chainId : 1);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const inputs = JSON.parse(sInputs || "[]") as string[];
      if (!Array.isArray(inputs)) throw new Error("inputs must be a JSON array of hex strings");
      const deadline = sDeadline?.trim()
        ? ethers.BigNumber.from(sDeadline.trim())
        : ethers.BigNumber.from(Math.floor(Date.now() / 1000) + 7 * 24 * 3600); // +7d default
      swapAction = actions.uniSwap(cfg, {
        commands: sCommands || "0x",
        inputs,
        deadline,
        tokenIn: sTokenIn,
        amountIn: ethers.utils.parseUnits(sAmountIn || "0", parseInt(sDecIn, 10)),
        tokenOut: sTokenOut,
        minAmountOut: ethers.utils.parseUnits(sMinOut || "0", parseInt(sDecOut, 10)),
      });
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
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

    <h2>Propose: swap</h2>
    <p class="muted">
      Vote-gated. <code>commands</code>/<code>inputs</code> are raw Universal Router bytes
      (encode the route with the Uniswap SDK off-chain). The slippage guard
      (<code>minAmountOut</code>) and <code>deadline</code> are checked at execution — set the
      deadline well past your voting window and <code>minAmountOut</code> conservatively.
    </p>
    <div class="form">
      <label>commands (0x) <input bind:value={sCommands} placeholder="0x..." /></label>
      <label>inputs (JSON hex[]) <input bind:value={sInputs} placeholder={'["0x..."]'} /></label>
      <label>deadline (unix, blank = +7d) <input bind:value={sDeadline} placeholder="auto" /></label>
      <label>tokenIn <input bind:value={sTokenIn} placeholder="0x..." /></label>
      <label>amountIn <input bind:value={sAmountIn} placeholder="1.0" /></label>
      <label>decimals in <input bind:value={sDecIn} style="min-width:70px" /></label>
      <label>tokenOut <input bind:value={sTokenOut} placeholder="0x..." /></label>
      <label>minAmountOut <input bind:value={sMinOut} placeholder="0.99" /></label>
      <label>decimals out <input bind:value={sDecOut} style="min-width:70px" /></label>
      <button on:click={buildSwap}>Build</button>
    </div>
    <ProposeAction action={swapAction} />
  {/if}
{/if}

<style>
  .error {
    color: #b00020;
  }
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
</style>
