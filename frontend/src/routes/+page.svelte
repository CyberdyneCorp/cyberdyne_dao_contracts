<!--
  DAO overview View (MVVM). Thin: binds the overview ViewModel. Treasury
  balances + plugin/framework addresses.
-->
<script lang="ts">
  import {wallet} from "$lib/wallet";
  import {createOverviewVM} from "$lib/viewmodels/overview";
  import {formatUnits} from "$lib/format";
  import Skeleton from "$lib/components/Skeleton.svelte";

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

<h1>DAO overview</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect a wallet to load DAO state.</p>
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
  <h2>Treasury</h2>
  <table>
    <tbody>
      <tr><th>ETH</th><td>{formatUnits(d.ethBalance, 18)} ETH</td></tr>
      {#each d.tokens as t}
        <tr><th>{t.symbol}</th><td>{formatUnits(t.balance, t.decimals)} {t.symbol}</td></tr>
      {/each}
    </tbody>
  </table>

  <h2>Plugin addresses</h2>
  <table>
    <tbody>
      <tr><th>DAO</th><td><code>{d.dao.dao}</code></td></tr>
      <tr><th>Payroll</th><td><code>{d.dao.payroll}</code></td></tr>
      <tr><th>Uniswap V4</th><td><code>{d.dao.uniswap}</code></td></tr>
      <tr><th>AAVE</th><td><code>{d.dao.aave}</code></td></tr>
    </tbody>
  </table>

  <h2>Framework</h2>
  <table>
    <tbody>
      <tr><th>DAOFactory</th><td><code>{d.cfg.osx.daoFactory}</code></td></tr>
      <tr><th>PluginRepoFactory</th><td><code>{d.cfg.osx.pluginRepoFactory}</code></td></tr>
      <tr><th>PluginSetupProcessor</th><td><code>{d.cfg.osx.pluginSetupProcessor}</code></td></tr>
    </tbody>
  </table>
{/if}
