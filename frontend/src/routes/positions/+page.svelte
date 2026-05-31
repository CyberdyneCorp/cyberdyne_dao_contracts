<!--
  Uniswap V3 + V4 positions View (MVVM). Thin: binds the positions ViewModel.
  Logic + encoding lives in $lib/viewmodels/positions.ts.
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {createPositionsVM, FULL_LOWER, FULL_UPPER} from "$lib/viewmodels/positions";
  import {v4QuoteEnabled} from "$lib/v4Quote";
  import ProposeAction from "$lib/components/ProposeAction.svelte";
  import TokenSelect from "$lib/components/TokenSelect.svelte";
  import FeeSelect from "$lib/components/FeeSelect.svelte";
  import ConnectPrompt from "$lib/components/ConnectPrompt.svelte";
  import PriceRangeSelector from "$lib/components/PriceRangeSelector.svelte";
  import {
    formatPair,
    formatFeePct,
    formatCompact,
    formatRange,
    formatPairAmounts,
    shouldInvertPrice,
  } from "$lib/positionsFormat";
  import {resolveToken} from "$lib/format";
  import {
    buildPoolGroups,
    positionUnderlying,
    usdValue,
    formatUsd,
    formatAmt,
    spotPriceLabel,
    tokenUsdPrices,
  } from "$lib/poolStats";
  import {
    fetchUniswapPoolStats,
    uniswapStatsEnabled,
    formatUsdCompact,
    formatPct,
    sparklinePoints,
    orientedPrices,
    pctChange,
    fetchPriceHistory,
    orientedSeries,
    avgDailyFeesUSD,
    fetchPoolTicks,
    buildDepthBars,
    type UniswapPoolStats,
    type PriceHistory,
  } from "$lib/uniswapPoolStats";

  const vm = createPositionsVM();
  const {
    mToken0, mToken1, mFee, mAmt0, mAmt1, mFull, mLower, mUpper, mSlippagePct, mWrapEth,
    mintAction, mintQuote,
    opTokenId, iAmt0, iAmt1, iToken0, iToken1, incAction,
    decLiquidity, decAction, collectAction, burnAction,
    lookupId, lookup,
    v4PoolToken0, v4PoolToken1, v4PoolFee, v4PoolTickSpacing, v4PoolHooks,
    vmTickLower, vmTickUpper, vmAuto, vmAmt0Desired, vmAmt1Desired, vmSlippagePct,
    vmLiquidity, vmAmount0Max, vmAmount1Max,
    v4MintAction, v4MintQuote,
    viTokenId, viLiquidity, viAmount0Max, viAmount1Max, v4IncAction,
    vdTokenId, vdLiquidity, v4DecAction, v4CollectAction, v4BurnAction,
    v3Positions, v4Positions, listing, v3LiveFees, v3PoolStates, v4PoolStates, v4LookupId, v4Lookup,
  } = vm;
  const {v3PoolKey, v4PoolKeyStr} = vm;

  let v4PoolAdvOpen = false;

  $: cfg = $wallet.status === "connected" ? chainConfig($wallet.chainId) : undefined;

  // Uniswap-style per-pool roll-up of every DAO position, hydrated with the live
  // pool state ($v3PoolStates / $v4PoolStates) the VM loads alongside the lists.
  $: poolGroups = buildPoolGroups(cfg, $v3Positions ?? [], $v4Positions ?? [], $v3PoolStates, $v4PoolStates);
  $: daoTvlUsd = poolGroups.reduce((s, g) => s + (g.daoUsd ?? 0), 0);
  $: pricedAll = poolGroups.length > 0 && poolGroups.every((g) => g.daoUsd !== null);

  /** Human "1,234 USDC / 0.5 WETH" for a position's underlying token amounts. */
  function underlyingLabel(addr0: string, addr1: string, tick: number, tickLower: number, tickUpper: number, liquidity: any): string {
    const t0 = resolveToken(cfg, addr0);
    const t1 = resolveToken(cfg, addr1);
    const {amount0, amount1} = positionUnderlying(tick, tickLower, tickUpper, liquidity, t0.decimals, t1.decimals);
    return `${formatAmt(amount0)} ${t0.symbol} / ${formatAmt(amount1)} ${t1.symbol}`;
  }
  function underlyingUsd(addr0: string, addr1: string, tick: number, tickLower: number, tickUpper: number, liquidity: any, rawPrice: number): number | null {
    const t0 = resolveToken(cfg, addr0);
    const t1 = resolveToken(cfg, addr1);
    const {amount0, amount1} = positionUnderlying(tick, tickLower, tickUpper, liquidity, t0.decimals, t1.decimals);
    return usdValue(cfg, addr0, addr1, amount0, amount1, rawPrice);
  }

  // Whole-pool market stats (volume / fees / APR / 30d history) from Uniswap's
  // subgraph, keyed by V3 pool address / V4 poolId. Feature-flagged: when no
  // PUBLIC_UNISWAP_*_SUBGRAPH_URL is set the cards simply omit these. Fetch is
  // fired once per pool key (guarded by `uniRequested`) as groups hydrate, so
  // the reactive re-renders don't re-query.
  let uniStats: Record<string, UniswapPoolStats | null | "loading"> = {};
  let uniRequested = new Set<string>();
  // Per-card sparkline mode toggle (Uniswap-style Vol / Price switch).
  let chartMode: Record<string, "vol" | "price"> = {};
  function setChartMode(key: string, mode: "vol" | "price"): void {
    chartMode[key] = mode;
    chartMode = chartMode;
  }

  // --- Mint range chart (Uniswap-style draggable min/max picker) ---
  const FEE_TO_SPACING: Record<string, number> = {"100": 1, "500": 10, "3000": 60, "10000": 200};

  // V3 mint: the price history feeding the range chart is fetched once a quote
  // lands (the quote gives us the pool address + current tick).
  $: v3Quote = $mintQuote && typeof $mintQuote === "object" && !("error" in $mintQuote) ? $mintQuote : null;
  let v3MintHistory: PriceHistory | null = null;
  let v3MintStats: UniswapPoolStats | null = null;
  let v3MintTicks: {tickIdx: number; liquidityNet: string}[] | null = null;
  let v3MintFetchedFor = "";
  $: if (v3Quote?.poolAddress && uniswapStatsEnabled("v3") && v3MintFetchedFor !== v3Quote.poolAddress) {
    v3MintFetchedFor = v3Quote.poolAddress;
    fetchPriceHistory("v3", v3Quote.poolAddress).then((h) => (v3MintHistory = h));
    fetchUniswapPoolStats("v3", v3Quote.poolAddress).then((s) => (v3MintStats = s));
    fetchPoolTicks("v3", v3Quote.poolAddress, v3Quote.tick).then((t) => (v3MintTicks = t));
  }
  $: v3MintInvert = v3Quote ? shouldInvertPrice(cfg, $mToken0, $mToken1, v3Quote.tick) : false;
  $: v3MintSeries = orientedSeries(v3MintHistory, v3MintInvert);
  $: v3UsdPrices = v3Quote ? tokenUsdPrices(cfg, $mToken0, $mToken1, v3Quote.rawPriceToken1PerToken0) : null;
  $: v3MintBars = v3Quote ? buildDepthBars(v3MintTicks, v3Quote.tick, parseFloat(v3Quote.liquidity.toString())) : [];
  function onV3Range(e: CustomEvent<{tickLower: number; tickUpper: number; full: boolean}>): void {
    $mFull = e.detail.full;
    $mLower = String(e.detail.tickLower);
    $mUpper = String(e.detail.tickUpper);
  }

  // V4 mint: same, keyed by poolId via the V4 subgraph.
  $: v4Quote = $v4MintQuote && typeof $v4MintQuote === "object" && !("error" in $v4MintQuote) ? $v4MintQuote : null;
  let v4MintHistory: PriceHistory | null = null;
  let v4MintStats: UniswapPoolStats | null = null;
  let v4MintTicks: {tickIdx: number; liquidityNet: string}[] | null = null;
  let v4MintFetchedFor = "";
  $: if (v4Quote?.poolId && uniswapStatsEnabled("v4") && v4MintFetchedFor !== v4Quote.poolId) {
    v4MintFetchedFor = v4Quote.poolId;
    fetchPriceHistory("v4", v4Quote.poolId).then((h) => (v4MintHistory = h));
    fetchUniswapPoolStats("v4", v4Quote.poolId).then((s) => (v4MintStats = s));
    fetchPoolTicks("v4", v4Quote.poolId, v4Quote.tick).then((t) => (v4MintTicks = t));
  }
  // V4 pool tokens are sorted in the PoolKey; sort here too for correct orientation/decimals.
  $: v4Sorted =
    $v4PoolToken0 && $v4PoolToken1
      ? $v4PoolToken0.toLowerCase() < $v4PoolToken1.toLowerCase()
        ? {c0: $v4PoolToken0, c1: $v4PoolToken1}
        : {c0: $v4PoolToken1, c1: $v4PoolToken0}
      : {c0: $v4PoolToken0, c1: $v4PoolToken1};
  $: v4MintInvert = v4Quote ? shouldInvertPrice(cfg, v4Sorted.c0, v4Sorted.c1, v4Quote.tick) : false;
  $: v4MintSeries = orientedSeries(v4MintHistory, v4MintInvert);
  $: v4UsdPrices = v4Quote ? tokenUsdPrices(cfg, v4Sorted.c0, v4Sorted.c1, v4Quote.rawPriceToken1PerToken0) : null;
  $: v4MintBars = v4Quote ? buildDepthBars(v4MintTicks, v4Quote.tick, parseFloat(v4Quote.liquidity.toString())) : [];
  function onV4Range(e: CustomEvent<{tickLower: number; tickUpper: number; full: boolean}>): void {
    $vmTickLower = String(e.detail.tickLower);
    $vmTickUpper = String(e.detail.tickUpper);
  }
  $: hydrateUniStats(poolGroups);
  function hydrateUniStats(groups: typeof poolGroups): void {
    for (const g of groups) {
      if (uniRequested.has(g.key)) continue;
      if (!uniswapStatsEnabled(g.version)) continue;
      const ref = g.version === "v3" ? g.poolAddress : g.poolId;
      if (!ref) continue; // pool state not hydrated yet — retry on next tick
      uniRequested.add(g.key);
      uniStats[g.key] = "loading";
      uniStats = uniStats;
      fetchUniswapPoolStats(g.version, ref)
        .then((s) => {
          uniStats[g.key] = s;
          uniStats = uniStats;
        })
        .catch(() => {
          uniStats[g.key] = null;
          uniStats = uniStats;
        });
    }
  }

  // Sensible defaults once the chain config is known: pre-pick USDC/WETH in
  // every token slot that's still empty, so the user sees a ready-to-build
  // form instead of "Custom… 0x…" placeholders.
  let defaultsApplied = false;
  $: if (cfg && !defaultsApplied) {
    const u = cfg.external.USDC;
    const w = cfg.external.WETH;
    if (u && w) {
      if (!$mToken0) $mToken0 = u;
      if (!$mToken1) $mToken1 = w;
      if (!$iToken0) $iToken0 = u;
      if (!$iToken1) $iToken1 = w;
      if (!$v4PoolToken0) $v4PoolToken0 = u;
      if (!$v4PoolToken1) $v4PoolToken1 = w;
    }
    defaultsApplied = true;
  }
