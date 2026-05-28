<!--
  Operating costs View (MVVM). Thin: binds the costs ViewModel's stores +
  commands. Logic lives in $lib/viewmodels/costs.ts.
-->
<script lang="ts">
  import {wallet} from "$lib/wallet";
  import {createCostsVM, PAGE, isDue, fmtDate} from "$lib/viewmodels/costs";
  import {formatToken, shortAddress} from "$lib/format";
  import {subgraphEnabled} from "$lib/subgraph";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import ProposeAction from "$lib/components/ProposeAction.svelte";

  const vm = createCostsVM();
  const {
    loading,
    loadError,
    noPlugin,
    data,
    offset,
    crankBusy,
    crankResult,
    crankOffset,
    crankLimit,
    payments,
    payLoading,
    rId,
    rName,
    rDesc,
    rCost,
    rFreq,
    rPayee,
    regAction,
    removeId,
    removeAction,
    maxEntries,
    setMaxEntriesAction,
  } = vm;

  const USDC = {symbol: "USDC", decimals: 6};

  let lastKey = "";
  $: {
    const key = $wallet.status === "connected" ? String($wallet.chainId) : "";
    if (key && key !== lastKey) {
      lastKey = key;
      vm.load();
    }
  }
</script>

<h1>Operating costs</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect to load the cost registry.</p>
{:else if $noPlugin}
  <p class="empty">
    No CostRegistry plugin configured (6th address in <code>PUBLIC_DAO_*</code>).
  </p>
{:else if $loadError}
  <p class="empty">{$loadError}</p>
{:else if $loading || !$data}
  <Skeleton rows={5} />
{:else}
  {@const d = $data}
  <p class="muted">
    Paid in <code>{d.token}</code> · {d.total} entr{d.total === 1 ? "y" : "ies"} total
  </p>
  {#if d.rows.length === 0}
    <p class="empty">No entries in this page.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>#</th><th>Name</th><th>Payee</th><th>Cost</th>
          <th>Every</th><th>Next due</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        {#each d.rows as r}
          <tr class={r.active ? "" : "inactive"}>
            <td>{r.id}</td>
            <td title={r.description}>{r.name}</td>
            <td><code>{shortAddress(r.payee)}</code></td>
            <td>{formatToken(r.costUsdc, USDC)}</td>
            <td>{r.frequencyDays}d</td>
            <td>{fmtDate(r.nextAt)}</td>
            <td>
              {#if !r.active}<span class="muted">removed</span>
              {:else if isDue(r)}<span class="warn">due</span>
              {:else}<span class="ok">scheduled</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  <div class="pager">
    <button disabled={$offset === 0} on:click={() => vm.setOffset($offset - PAGE)}>← Prev</button>
    <span class="muted">rows {$offset}–{$offset + d.rows.length} of {d.total}</span>
    <button disabled={$offset + PAGE >= d.total} on:click={() => vm.setOffset($offset + PAGE)}>
      Next →
    </button>
  </div>

  <h2>Payment history</h2>
  {#if subgraphEnabled()}
    <button on:click={vm.loadPayments} disabled={$payLoading}>
      {$payLoading ? "Loading…" : $payments ? "Refresh" : "Load history"}
    </button>
    {#if $payments && $payments.length > 0}
      <table>
        <thead>
          <tr><th>When</th><th>Entry</th><th>Payee</th><th>Amount</th><th>Tx</th></tr>
        </thead>
        <tbody>
          {#each $payments as p}
            <tr>
              <td>{new Date(Number(p.paidAt) * 1000).toISOString().slice(0, 16).replace("T", " ")}</td>
              <td>#{p.entry.entryId} {p.entry.name}</td>
              <td><code>{shortAddress(p.payee)}</code></td>
              <td>{formatToken(p.amount, USDC)}</td>
              <td><code>{p.txHash.slice(0, 10)}…</code></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if $payments}
      <p class="empty">No payments indexed yet.</p>
    {/if}
  {:else}
    <p class="muted">
      Set <code>PUBLIC_SUBGRAPH_URL</code> to see per-entry payment history (<code>CostPaid</code>
      events) here. Without a subgraph, only the live entry list above is available.
    </p>
  {/if}

  <h2>Crank (permissionless)</h2>
  <p class="muted">
    <code>processDue(offset, limit)</code> pays every due entry in the index window. Idempotent per
    entry — re-runs only pay entries that have since come due.
  </p>
  <div class="form">
    <label>offset <input bind:value={$crankOffset} style="min-width:80px" /></label>
    <label>limit <input bind:value={$crankLimit} style="min-width:80px" /></label>
    <button on:click={vm.runCrank} disabled={$crankBusy}>
      {$crankBusy ? "Submitting…" : "processDue"}
    </button>
  </div>
  {#if $crankResult}<p>{$crankResult}</p>{/if}

  <h2>Propose: register / update entry</h2>
  <p class="muted">Leave "id" blank to register a new entry; set it to update an existing one.</p>
  <div class="form">
    <label>id (update only) <input bind:value={$rId} placeholder="blank = new" style="min-width:110px" /></label>
    <label>name <input bind:value={$rName} placeholder="AWS" /></label>
    <label>description <input bind:value={$rDesc} placeholder="cloud bill" /></label>
    <label>cost (USDC) <input bind:value={$rCost} placeholder="500" /></label>
    <label>frequency (days) <input bind:value={$rFreq} placeholder="30" style="min-width:120px" /></label>
    <label>payee <input bind:value={$rPayee} placeholder="0x..." /></label>
    <button on:click={vm.buildRegisterOrUpdate}>Build</button>
  </div>
  <ProposeAction action={$regAction} />

  <h2>Propose: remove entry</h2>
  <div class="form">
    <label>id <input bind:value={$removeId} placeholder="0" style="min-width:90px" /></label>
    <button on:click={vm.buildRemove}>Build</button>
  </div>
  <ProposeAction action={$removeAction} />

  <h2>Propose: set max entries</h2>
  <p class="muted">Raise or lower the entry-slot cap (≤ ceiling, ≥ current count). Vote-gated.</p>
  <div class="form">
    <label>New max <input bind:value={$maxEntries} placeholder="500" style="min-width:120px" /></label>
    <button on:click={vm.buildSetMaxEntries}>Build</button>
  </div>
  <ProposeAction action={$setMaxEntriesAction} />
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
  .pager {
    display: flex;
    gap: 1rem;
    align-items: center;
    margin: 0.75rem 0;
  }
  tr.inactive {
    opacity: 0.5;
  }
  .ok {
    color: #0a7;
  }
  .warn {
    color: #b67;
    font-weight: 600;
  }
</style>
