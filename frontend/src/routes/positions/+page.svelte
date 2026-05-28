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
  import {
    formatPair,
    formatFeePct,
    formatCompact,
    formatRange,
    formatPairAmounts,
  } from "$lib/positionsFormat";

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
  <p class="muted">Connect a wallet to manage positions.</p>
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
    <h3 class="sub">Uniswap V3 ({$v3Positions?.length ?? 0})</h3>
    {#if $v3Positions && $v3Positions.length > 0}
      <table class="positions">
        <thead>
          <tr>
            <th>tokenId</th><th>pair</th><th>fee tier</th><th>price range</th><th>liquidity</th>
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
            <th>liquidity</th><th>hooks</th><th>actions</th>
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
</style>