</script>

<div class="hero">
  <h1>Uniswap V3 + V4 positions</h1>
  <p class="hero-sub">
    Every LP NFT held by the DAO across Uniswap V3 (NonfungiblePositionManager)
    and V4 (PositionManager), plus vote-gated forms to mint / increase /
    decrease / collect / burn each position lifecycle.
  </p>
</div>

{#if $wallet.status !== "connected"}
  <ConnectPrompt context="manage DAO-owned Uniswap LP positions" />
{:else if !cfg?.dao}
  <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
{:else}
  <section class="card-section">
  <h2>DAO-owned positions</h2>
  <p class="muted">
    Read-only view of every LP NFT currently held by the DAO across both Uniswap V3 (NPM) and V4
    (PositionManager). Click <strong>Manage</strong> on any row to prefill the matching lifecycle
    form below.
  </p>
  <div class="actions">
    <button on:click={vm.loadPositions} disabled={$listing}>
      {$listing ? "Loading…" : $v3Positions || $v4Positions ? "Refresh" : "Load positions"}
    </button>
  </div>
  {#if $v3Positions !== null || $v4Positions !== null}
    {#if poolGroups.length > 0}
      <div class="pools-head">
        <h3 class="sub">Pools ({poolGroups.length})</h3>
        {#if pricedAll || daoTvlUsd > 0}
          <span class="tvl-badge" title="Sum of the DAO's position value across pools with a stablecoin leg">
            DAO TVL <strong>{formatUsd(daoTvlUsd)}</strong>{#if !pricedAll}<span class="muted small-sub"> (priced pools only)</span>{/if}
          </span>
        {/if}
      </div>
      <div class="pool-grid">
        {#each poolGroups as g}
          {@const t0 = resolveToken(cfg, g.token0)}
          {@const t1 = resolveToken(cfg, g.token1)}
          <div class="pool-card">
            <div class="pc-head">
              <span class="pc-pair">{t0.symbol} / {t1.symbol}</span>
              <span class="pill ver-pill">{g.version}</span>
              <span class="pill fee-pill">{formatFeePct(g.fee)}</span>
            </div>
            <div class="pc-price">
              {#if g.tick !== undefined}
                {spotPriceLabel(cfg, g.token0, g.token1, g.tick)}
              {:else}
                <span class="muted">price unavailable</span>
              {/if}
            </div>
            <dl class="pc-stats">
              {#if g.version === "v3" && g.reserve0 !== undefined && g.reserve1 !== undefined}
                <dt>Pool TVL</dt>
                <dd>
                  {#if g.poolTvlUsd != null}<strong>{formatUsd(g.poolTvlUsd)}</strong><br />{/if}
                  <span class="muted small-sub">{formatAmt(g.reserve0)} {t0.symbol} · {formatAmt(g.reserve1)} {t1.symbol}</span>
                </dd>
              {/if}
              <dt>DAO position{g.positionCount === 1 ? "" : "s"}</dt>
              <dd>{g.positionCount}</dd>
              <dt>DAO value</dt>
              <dd>
                {#if g.daoUsd != null}<strong>{formatUsd(g.daoUsd)}</strong><br />{/if}
                <span class="muted small-sub">{formatAmt(g.daoAmount0)} {t0.symbol} · {formatAmt(g.daoAmount1)} {t1.symbol}</span>
              </dd>
            </dl>
            {#if uniswapStatsEnabled(g.version)}
              {@const s = uniStats[g.key]}
              <div class="pc-market">
                {#if s === "loading" || s === undefined}
                  <span class="muted small-sub">loading market data…</span>
                {:else if s === null}
                  <span class="muted small-sub">not indexed on mainnet subgraph</span>
                {:else}
                  <div class="pc-metrics">
                    <div class="metric"><span class="m-val">{formatPct(s.aprPct)}</span><span class="m-lbl">APR</span></div>
                    <div class="metric"><span class="m-val">{formatUsdCompact(s.volume1dUSD)}</span><span class="m-lbl">1D vol</span></div>
                    <div class="metric"><span class="m-val">{formatUsdCompact(s.volume30dUSD)}</span><span class="m-lbl">30D vol</span></div>
                    <div class="metric"><span class="m-val">{formatUsdCompact(s.tvlUSD)}</span><span class="m-lbl">pool TVL</span></div>
                  </div>
                  {@const mode = chartMode[g.key] ?? "vol"}
                  {@const invert = shouldInvertPrice(cfg, g.token0, g.token1, g.tick ?? 0)}
                  {@const prices = orientedPrices(s.days, invert)}
                  <div class="spark-toggle">
                    <button class="seg" class:on={mode === "vol"} on:click={() => setChartMode(g.key, "vol")}>Volume</button>
                    <button class="seg" class:on={mode === "price"} on:click={() => setChartMode(g.key, "price")} disabled={prices.length < 2}>Price</button>
                  </div>
                  {#if mode === "price"}
                    {@const pts = sparklinePoints(prices)}
                    {#if pts}
                      {@const chg = pctChange(prices)}
                      <svg class="spark" viewBox="0 0 96 24" preserveAspectRatio="none" role="img" aria-label="30-day price">
                        <polyline points={pts} fill="none" stroke="#2563eb" stroke-width="1.4" />
                      </svg>
                      <span class="muted spark-cap">
                        30D price{#if chg != null} · <span class={chg >= 0 ? "ok" : "warn"}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</span>{/if} · Uniswap subgraph
                      </span>
                    {:else}
                      <span class="muted spark-cap">no price history</span>
                    {/if}
                  {:else}
                    {@const pts = sparklinePoints(s.days.map((d) => d.volumeUSD))}
                    {#if pts}
                      <svg class="spark" viewBox="0 0 96 24" preserveAspectRatio="none" role="img" aria-label="30-day volume">
                        <polyline points={pts} fill="none" stroke="#c026d3" stroke-width="1.4" />
                      </svg>
                      <span class="muted spark-cap">30D volume · Uniswap subgraph</span>
                    {/if}
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <h3 class="sub">Uniswap V3 ({$v3Positions?.length ?? 0})</h3>
    {#if $v3Positions && $v3Positions.length > 0}
      <table class="positions">
        <thead>
          <tr>
            <th>tokenId</th><th>pair</th><th>fee tier</th><th>price range</th><th>liquidity</th>
            <th title="token0/token1 the position's liquidity maps to at the current pool price">underlying</th>
            <th title="tokensOwed[0/1] from positions() — stale until next on-chain op">owed (stale)</th>
            <th title="Live pending fees via NPM.callStatic.collect">live fees</th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {#each $v3Positions as p}
            {@const live = $v3LiveFees[p.tokenId.toString()]}
            {@const pool = $v3PoolStates[v3PoolKey(p)]}
            {@const range = formatRange(p.tickLower, p.tickUpper, cfg, p.token0, p.token1, pool?.tick)}
            <tr>
              <td>{p.tokenId.toString()}</td>
              <td title={`${p.token0}\n${p.token1}`}>{formatPair(cfg, p.token0, p.token1)}</td>
              <td>{formatFeePct(p.fee)}</td>
              <td>
                <span class={range.isFull ? "muted" : ""}>{range.primary}</span>
                {#if range.status === "in"}
                  <span class="pill ok-pill" title="current pool tick is inside this range">in</span>
                {:else if range.status === "below"}
                  <span class="pill warn-pill" title="pool price is below this range">↓ out</span>
                {:else if range.status === "above"}
                  <span class="pill warn-pill" title="pool price is above this range">↑ out</span>
                {/if}
                <br />
                <span class="muted small-sub">{range.secondary}</span>
              </td>
              <td title={`raw L: ${p.liquidity.toString()}`}>{formatCompact(p.liquidity)}</td>
              <td>
                {#if pool}
                  {underlyingLabel(p.token0, p.token1, pool.tick, p.tickLower, p.tickUpper, p.liquidity)}
                  {@const usd = underlyingUsd(p.token0, p.token1, pool.tick, p.tickLower, p.tickUpper, p.liquidity, pool.rawPriceToken1PerToken0)}
                  {#if usd != null}<br /><span class="muted small-sub">{formatUsd(usd)}</span>{/if}
                {:else}
                  <span class="muted">—</span>
                {/if}
              </td>
              <td>{formatPairAmounts(cfg, p.tokensOwed0, p.tokensOwed1, p.token0, p.token1)}</td>
              <td>
                {#if live === undefined}
                  <button class="small" on:click={() => vm.simulateCollectFor(p.tokenId)}>Simulate</button>
                {:else if live === "loading"}
                  <span class="muted">…</span>
                {:else if "error" in live}
                  <span class="error" title={live.error}>err</span>
                {:else}
                  {formatPairAmounts(cfg, live.amount0, live.amount1, p.token0, p.token1)}
                {/if}
              </td>
              <td>
                <button class="small" on:click={() => vm.prefillV3Manage(p)}>Manage ↓</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if $v3Positions}
      <p class="empty">No V3 positions.</p>
    {/if}

    <h3 class="sub">Uniswap V4 ({$v4Positions?.length ?? 0})</h3>
    {#if $v4Positions && $v4Positions.length > 0}
      <table class="positions">
        <thead>
          <tr>
            <th>tokenId</th><th>pair</th><th>fee tier</th><th>price range</th>
            <th>liquidity</th>
            <th title="currency0/currency1 the position's liquidity maps to at the current pool price">underlying</th>
            <th>hooks</th><th>actions</th>
          </tr>
        </thead>
        <tbody>
          {#each $v4Positions as p}
            {@const pool = $v4PoolStates[v4PoolKeyStr(p)]}
            {@const range = formatRange(p.tickLower, p.tickUpper, cfg, p.poolKey.currency0, p.poolKey.currency1, pool?.tick)}
            <tr>
              <td>{p.tokenId.toString()}</td>
              <td title={`${p.poolKey.currency0}\n${p.poolKey.currency1}`}>
                {formatPair(cfg, p.poolKey.currency0, p.poolKey.currency1)}
              </td>
              <td>
                {formatFeePct(p.poolKey.fee)}
                <br /><span class="muted small-sub">spacing {p.poolKey.tickSpacing}</span>
              </td>
              <td>
                <span class={range.isFull ? "muted" : ""}>{range.primary}</span>
                {#if range.status === "in"}
                  <span class="pill ok-pill" title="current pool tick is inside this range">in</span>
                {:else if range.status === "below"}
                  <span class="pill warn-pill" title="pool price is below this range">↓ out</span>
                {:else if range.status === "above"}
                  <span class="pill warn-pill" title="pool price is above this range">↑ out</span>
                {/if}
                <br />
                <span class="muted small-sub">{range.secondary}</span>
              </td>
              <td title={`raw L: ${p.liquidity.toString()}`}>{formatCompact(p.liquidity)}</td>
              <td>
                {#if pool}
                  {underlyingLabel(p.poolKey.currency0, p.poolKey.currency1, pool.tick, p.tickLower, p.tickUpper, p.liquidity)}
                  {@const usd = underlyingUsd(p.poolKey.currency0, p.poolKey.currency1, pool.tick, p.tickLower, p.tickUpper, p.liquidity, pool.rawPriceToken1PerToken0)}
                  {#if usd != null}<br /><span class="muted small-sub">{formatUsd(usd)}</span>{/if}
                {:else}
                  <span class="muted">—</span>
                {/if}
              </td>
              <td>
                {#if p.poolKey.hooks === ethers.constants.AddressZero}
                  <span class="muted">none</span>
                {:else}<code title={p.poolKey.hooks}>{p.poolKey.hooks.slice(0, 10)}…</code>{/if}
              </td>
              <td><button class="small" on:click={() => vm.prefillV4Manage(p)}>Manage ↓</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if $v4Positions}
      <p class="empty">No V4 positions.</p>
    {/if}
  {/if}

  {#if !cfg.dao.uniswapV3}
    <p class="muted">No UniswapV3 plugin configured (7th address in <code>PUBLIC_DAO_*</code>).</p>
  {/if}

  <p class="muted note">
    Every operation is vote-gated; the position NFT is owned by the DAO and collected tokens return
    to the treasury. Tokens must be ERC20 (use WETH for ETH), ordered token0 &lt; token1.
  </p>
  </section>

  <section class="card-section">
  <h2>Propose: mint position (V3)</h2>
  <div data-form="v3-mint" class="form">
    <label>token0 <TokenSelect bind:value={$mToken0} {cfg} placeholder="0x… (lower addr)" /></label>
    <label>token1 <TokenSelect bind:value={$mToken1} {cfg} placeholder="0x… (higher addr)" /></label>
    <label>fee tier <FeeSelect bind:value={$mFee} /></label>
    <label>amount0 <input bind:value={$mAmt0} placeholder="1000" /></label>
    <label>amount1 <input bind:value={$mAmt1} placeholder="0.5" /></label>
    <label>slippage % <input bind:value={$mSlippagePct} placeholder="0.5" style="min-width:90px" /></label>
    <label class="chk"><input type="checkbox" bind:checked={$mFull} /> full range</label>
    {#if !$mFull}
      <label>tickLower <input bind:value={$mLower} style="min-width:90px" /></label>
      <label>tickUpper <input bind:value={$mUpper} style="min-width:90px" /></label>
    {/if}
    <label title="Optional: wrap this much native ETH → WETH atomically before the mint">
      wrap ETH <input bind:value={$mWrapEth} placeholder="0 (none)" style="min-width:90px" />
    </label>
    <button on:click={vm.quoteMint}>Quote pool</button>
    <button on:click={vm.buildMint}>Build</button>
  </div>
  <div class="presets">
    Range:
    <button class="chip-btn" on:click={() => vm.applyMintRangePreset(null)}>Full</button>
    <button class="chip-btn" on:click={() => vm.applyMintRangePreset(5)}>±5%</button>
    <button class="chip-btn" on:click={() => vm.applyMintRangePreset(10)}>±10%</button>
    <button class="chip-btn" on:click={() => vm.applyMintRangePreset(50)}>±50%</button>
    <span class="muted">(needs Quote pool first)</span>
  </div>
  {#if v3Quote}
    <PriceRangeSelector
      currentTick={v3Quote.tick}
      tickSpacing={FEE_TO_SPACING[$mFee] ?? 60}
      dec0={resolveToken(cfg, $mToken0).decimals}
      dec1={resolveToken(cfg, $mToken1).decimals}
      sym0={resolveToken(cfg, $mToken0).symbol}
      sym1={resolveToken(cfg, $mToken1).symbol}
      invert={v3MintInvert}
      series={v3MintSeries}
      bars={v3MintBars}
      usd0={v3UsdPrices?.usd0 ?? null}
      usd1={v3UsdPrices?.usd1 ?? null}
      tvlUSD={v3MintStats?.tvlUSD ?? 0}
      feesUSD24h={v3MintStats ? avgDailyFeesUSD(v3MintStats) : null}
      tickLower={$mFull ? FULL_LOWER : parseInt($mLower, 10) || FULL_LOWER}
      tickUpper={$mFull ? FULL_UPPER : parseInt($mUpper, 10) || FULL_UPPER}
      full={$mFull}
      on:change={onV3Range}
    />
  {/if}
  {#if $mintQuote !== null}
    {#if $mintQuote === "loading"}
      <p class="muted">Loading pool state…</p>
    {:else if "error" in $mintQuote}
      <p class="error">Quote failed: {$mintQuote.error}</p>
    {:else}
      {@const lo = $mFull ? FULL_LOWER : parseInt($mLower, 10)}
      {@const hi = $mFull ? FULL_UPPER : parseInt($mUpper, 10)}
      {@const inRange = $mintQuote.inRange(lo, hi)}
      <table class="quote">
        <tbody>
          <tr><th>pool</th><td><code>{$mintQuote.poolAddress}</code></td></tr>
          <tr><th>current tick</th><td>{$mintQuote.tick}</td></tr>
          <tr><th>raw price (token1 per token0)</th><td>{$mintQuote.rawPriceToken1PerToken0.toExponential(6)}</td></tr>
          <tr><th>pool liquidity</th><td>{$mintQuote.liquidity.toString()}</td></tr>
          <tr><th>your range</th><td>[{lo}, {hi}]</td></tr>
          <tr>
            <th>in range?</th>
            <td class={inRange ? "ok" : "warn"}>
              {#if inRange}
                ✓ current tick {$mintQuote.tick} is inside [{lo}, {hi}] — position will use BOTH tokens
              {:else if $mintQuote.tick < lo}
                ⚠ current tick {$mintQuote.tick} is BELOW {lo} — position uses ONLY token0 until price rises into range
              {:else}
                ⚠ current tick {$mintQuote.tick} is ABOVE {hi} — position uses ONLY token1 until price falls into range
              {/if}
            </td>
          </tr>
        </tbody>
      </table>
    {/if}
  {/if}
  <ProposeAction action={$mintAction} />

  </section>

  <section class="card-section">
  <h2>Manage an existing V3 position</h2>
  <p class="muted">Click <em>Manage ↓</em> on a row above to prefill these fields.</p>
  <div class="form">
    <label>tokenId <input bind:value={$opTokenId} placeholder="123" style="min-width:120px" /></label>
    <label>token0 <TokenSelect bind:value={$iToken0} {cfg} /></label>
    <label>token1 <TokenSelect bind:value={$iToken1} {cfg} /></label>
  </div>

  <h3>Increase liquidity</h3>
  <div class="form">
    <label>amount0 <input bind:value={$iAmt0} placeholder="100" /></label>
    <label>amount1 <input bind:value={$iAmt1} placeholder="0.05" /></label>
    <button on:click={vm.buildIncrease}>Build</button>
  </div>
  <ProposeAction action={$incAction} />

  <h3>Decrease liquidity</h3>
  <div class="form">
    <label>liquidity (raw units) <input bind:value={$decLiquidity} placeholder="from a lookup" /></label>
    <button on:click={vm.buildDecrease}>Build</button>
  </div>
  <ProposeAction action={$decAction} />

  <h3>Collect (to DAO)</h3>
  <div class="form">
    <button on:click={vm.buildCollect}>Build collect-max</button>
  </div>
  <ProposeAction action={$collectAction} />

  <h3>Burn (empty position)</h3>
  <div class="form">
    <button on:click={vm.buildBurn}>Build</button>
  </div>
  <ProposeAction action={$burnAction} />

  </section>

  <section class="card-section">
  <h2>Look up a V3 position</h2>
  <div class="form">
    <label>tokenId <input bind:value={$lookupId} placeholder="123" style="min-width:120px" /></label>
    <button on:click={vm.doLookup}>Read</button>
  </div>
  {#if $lookup}
    <table>
      <tbody>
        <tr><th>token0</th><td><code>{$lookup.token0}</code></td></tr>
        <tr><th>token1</th><td><code>{$lookup.token1}</code></td></tr>
        <tr><th>fee</th><td>{$lookup.fee}</td></tr>
        <tr><th>liquidity</th><td>{$lookup.liquidity}</td></tr>
        <tr><th>owed0 / owed1</th><td>{$lookup.owed0} / {$lookup.owed1}</td></tr>
      </tbody>
    </table>
  {/if}

  </section>

  <section class="card-section">
  <h2>Look up a V4 position</h2>
  <div class="form">
    <label>tokenId <input bind:value={$v4LookupId} placeholder="293418" style="min-width:120px" /></label>
    <button on:click={vm.doV4Lookup}>Read</button>
  </div>
  {#if $v4Lookup}
    <table>
      <tbody>
        <tr><th>tokenId</th><td>{$v4Lookup.tokenId.toString()}</td></tr>
        <tr><th>currency0</th><td><code>{$v4Lookup.poolKey.currency0}</code></td></tr>
        <tr><th>currency1</th><td><code>{$v4Lookup.poolKey.currency1}</code></td></tr>
        <tr><th>fee / tickSpacing</th><td>{$v4Lookup.poolKey.fee} / {$v4Lookup.poolKey.tickSpacing}</td></tr>
        <tr><th>hooks</th><td><code>{$v4Lookup.poolKey.hooks}</code></td></tr>
        <tr><th>tick range</th><td>[{$v4Lookup.tickLower}, {$v4Lookup.tickUpper}]</td></tr>
        <tr><th>liquidity</th><td>{$v4Lookup.liquidity.toString()}</td></tr>
        <tr><th>hasSubscriber</th><td>{$v4Lookup.hasSubscriber ? "yes" : "no"}</td></tr>
      </tbody>
    </table>
  {/if}

  </section>

  <section class="card-section">
  <h2>Uniswap V4 LP</h2>
  <p class="muted">
    Vote-gated full lifecycle on the v4-periphery PositionManager. The DAO is the owner
    (MINT_POSITION) and the recipient (TAKE_PAIR). The frontend encodes the v4 action stream from
    the typed fields below — no raw hex paste required.
  </p>

  <h3>Pool key</h3>
  <p class="muted">Tokens are auto-sorted so <code>currency0 &lt; currency1</code>.</p>
  <div data-form="v4-pool" class="form">
    <label>token A <TokenSelect bind:value={$v4PoolToken0} {cfg} placeholder="0x… (USDC)" /></label>
    <label>token B <TokenSelect bind:value={$v4PoolToken1} {cfg} placeholder="0x… (WETH)" /></label>
    <label>fee tier <FeeSelect bind:value={$v4PoolFee} bind:tickSpacing={$v4PoolTickSpacing} /></label>
  </div>
  <details bind:open={v4PoolAdvOpen} class="adv">
    <summary>Advanced (tickSpacing + hooks)</summary>
    <div class="form">
      <label>tickSpacing <input bind:value={$v4PoolTickSpacing} style="min-width:80px" /></label>
      <label>hooks <input bind:value={$v4PoolHooks} placeholder="0x0…0" /></label>
    </div>
  </details>

  <h3>Propose: mint position</h3>
  <div data-form="v4-mint" class="form">
    <label>tickLower <input bind:value={$vmTickLower} style="min-width:90px" /></label>
    <label>tickUpper <input bind:value={$vmTickUpper} style="min-width:90px" /></label>
    <label class="chk">
      <input type="checkbox" bind:checked={$vmAuto} /> auto-derive liquidity from amounts
    </label>
    {#if $vmAuto}
      <label>amount0 desired <input bind:value={$vmAmt0Desired} placeholder="2000" /></label>
      <label>amount1 desired <input bind:value={$vmAmt1Desired} placeholder="1" /></label>
      <label>slippage % <input bind:value={$vmSlippagePct} placeholder="0.5" style="min-width:90px" /></label>
    {/if}
    {#if v4QuoteEnabled(cfg)}
      <button on:click={vm.quoteV4Mint}>Quote pool</button>
    {/if}
    <button on:click={vm.buildV4Mint}>Build</button>
  </div>
  {#if !$vmAuto}
    <details open class="adv">
      <summary>Raw L + maxes</summary>
      <div class="form">
        <label>liquidity (L) <input bind:value={$vmLiquidity} placeholder="10000000000000" /></label>
        <label>amount0Max <input bind:value={$vmAmount0Max} placeholder="2000" /></label>
        <label>amount1Max <input bind:value={$vmAmount1Max} placeholder="1" /></label>
      </div>
    </details>
  {/if}
  <div class="presets">
    Range:
    <button class="chip-btn" on:click={() => vm.applyV4MintRangePreset(null)}>Full</button>
    <button class="chip-btn" on:click={() => vm.applyV4MintRangePreset(5)}>±5%</button>
    <button class="chip-btn" on:click={() => vm.applyV4MintRangePreset(10)}>±10%</button>
    <button class="chip-btn" on:click={() => vm.applyV4MintRangePreset(50)}>±50%</button>
    <span class="muted">(needs Quote pool first)</span>
  </div>
  {#if v4Quote}
    <PriceRangeSelector
      currentTick={v4Quote.tick}
      tickSpacing={parseInt($v4PoolTickSpacing, 10) || 60}
      dec0={resolveToken(cfg, v4Sorted.c0).decimals}
      dec1={resolveToken(cfg, v4Sorted.c1).decimals}
      sym0={resolveToken(cfg, v4Sorted.c0).symbol}
      sym1={resolveToken(cfg, v4Sorted.c1).symbol}
      invert={v4MintInvert}
      series={v4MintSeries}
      bars={v4MintBars}
      usd0={v4UsdPrices?.usd0 ?? null}
      usd1={v4UsdPrices?.usd1 ?? null}
      tvlUSD={v4MintStats?.tvlUSD ?? 0}
      feesUSD24h={v4MintStats ? avgDailyFeesUSD(v4MintStats) : null}
      tickLower={parseInt($vmTickLower, 10) || FULL_LOWER}
      tickUpper={parseInt($vmTickUpper, 10) || FULL_UPPER}
      full={(parseInt($vmTickLower, 10) || 0) <= FULL_LOWER + 1 && (parseInt($vmTickUpper, 10) || 0) >= FULL_UPPER - 1}
      on:change={onV4Range}
    />
  {/if}
  {#if $v4MintQuote !== null}
    {#if $v4MintQuote === "loading"}
      <p class="muted">Reading pool state…</p>
    {:else if "error" in $v4MintQuote}
      <p class="error">Quote failed: {$v4MintQuote.error}</p>
    {:else}
      {@const lo = parseInt($vmTickLower, 10)}
      {@const hi = parseInt($vmTickUpper, 10)}
      {@const inRange = $v4MintQuote.inRange(lo, hi)}
      <table>
        <tbody>
          <tr><th>pool id</th><td><code>{$v4MintQuote.poolId}</code></td></tr>
          <tr><th>current tick</th><td>{$v4MintQuote.tick}</td></tr>
          <tr><th>raw price (token1 per token0)</th><td>{$v4MintQuote.rawPriceToken1PerToken0.toExponential(6)}</td></tr>
          <tr><th>pool liquidity</th><td>{$v4MintQuote.liquidity.toString()}</td></tr>
          <tr>
            <th>range</th>
            <td>
              {#if inRange}
                ✓ current tick {$v4MintQuote.tick} is inside [{lo}, {hi}] — position will use BOTH tokens
              {:else if $v4MintQuote.tick < lo}
                ⚠ current tick {$v4MintQuote.tick} is BELOW {lo} — position uses ONLY token0 until price rises into range
              {:else}
                ⚠ current tick {$v4MintQuote.tick} is ABOVE {hi} — position uses ONLY token1 until price falls into range
              {/if}
            </td>
          </tr>
        </tbody>
      </table>
    {/if}
  {/if}
  <ProposeAction action={$v4MintAction} />

  <h3>Propose: increase liquidity</h3>
  <div class="form">
    <label>tokenId <input bind:value={$viTokenId} style="min-width:120px" /></label>
    <label>liquidity (Δ) <input bind:value={$viLiquidity} placeholder="1000000000000" /></label>
    <label>amount0Max <input bind:value={$viAmount0Max} placeholder="200" /></label>
    <label>amount1Max <input bind:value={$viAmount1Max} placeholder="0.1" /></label>
    <button on:click={vm.buildV4Increase}>Build</button>
  </div>
  <ProposeAction action={$v4IncAction} />

  <h3>Propose: decrease / collect / burn (by tokenId)</h3>
  <div class="form">
    <label>tokenId <input bind:value={$vdTokenId} style="min-width:120px" /></label>
    <label>liquidity to remove <input bind:value={$vdLiquidity} placeholder="1000000000000" /></label>
    <button on:click={vm.buildV4Decrease}>Build decrease</button>
    <button on:click={vm.buildV4Collect}>Build collect-fees</button>
    <button on:click={vm.buildV4Burn}>Build burn</button>
  </div>
  <ProposeAction action={$v4DecAction} />
  <ProposeAction action={$v4CollectAction} />
  <ProposeAction action={$v4BurnAction} />
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
  .form label.chk {
    flex-direction: row;
    align-items: center;
    gap: 0.3rem;
  }
  .form input {
    min-width: 150px;
  }
  h3 {
    font-size: 1rem;
    margin: 0.75rem 0 0.25rem;
    color: #555;
  }
  button.small {
    padding: 0.1rem 0.4rem;
    font-size: 0.8rem;
  }
  table.quote {
    margin: 0.5rem 0;
    font-size: 0.9rem;
  }
  table.quote th {
    text-align: left;
    padding-right: 1rem;
    font-weight: 500;
    color: #555;
  }
  .ok {
    color: #1e5e2c;
  }
  .warn {
    color: #8a4a00;
  }
  .presets {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    color: #555;
  }
  .chip-btn {
    background: #fff;
    border: 1px solid #ccd3e0;
    border-radius: 999px;
    padding: 0.1rem 0.6rem;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .chip-btn:hover {
    background: #f3f5fa;
  }
  details.adv {
    margin: 0 0 0.75rem;
  }
  details.adv summary {
    cursor: pointer;
    font-size: 0.85rem;
    color: #555;
    margin-bottom: 0.3rem;
  }
  .small-sub {
    font-size: 0.72rem;
    letter-spacing: 0.01em;
  }
  table.positions td,
  table.positions th {
    vertical-align: top;
  }
  .pill {
    display: inline-block;
    border-radius: 999px;
    padding: 0.02rem 0.4rem;
    font-size: 0.7rem;
    font-weight: 600;
    margin-left: 0.4rem;
    vertical-align: middle;
  }
  .ok-pill {
    background: #e7f3ec;
    color: #1a7f37;
    border: 1px solid #b9e0c6;
  }
  .warn-pill {
    background: #fdf3e7;
    color: #8a4a00;
    border: 1px solid #f0d9b9;
  }
  .pools-head {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .tvl-badge {
    font-size: 0.85rem;
    color: #555;
  }
  .tvl-badge strong {
    color: #1a1a2e;
  }
  .pool-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.75rem;
    margin: 0.5rem 0 1rem;
  }
  .pool-card {
    border: 1px solid #e3e7f0;
    border-radius: 12px;
    padding: 0.75rem 0.85rem;
    background: #fff;
  }
  .pc-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .pc-pair {
    font-weight: 600;
    font-size: 0.95rem;
  }
  .ver-pill {
    background: #eef1f8;
    color: #444;
    border: 1px solid #d8deea;
    margin-left: auto;
  }
  .fee-pill {
    background: #f3f5fa;
    color: #555;
    border: 1px solid #d8deea;
    margin-left: 0;
  }
  .pc-price {
    font-size: 0.82rem;
    color: #333;
    margin: 0.35rem 0 0.5rem;
  }
  .pc-stats {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.6rem;
    margin: 0;
    font-size: 0.8rem;
  }
  .pc-stats dt {
    color: #777;
  }
  .pc-stats dd {
    margin: 0;
    text-align: right;
  }
  .pc-market {
    margin-top: 0.6rem;
    padding-top: 0.55rem;
    border-top: 1px solid #eef1f8;
  }
  .pc-metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.3rem;
    text-align: center;
  }
  .metric {
    display: flex;
    flex-direction: column;
  }
  .m-val {
    font-size: 0.82rem;
    font-weight: 600;
    color: #1a1a2e;
  }
  .m-lbl {
    font-size: 0.66rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .spark {
    display: block;
    width: 100%;
    height: 26px;
    margin-top: 0.45rem;
  }
  .spark-cap {
    font-size: 0.66rem;
  }
  .spark-toggle {
    display: flex;
    gap: 0;
    margin-top: 0.5rem;
  }
  .seg {
    padding: 0.08rem 0.5rem;
    font-size: 0.68rem;
    background: #fff;
    border: 1px solid #d8deea;
    color: #666;
    cursor: pointer;
  }
  .seg:first-child {
    border-radius: 6px 0 0 6px;
  }
  .seg:last-child {
    border-radius: 0 6px 6px 0;
    border-left: none;
  }
  .seg.on {
    background: #eef1f8;
    color: #1a1a2e;
    font-weight: 600;
  }
  .seg:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
