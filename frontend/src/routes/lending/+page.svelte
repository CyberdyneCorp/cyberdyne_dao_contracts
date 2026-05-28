<!--
  Lending View (MVVM). Thin: binds the lending ViewModel. Logic + health-factor
  helpers live in $lib/viewmodels/lending.ts.
-->
<script lang="ts">
  import {wallet} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {
    createLendingVM,
    fmtHealth,
    healthTier,
    healthBlurb,
  } from "$lib/viewmodels/lending";
  import {formatUnits, formatToken} from "$lib/format";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import ProposeAction from "$lib/components/ProposeAction.svelte";
  import TokenSelect from "$lib/components/TokenSelect.svelte";

  const vm = createLendingVM();
  const {loading, loadError, noDao, data, op, lAsset, lAmount, lDecimals, lRateMode, lendingAction} =
    vm;

  $: cfg = $wallet.status === "connected" ? chainConfig($wallet.chainId) : undefined;

  // Default the asset to USDC once cfg is known (instead of "Custom… 0x…").
  let defaultsApplied = false;
  $: if (cfg && !defaultsApplied) {
    if (!$lAsset && cfg.external.USDC) $lAsset = cfg.external.USDC;
    defaultsApplied = true;
  }

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
  <h1>Lending</h1>
  <p class="hero-sub">
    Vote-gated AAVE v3 lending against the DAO's treasury. aTokens and debt
    tokens are issued to the DAO; the plugin holds no funds.
  </p>
</div>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect to load lending positions.</p>
{:else if $noDao}
  <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
{:else}
  {#if $loadError}
    <p class="empty">{$loadError}</p>
  {:else if $loading || !$data}
    <Skeleton rows={6} />
  {:else}
    {@const d = $data}
    <h2>Plugin state</h2>
    <table>
      <tbody>
        <tr><th>Adapter</th><td><code>{d.adapter}</code></td></tr>
        <tr><th>Allowlist enforced</th><td>{d.allowlistEnforced}</td></tr>
        <tr><th>Op nonce</th><td>{d.opNonce.toString()}</td></tr>
      </tbody>
    </table>

    {@const tier = healthTier(d.account.healthFactor)}
    {#if tier !== "none"}
      <div class="hf-banner hf-{tier}">
        <strong>Health factor: {fmtHealth(d.account.healthFactor)}</strong>
        <span>{healthBlurb(tier)}</span>
      </div>
    {:else}
      <div class="hf-banner hf-none">
        <strong>No debt.</strong>
        <span>{healthBlurb(tier)}</span>
      </div>
    {/if}

    <h2>Account summary</h2>
    <table>
      <tbody>
        <tr><th>Health factor</th><td><strong>{fmtHealth(d.account.healthFactor)}</strong></td></tr>
        <tr><th>Total collateral (USD)</th><td>{formatUnits(d.account.totalCollateralBase, 8)}</td></tr>
        <tr><th>Total debt (USD)</th><td>{formatUnits(d.account.totalDebtBase, 8)}</td></tr>
        <tr><th>Available borrows (USD)</th><td>{formatUnits(d.account.availableBorrowsBase, 8)}</td></tr>
        <tr><th>LTV</th><td>{(Number(d.account.ltv) / 100).toFixed(2)}%</td></tr>
      </tbody>
    </table>

    <h2>Positions</h2>
    {#if d.positions.length === 0}
      <p class="empty">No tracked assets configured for this chain.</p>
    {:else}
      <table>
        <thead>
          <tr><th>Asset</th><th>Supplied (aToken)</th><th>Variable debt</th></tr>
        </thead>
        <tbody>
          {#each d.positions as p}
            <tr>
              <td>{p.symbol}</td>
              <td>{formatToken(p.supplied, {symbol: p.symbol, decimals: p.decimals})}</td>
              <td>{formatToken(p.debt, {symbol: p.symbol, decimals: p.decimals})}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}

  <section class="card-section">
    <h2>Propose: lending operation</h2>
    <p class="muted">
      Vote-gated. aTokens / debt are issued to the DAO. <code>rateMode</code> applies to
      borrow / repay. Amounts are fixed at proposal time.
    </p>
    <div class="form">
      <label>
        Operation
        <select bind:value={$op}>
          <option value="supply">supply</option>
          <option value="withdraw">withdraw</option>
          <option value="borrow">borrow</option>
          <option value="repay">repay</option>
        </select>
      </label>
      <label>Asset <TokenSelect bind:value={$lAsset} {cfg} placeholder="0x… custom asset" /></label>
      <label>Amount <input bind:value={$lAmount} placeholder="100" /></label>
      {#if $op === "borrow" || $op === "repay"}
        <label>
          Rate mode
          <select bind:value={$lRateMode}>
            <option value="2">Variable</option>
            <option value="1">Stable</option>
          </select>
        </label>
      {/if}
      <button on:click={vm.buildLending}>Build</button>
    </div>
    <details class="adv">
      <summary class="muted">Advanced (custom-asset decimals override)</summary>
      <p class="muted small">
        Only needed when "Asset" is a Custom address the chain config doesn't track
        (USDC and WETH are auto-resolved).
      </p>
      <div class="form">
        <label>Decimals <input bind:value={$lDecimals} style="min-width:80px" placeholder="18" /></label>
      </div>
    </details>
    <ProposeAction action={$lendingAction} />
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
  .form input,
  .form select {
    min-width: 200px;
  }
  .hf-banner {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    border-radius: 4px;
    margin: 0.5rem 0 1rem;
    border: 1px solid;
  }
  .hf-banner strong {
    font-size: 1rem;
  }
  .hf-banner span {
    font-size: 0.85rem;
    opacity: 0.9;
  }
  .hf-ok {
    background: #e6f4ea;
    border-color: #34a853;
    color: #1e5e2c;
  }
  .hf-warn {
    background: #fff3cd;
    border-color: #f0a500;
    color: #8a4a00;
  }
  .hf-danger {
    background: #fde2e2;
    border-color: #b00020;
    color: #7a0014;
  }
  .hf-none {
    background: #f1f3f4;
    border-color: #c0c0c0;
    color: #555;
  }
  details.adv {
    margin: 0.5rem 0 0.75rem;
  }
  details.adv summary {
    cursor: pointer;
    font-size: 0.85rem;
  }
  .small {
    font-size: 0.8rem;
  }
</style>
