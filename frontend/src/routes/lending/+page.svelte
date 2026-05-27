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
  import * as actions from "$lib/actions";
  import type {ProposalAction} from "$lib/actions";
  import ProposeAction from "$lib/components/ProposeAction.svelte";

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

  /** Banner tier from health factor. ∞ → "none" (no debt to show). */
  function healthTier(hf: ethers.BigNumber): "none" | "ok" | "warn" | "danger" {
    if (hf.gt(ethers.constants.MaxUint256.div(2))) return "none";
    // 1e18 fixed-point thresholds: ≥ 1.5 ok, ≥ 1.0 warn, < 1.0 danger.
    const ONE = ethers.BigNumber.from("1000000000000000000");
    const ONE_AND_HALF = ONE.mul(3).div(2);
    if (hf.gte(ONE_AND_HALF)) return "ok";
    if (hf.gte(ONE)) return "warn";
    return "danger";
  }

  function healthBlurb(tier: "none" | "ok" | "warn" | "danger"): string {
    switch (tier) {
      case "none":
        return "DAO has no outstanding AAVE debt — health factor is undefined.";
      case "ok":
        return "Healthy. Health factor ≥ 1.5 means the position has headroom against price moves.";
      case "warn":
        return "Caution: health factor < 1.5. A modest adverse price move could push the DAO toward liquidation. Avoid new borrows; consider repaying or supplying more collateral.";
      case "danger":
        return "Liquidatable: health factor < 1.0. The position can be liquidated right now. Repay or top up collateral immediately.";
    }
  }

  // --- Propose: supply / withdraw / borrow / repay ---
  type Op = "supply" | "withdraw" | "borrow" | "repay";
  let op: Op = "supply";
  let lAsset = "";
  let lAmount = "";
  let lDecimals = "6"; // USDC default; set 18 for WETH
  let lRateMode = "2"; // 2 = variable (borrow/repay only)
  // Governance-safe: previewX returns the underlying approve+pool-call batch
  // as ProposalAction[]. Multi-action proposals avoid the nested-dao.execute
  // reentrancy that blocked the plugin's wrapper functions under TokenVoting.
  let lendingAction: ProposalAction[] | null = null;

  async function buildLending(): Promise<void> {
    lendingAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig($wallet.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const amount = ethers.utils.parseUnits(lAmount || "0", parseInt(lDecimals, 10));
      const mode = parseInt(lRateMode, 10);
      lendingAction =
        op === "supply"
          ? await actions.previewAaveSupply(cfg, $wallet.provider, lAsset, amount)
          : op === "withdraw"
            ? await actions.previewAaveWithdraw(cfg, $wallet.provider, lAsset, amount)
            : op === "borrow"
              ? await actions.previewAaveBorrow(cfg, $wallet.provider, lAsset, amount, mode)
              : await actions.previewAaveRepay(cfg, $wallet.provider, lAsset, amount, mode);
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
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

      {@const tier = healthTier(data.account.healthFactor)}
      {#if tier !== "none"}
        <div class="hf-banner hf-{tier}">
          <strong>Health factor: {fmtHealth(data.account.healthFactor)}</strong>
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

    <h2>Propose: lending operation</h2>
    <p class="muted">
      Vote-gated. aTokens / debt are issued to the DAO. <code>rateMode</code> applies to
      borrow/repay (2 = variable). Amounts are fixed at proposal time.
    </p>
    <div class="form">
      <label>
        Operation
        <select bind:value={op}>
          <option value="supply">supply</option>
          <option value="withdraw">withdraw</option>
          <option value="borrow">borrow</option>
          <option value="repay">repay</option>
        </select>
      </label>
      <label>Asset <input bind:value={lAsset} placeholder="0x... (token)" /></label>
      <label>Amount <input bind:value={lAmount} placeholder="100" /></label>
      <label>Decimals <input bind:value={lDecimals} style="min-width:70px" /></label>
      {#if op === "borrow" || op === "repay"}
        <label>Rate mode <input bind:value={lRateMode} style="min-width:70px" /></label>
      {/if}
      <button on:click={buildLending}>Build</button>
    </div>
    <ProposeAction action={lendingAction} />
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
</style>
