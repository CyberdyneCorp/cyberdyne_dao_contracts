<!--
  Swap history — recent SwapExecuted events from the UniswapV4Plugin.
  Source of truth depends on config: when PUBLIC_SUBGRAPH_URL is set we query
  the subgraph (full history, fast); otherwise we page back N blocks from head
  via direct RPC (works on a bare localFork with no subgraph).
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {uniswapContract} from "$lib/contracts";
  import * as actions from "$lib/actions";
  import type {ProposalAction} from "$lib/actions";
  import ProposeAction from "$lib/components/ProposeAction.svelte";
  import {subgraphEnabled, fetchSwaps} from "$lib/subgraph";

  // ~24h on mainnet (12s blocks). Reduce on testnets if RPC paginates.
  const LOOKBACK_BLOCKS = 7200;

  // Unified row shape so the template doesn't care about the source.
  type SwapRow = {
    tokenIn: string;
    amountIn: string;
    tokenOut: string;
    amountOutActual: string;
    ref: string; // block number (RPC) or timestamp (subgraph)
    txHash: string;
  };

  async function load(
    chainId: number,
    provider: ethers.providers.Provider
  ): Promise<{rows: SwapRow[]; source: "subgraph" | "rpc"; note: string}> {
    const cfg = chainConfig(chainId);
    if (!cfg?.dao) throw new Error("No DAO configured");

    if (subgraphEnabled()) {
      const swaps = await fetchSwaps(cfg.dao.dao);
      const rows: SwapRow[] = swaps.map((s) => ({
        tokenIn: s.tokenIn,
        amountIn: s.amountIn,
        tokenOut: s.tokenOut,
        amountOutActual: s.amountOutActual,
        ref: new Date(Number(s.timestamp) * 1000).toISOString().slice(0, 16).replace("T", " "),
        txHash: s.txHash,
      }));
      return {rows, source: "subgraph", note: `${rows.length} swap(s) from the subgraph (full history).`};
    }

    const uni = uniswapContract(cfg, provider);
    const tip = await provider.getBlockNumber();
    const from = Math.max(0, tip - LOOKBACK_BLOCKS);
    const events = await uni.queryFilter(uni.filters.SwapExecuted(), from, tip);
    const rows: SwapRow[] = events.reverse().map((e) => ({
      tokenIn: e.args?.tokenIn,
      amountIn: e.args?.amountIn.toString(),
      tokenOut: e.args?.tokenOut,
      amountOutActual: e.args?.amountOutActual.toString(),
      ref: e.blockNumber.toString(),
      txHash: e.transactionHash,
    }));
    return {
      rows,
      source: "rpc",
      note: `Scanning blocks ${from} → ${tip} via RPC. Set PUBLIC_SUBGRAPH_URL for full history.`,
    };
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
        {data.note}
        <span class="badge">{data.source === "subgraph" ? "subgraph" : "rpc scan"}</span>
      </p>
      {#if data.rows.length === 0}
        <p class="empty">No swaps found.</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th>{data.source === "subgraph" ? "When" : "Block"}</th>
              <th>Token in</th>
              <th>Amount in</th>
              <th>Token out</th>
              <th>Amount out (actual)</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {#each data.rows as r}
              <tr>
                <td>{r.ref}</td>
                <td><code>{r.tokenIn.slice(0, 10)}…</code></td>
                <td>{r.amountIn}</td>
                <td><code>{r.tokenOut.slice(0, 10)}…</code></td>
                <td>{r.amountOutActual}</td>
                <td><code>{r.txHash.slice(0, 10)}…</code></td>
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
