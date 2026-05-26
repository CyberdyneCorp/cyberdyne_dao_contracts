<!--
  Lending positions: aToken balances per known asset + variable/stable debt
  + health factor. Per docs/FRONTEND_INTEGRATION.md §2 we read direct from
  AAVE Pool, not the plugin (events alone don't carry live balances).
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {aaveContract, erc20} from "$lib/contracts";

  // Minimal AAVE v3 Pool surface — only the read methods we need.
  const POOL_ABI = [
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
    "function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress)",
  ];

  const TRACKED = ["USDC", "WETH"] as const;

  async function load(chainId: number, provider: ethers.providers.Provider) {
    const cfg = chainConfig(chainId);
    if (!cfg?.dao) throw new Error("No DAO configured");
    if (!cfg.external.AAVE_V3_POOL) throw new Error(`AAVE v3 not available on ${cfg.name}`);

    const aave = aaveContract(cfg, provider);
    const pool = new ethers.Contract(cfg.external.AAVE_V3_POOL, POOL_ABI, provider);
    const [adapter, allowlistEnforced, opNonce, accountData] = await Promise.all([
      aave.adapter(),
      aave.allowlistEnforced(),
      aave.opNonce(),
      pool.getUserAccountData(cfg.dao.dao),
    ]);

    const positions = await Promise.all(
      TRACKED.map(async (sym) => {
        const asset = cfg.external[sym];
        if (!asset) return null;
        const reserve = await pool.getReserveData(asset);
        const [aBal, vBal] = await Promise.all([
          erc20(reserve.aTokenAddress, provider).balanceOf(cfg.dao!.dao),
          erc20(reserve.variableDebtTokenAddress, provider).balanceOf(cfg.dao!.dao),
        ]);
        const dec = await erc20(asset, provider).decimals();
        return {symbol: sym, supplied: aBal, debt: vBal, decimals: dec};
      })
    );

    return {
      cfg,
      adapter,
      allowlistEnforced,
      opNonce,
      account: accountData,
      positions: positions.filter((p): p is NonNullable<typeof p> => p !== null),
    };
  }

  function fmtHealth(hf: ethers.BigNumber): string {
    // AAVE returns healthFactor with 1e18 precision; type(uint256).max → no debt.
    if (hf.gt(ethers.constants.MaxUint256.div(2))) return "∞ (no debt)";
    return (Number(hf.toString()) / 1e18).toFixed(3);
  }
</script>

<h1>Lending</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect to load lending positions.</p>
{:else}
  {@const cfg = chainConfig($wallet.chainId)}
  {#if !cfg?.dao}
    <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
  {:else}
    {#await load($wallet.chainId, $wallet.provider)}
      <p class="muted">Loading…</p>
    {:then data}
      <h2>Plugin state</h2>
      <table>
        <tbody>
          <tr><th>Adapter</th><td><code>{data.adapter}</code></td></tr>
          <tr><th>Allowlist enforced</th><td>{data.allowlistEnforced}</td></tr>
          <tr><th>Op nonce</th><td>{data.opNonce.toString()}</td></tr>
        </tbody>
      </table>

      <h2>Account summary</h2>
      <table>
        <tbody>
          <tr><th>Health factor</th><td><strong>{fmtHealth(data.account.healthFactor)}</strong></td></tr>
          <tr><th>Total collateral (USD, 8d)</th><td>{data.account.totalCollateralBase.toString()}</td></tr>
          <tr><th>Total debt (USD, 8d)</th><td>{data.account.totalDebtBase.toString()}</td></tr>
          <tr><th>Available borrows (USD, 8d)</th><td>{data.account.availableBorrowsBase.toString()}</td></tr>
          <tr><th>LTV</th><td>{(Number(data.account.ltv) / 100).toFixed(2)}%</td></tr>
        </tbody>
      </table>

      <h2>Positions</h2>
      {#if data.positions.length === 0}
        <p class="empty">No tracked assets configured for this chain.</p>
      {:else}
        <table>
          <thead>
            <tr><th>Asset</th><th>Supplied (aToken)</th><th>Variable debt</th></tr>
          </thead>
          <tbody>
            {#each data.positions as p}
              <tr>
                <td>{p.symbol}</td>
                <td>{ethers.utils.formatUnits(p.supplied, p.decimals)}</td>
                <td>{ethers.utils.formatUnits(p.debt, p.decimals)}</td>
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
