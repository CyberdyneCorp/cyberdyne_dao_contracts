<!--
  DAO overview View (MVVM). Thin: binds the overview ViewModel. Treasury
  balances + plugin/framework addresses.
-->
<script lang="ts">
  import {wallet} from "$lib/wallet";
  import {createOverviewVM} from "$lib/viewmodels/overview";
  import {formatUnits} from "$lib/format";
  import Skeleton from "$lib/components/Skeleton.svelte";
  import AddressTag from "$lib/components/AddressTag.svelte";
  import ConnectPrompt from "$lib/components/ConnectPrompt.svelte";

  const vm = createOverviewVM();
  const {loading, loadError, unsupported, noDao, data} = vm;

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
  <h1>DAO overview</h1>
  <p class="hero-sub">
    Live treasury balances and the on-chain addresses of every plugin + OSx
    framework contract this DAO is wired to.
  </p>
</div>

{#if $wallet.status !== "connected"}
  <ConnectPrompt context="load treasury balances and plugin addresses" />
{:else if $unsupported}
  <p class="empty">Unsupported chain id {$wallet.chainId}.</p>
{:else if $noDao}
  <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
{:else if $loadError}
  <p class="empty">{$loadError}</p>
{:else if $loading || !$data}
  <Skeleton rows={6} />
{:else}
  {@const d = $data}
  {@const allZero =
    d.ethBalance.isZero() && d.tokens.every((t) => t.balance.isZero())}
  {#if allZero}
    <p class="net-hint">
      ⚠ Every treasury balance reads zero. Most likely your wallet is connected
      to <strong>real Ethereum Mainnet</strong>, not the local anvil fork —
      the DAO contract <code>{d.dao.dao}</code> only exists on the fork. In
      MetaMask, switch the active network to a custom one with RPC
      <code>http://127.0.0.1:8545</code> and chain id <code>31337</code>,
      then reload.
    </p>
  {/if}
  <section class="card-section">
    <h2>Treasury</h2>
    <div class="cards">
      <div class="card">
        <span class="card-label">ETH</span>
        <span class="card-value">{formatUnits(d.ethBalance, 18)}</span>
      </div>
      {#each d.tokens as t}
        <div class="card">
          <span class="card-label">{t.symbol}</span>
          <span class="card-value">{formatUnits(t.balance, t.decimals)}</span>
        </div>
      {/each}
    </div>
  </section>

  <section class="card-section">
    <h2>Plugin addresses</h2>
    <div class="addr-list">
      <div class="addr-row"><span class="addr-key">DAO</span><AddressTag address={d.dao.dao} /></div>
      <div class="addr-row"><span class="addr-key">Payroll</span><AddressTag address={d.dao.payroll} /></div>
      <div class="addr-row"><span class="addr-key">Uniswap V4</span><AddressTag address={d.dao.uniswap} /></div>
      <div class="addr-row"><span class="addr-key">AAVE</span><AddressTag address={d.dao.aave} /></div>
      {#if d.dao.uniswapV3}
        <div class="addr-row"><span class="addr-key">Uniswap V3</span><AddressTag address={d.dao.uniswapV3} /></div>
      {/if}
      {#if d.dao.costRegistry}
        <div class="addr-row"><span class="addr-key">CostRegistry</span><AddressTag address={d.dao.costRegistry} /></div>
      {/if}
      {#if d.dao.governance}
        <div class="addr-row"><span class="addr-key">TokenVoting</span><AddressTag address={d.dao.governance} /></div>
      {/if}
    </div>
  </section>

  <section class="card-section">
    <h2>Framework</h2>
    <div class="addr-list">
      <div class="addr-row"><span class="addr-key">DAOFactory</span><AddressTag address={d.cfg.osx.daoFactory} /></div>
      <div class="addr-row"><span class="addr-key">PluginRepoFactory</span><AddressTag address={d.cfg.osx.pluginRepoFactory} /></div>
      <div class="addr-row"><span class="addr-key">PluginSetupProcessor</span><AddressTag address={d.cfg.osx.pluginSetupProcessor} /></div>
    </div>
  </section>
{/if}

<style>
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
    min-width: 140px;
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
    font-size: 1.35rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .addr-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.5rem 0 1rem;
  }
  .addr-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .addr-key {
    min-width: 170px;
    font-weight: 600;
    color: #555;
    font-size: 0.85rem;
  }
  .net-hint {
    background: var(--color-warn-bg);
    border: 1px solid #f0d9b9;
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    color: var(--color-warn);
    font-size: 0.9rem;
    line-height: 1.5;
    margin: 0.5rem 0 1rem;
  }
  .net-hint code {
    background: rgba(0, 0, 0, 0.05);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
</style>
