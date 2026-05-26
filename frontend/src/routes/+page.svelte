<!--
  DAO overview — treasury balances (ETH + tracked ERC20s), installed plugin
  addresses, ProtocolVersion.
  Reads via a single Promise.all per TRD §3a guidance.
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {erc20} from "$lib/contracts";

  // Tracked tokens to display per chain. Fall back gracefully on missing.
  const TRACKED_SYMBOLS = ["USDC", "WETH"] as const;

  async function load(chainId: number, daoAddr: string, provider: ethers.providers.Provider) {
    const cfg = chainConfig(chainId);
    if (!cfg) throw new Error(`Unsupported chain ${chainId}`);
    const ethBalance = await provider.getBalance(daoAddr);
    const tokens = await Promise.all(
      TRACKED_SYMBOLS.map(async (sym) => {
        const addr = cfg.external[sym];
        if (!addr) return null;
        const tok = erc20(addr, provider);
        const [bal, dec] = await Promise.all([tok.balanceOf(daoAddr), tok.decimals()]);
        return {symbol: sym, address: addr, balance: bal, decimals: dec};
      })
    );
    return {ethBalance, tokens: tokens.filter((t): t is NonNullable<typeof t> => t !== null), cfg};
  }
</script>

<h1>DAO overview</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect a wallet to load DAO state.</p>
{:else}
  {@const cfg = chainConfig($wallet.chainId)}
  {#if !cfg}
    <p class="empty">Unsupported chain id {$wallet.chainId}.</p>
  {:else if !cfg.dao}
    <p class="empty">
      No DAO configured for {cfg.name}. Set <code>PUBLIC_DAO_{cfg.name.toUpperCase()}</code>
      in <code>.env.local</code> (comma-separated: dao, payroll, uniswap, aave).
    </p>
  {:else}
    {#await load($wallet.chainId, cfg.dao.dao, $wallet.provider)}
      <p class="muted">Loading…</p>
    {:then data}
      <h2>Treasury</h2>
      <table>
        <tbody>
          <tr><th>ETH</th><td>{ethers.utils.formatEther(data.ethBalance)}</td></tr>
          {#each data.tokens as t}
            <tr>
              <th>{t.symbol}</th>
              <td>{ethers.utils.formatUnits(t.balance, t.decimals)}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      <h2>Plugin addresses</h2>
      <table>
        <tbody>
          <tr><th>DAO</th><td><code>{cfg.dao.dao}</code></td></tr>
          <tr><th>Payroll</th><td><code>{cfg.dao.payroll}</code></td></tr>
          <tr><th>Uniswap V4</th><td><code>{cfg.dao.uniswap}</code></td></tr>
          <tr><th>AAVE</th><td><code>{cfg.dao.aave}</code></td></tr>
        </tbody>
      </table>

      <h2>Framework</h2>
      <table>
        <tbody>
          <tr><th>DAOFactory</th><td><code>{cfg.osx.daoFactory}</code></td></tr>
          <tr><th>PluginRepoFactory</th><td><code>{cfg.osx.pluginRepoFactory}</code></td></tr>
          <tr><th>PluginSetupProcessor</th><td><code>{cfg.osx.pluginSetupProcessor}</code></td></tr>
        </tbody>
      </table>
    {:catch err}
      <p class="error">Failed: {err.message}</p>
    {/await}
  {/if}
{/if}
