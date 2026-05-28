<!--
  Payroll View (MVVM). Thin: binds to the payroll ViewModel's stores + commands
  and renders. All logic lives in $lib/viewmodels/payroll.ts.
-->
<script lang="ts">
  import {wallet} from "$lib/wallet";
  import {createPayrollVM, periodLabel} from "$lib/viewmodels/payroll";
  import {formatToken, resolveToken} from "$lib/format";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import ProposeAction from "$lib/components/ProposeAction.svelte";
  import AddressTag from "$lib/components/AddressTag.svelte";

  const vm = createPayrollVM();
  const {
    loading,
    loadError,
    data,
    crankBusy,
    crankResult,
    pageSize,
    newPayee,
    newToken,
    newAmount,
    addAction,
    setAmtPayee,
    setAmtToken,
    setAmtValue,
    setAmountAction,
    maxRecip,
    setMaxAction,
    forceYear,
    forceMonth,
    forceActions,
  } = vm;

  // Load once per (chain) connection — re-run when the connected chain changes.
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
  <h1>Payroll</h1>
  <p class="hero-sub">
    Vote-gated monthly salaries. Anyone can run the permissionless crank when the
    pay day comes — failures isolate per recipient, missed months are skipped.
  </p>
</div>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect to load payroll schedule.</p>
{:else if $loadError}
  <p class="empty">{$loadError}</p>
{:else if $loading || !$data}
  <Skeleton rows={4} />
{:else}
  {@const d = $data}
  <h2>Schedule</h2>
  <div class="cards">
    <div class="card">
      <span class="card-label">Pay day of month</span>
      <span class="card-value">{d.payDay}</span>
    </div>
    <div class="card">
      <span class="card-label">Last paid period</span>
      <span class="card-value">{periodLabel(d.lastPeriod)}</span>
    </div>
    <div class="card">
      <span class="card-label">Page size cap</span>
      <span class="card-value">{d.perPage.toString()}</span>
    </div>
  </div>
  {#if !d.cursor.isZero()}
    <p class="muted">
      Pagination in progress for period {periodLabel(d.cursorPeriod)} — resume at recipient index
      {d.cursor.toString()} via "Run page" below.
    </p>
  {/if}

  <h2>Active recipients ({d.recipients.length})</h2>
  {#if d.recipients.length === 0}
    <p class="empty">No active recipients.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Payee</th><th>Token</th><th>Amount</th></tr>
      </thead>
      <tbody>
        {#each d.recipients as r}
          <tr>
            <td><AddressTag address={r.payee} /></td>
            <td>{resolveToken(d.cfg, r.token).symbol}</td>
            <td>{formatToken(r.amount, resolveToken(d.cfg, r.token))}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <section class="card-section">
    <h2>Crank (permissionless)</h2>
    <p class="muted">
      <code>executePayroll()</code> pays the whole period in one batch (reverts if it exceeds
      {d.perPage.toString()} recipients). For larger payrolls run pages with
      <code>executePayrollPage(n)</code> until the period completes.
    </p>
    <div class="form">
      <button on:click={() => vm.runCrank(true)} disabled={$crankBusy}>
        {$crankBusy ? "Submitting…" : "executePayroll()"}
      </button>
      <label>Page size <input bind:value={$pageSize} placeholder="100" style="min-width:80px" /></label>
      <button on:click={() => vm.runCrank(false)} disabled={$crankBusy}>Run page</button>
    </div>
    {#if $crankResult}<p>{$crankResult}</p>{/if}
  </section>

  <section class="card-section">
    <h2>Propose: add recipient</h2>
    <p class="muted">Vote-gated — builds an action the DAO executes after a vote passes.</p>
    <div class="form">
      <label>Payee <input bind:value={$newPayee} placeholder="0x..." /></label>
      <label>Token <input bind:value={$newToken} placeholder="0x... (or 0x0 for ETH)" /></label>
      <label>Amount (decimal) <input bind:value={$newAmount} placeholder="1000" /></label>
      <button on:click={vm.buildAddRecipient}>Build</button>
    </div>
    <ProposeAction action={$addAction} />
  </section>

  <section class="card-section">
    <h2>Propose: set recipient amount</h2>
    <div class="form">
      <label>Payee <input bind:value={$setAmtPayee} placeholder="0x..." /></label>
      <label>Token <input bind:value={$setAmtToken} placeholder="0x... (0x0 = ETH)" /></label>
      <label>New amount (decimal) <input bind:value={$setAmtValue} placeholder="1500" /></label>
      <button on:click={vm.buildSetAmount}>Build</button>
    </div>
    <ProposeAction action={$setAmountAction} />
  </section>

  <section class="card-section">
    <h2>Propose: set max recipients</h2>
    <p class="muted">Raise or lower the recipient-slot cap (≤ ceiling, ≥ current count). Vote-gated.</p>
    <div class="form">
      <label>New max <input bind:value={$maxRecip} placeholder="500" style="min-width:120px" /></label>
      <button on:click={vm.buildSetMaxRecipients}>Build</button>
    </div>
    <ProposeAction action={$setMaxAction} />
  </section>

  <section class="card-section">
    <h2>Propose: force-pay a skipped period</h2>
    <p class="muted">
      Recovery for a month the crank skipped — pays every active recipient once. Only periods after
      the last paid month and before now (≤ 12 months back) qualify. Vote-gated.
    </p>
    <div class="form">
      <label>Year <input bind:value={$forceYear} placeholder="2027" style="min-width:90px" /></label>
      <label>Month <input bind:value={$forceMonth} placeholder="2" style="min-width:80px" /></label>
      <button on:click={vm.buildForcePay}>Build</button>
    </div>
    <ProposeAction action={$forceActions} />
  </section>
{/if}

<style>
  .form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .form label {
    display: flex;
    flex-direction: column;
    font-size: 0.85rem;
  }
  .form input {
    min-width: 240px;
  }
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0.5rem 0 1rem;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 150px;
    padding: 0.75rem 1rem;
    border: 1px solid #e2e6ef;
    border-radius: 8px;
    background: #fbfcfe;
  }
  .card-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: #5a6b8a;
    letter-spacing: 0.03em;
  }
  .card-value {
    font-size: 1.25rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
