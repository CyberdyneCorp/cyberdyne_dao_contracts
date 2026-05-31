<!--
  Uniswap-style concentrated-liquidity range picker. Renders the pool's 30-day
  price line with a draggable shaded band; dragging the top/bottom handles (or
  editing the min/max boxes, or picking a strategy preset) sets the position's
  [tickLower, tickUpper]. Stateless: it reads the current range from props and
  emits a `change` event — the parent owns the tick state (the mint form's VM
  stores). All price↔tick conversion goes through $lib/uniswapMath, oriented to
  match the displayed quote (`invert`).
-->
<script lang="ts">
  import {createEventDispatcher} from "svelte";
  import {
    tickToRawPrice,
    rawPriceToTick,
    rawPriceToHuman,
    humanPriceToRaw,
    snapTick,
    FULL_LOWER,
    FULL_UPPER,
  } from "$lib/uniswapMath";
  import {TIMEFRAMES, formatPct, type Timeframe, type DepthBar} from "$lib/uniswapPoolStats";
  import {estimatePositionApr} from "$lib/poolStats";

  export let currentTick: number;
  export let tickSpacing: number;
  export let dec0: number;
  export let dec1: number;
  export let sym0: string;
  export let sym1: string;
  /** true → display price as token0 per token1 (the big-number orientation). */
  export let invert: boolean;
  /** Oriented price series per timeframe (already in display orientation). */
  export let series: Partial<Record<Timeframe, number[]>> = {};
  /** Fallback flat series when `series` isn't provided (oldest→newest). */
  export let prices: number[] = [];
  export let tickLower: number;
  export let tickUpper: number;
  export let full = false;
  // Estimated-APR inputs (optional — omitted → the APR readout is hidden).
  export let usd0: number | null = null;
  export let usd1: number | null = null;
  export let tvlUSD = 0;
  export let feesUSD24h: number | null = null;
  /** Per-tick active-liquidity bands for the depth histogram (optional). */
  export let bars: DepthBar[] = [];

  const dispatch = createEventDispatcher<{change: {tickLower: number; tickUpper: number; full: boolean}}>();

  const W = 600;
  const H = 220;

  // Selected timeframe. Default to the first one that actually has data (so we
  // don't open on an empty 1D when only daily history is present).
  let timeframe: Timeframe = "1M";
  $: hasSeries = Object.keys(series).length > 0;
  // Reactive per-timeframe point counts. Reference `series` directly here (not
  // via a helper) so Svelte tracks it and the buttons re-enable when data lands.
  $: counts = TIMEFRAMES.reduce(
    (m, tf) => ((m[tf] = series[tf]?.length ?? 0), m),
    {} as Record<Timeframe, number>
  );
  $: activePrices = hasSeries ? series[timeframe] ?? [] : prices;
  // Land on the first timeframe that has data (prefer 1M), once series arrive.
  let tfInit = false;
  $: if (hasSeries && !tfInit) {
    const found = (["1M", "1Y", "1W", "ALL", "1D"] as Timeframe[]).find((tf) => counts[tf] >= 2);
    if (found) {
      timeframe = found;
      tfInit = true;
    }
  }

  // --- price ⇆ tick (oriented) ---
  function priceOf(tick: number): number {
    const t1PerT0 = rawPriceToHuman(tickToRawPrice(tick), dec0, dec1);
    return invert ? (t1PerT0 > 0 ? 1 / t1PerT0 : Infinity) : t1PerT0;
  }
  function tickOf(price: number): number {
    const t1PerT0 = invert ? (price > 0 ? 1 / price : 0) : price;
    return rawPriceToTick(humanPriceToRaw(t1PerT0, dec0, dec1));
  }

  $: currentPrice = priceOf(currentTick);
  // Displayed band bounds = min/max of the two tick prices (orientation-agnostic).
  $: pA = priceOf(tickLower);
  $: pB = priceOf(tickUpper);
  $: minPrice = Math.min(pA, pB);
  $: maxPrice = Math.max(pA, pB);

  // --- y domain from the price history + current price, padded ---
  // Band bounds are folded in ONLY when they sit within a sane factor of the
  // current price; full-range / very-wide bounds are astronomically large or
  // tiny and would otherwise collapse the whole line onto one edge. Out-of-view
  // handles simply clamp to the top/bottom edge (same as Uniswap).
  $: data = activePrices.length ? activePrices : [currentPrice];
  $: yLo = (() => {
    let lo = Math.min(...data, currentPrice);
    if (isFinite(minPrice) && minPrice > currentPrice * 0.2) lo = Math.min(lo, minPrice);
    return lo;
  })();
  $: yHi = (() => {
    let hi = Math.max(...data, currentPrice);
    if (isFinite(maxPrice) && maxPrice < currentPrice * 5) hi = Math.max(hi, maxPrice);
    return hi;
  })();
  $: pad = Math.max((yHi - yLo) * 0.12, yHi * 0.02);
  $: domMin = Math.max(0, yLo - pad);
  $: domMax = yHi + pad;

  function yOf(price: number): number {
    if (!isFinite(price)) return price > 0 ? 0 : H;
    const t = (price - domMin) / (domMax - domMin || 1);
    return Math.max(0, Math.min(H, H - t * H));
  }
  function priceAtY(y: number): number {
    const t = 1 - Math.max(0, Math.min(H, y)) / H;
    return domMin + t * (domMax - domMin);
  }

  // price line path
  $: linePath = (() => {
    if (activePrices.length < 2) return "";
    const step = W / (activePrices.length - 1);
    return activePrices.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${yOf(p).toFixed(1)}`).join(" ");
  })();

  $: yTop = yOf(maxPrice); // top handle (higher price)
  $: yBot = yOf(minPrice); // bottom handle (lower price)
  $: curY = yOf(currentPrice);

  // Liquidity depth histogram: horizontal bars on the right, width ∝ active L,
  // y-aligned to the price axis. Bands inside the selected range are highlighted.
  const DEPTH_W = 190;
  $: depthRects = (() => {
    if (!bars.length) return [] as {y: number; h: number; w: number; sel: boolean}[];
    const mapped = bars
      .map((b) => {
        const yA = yOf(priceOf(b.lo));
        const yB = yOf(priceOf(b.hi));
        const yTopB = Math.max(0, Math.min(yA, yB));
        const yBotB = Math.min(H, Math.max(yA, yB));
        const mid = (b.lo + b.hi) / 2;
        return {yTopB, yBotB, liq: b.liq, sel: mid >= tickLower && mid < tickUpper};
      })
      .filter((r) => r.yBotB - r.yTopB > 0.3);
    const maxLiq = Math.max(...mapped.map((r) => r.liq), 1);
    return mapped.map((r) => ({
      y: r.yTopB,
      h: r.yBotB - r.yTopB,
      w: Math.max(1, (r.liq / maxLiq) * DEPTH_W),
      sel: r.sel,
    }));
  })();

  // --- mutations (all emit; parent owns state) ---
  function emit(lo: number, hi: number, isFull = false): void {
    let l = snapTick(Math.min(lo, hi), tickSpacing, "down");
    let h = snapTick(Math.max(lo, hi), tickSpacing, "up");
    if (h <= l) h = l + tickSpacing;
    dispatch("change", {tickLower: l, tickUpper: h, full: isFull});
  }
  function applyBandPrices(loP: number, hiP: number): void {
    emit(tickOf(loP), tickOf(hiP), false);
  }
  function setFull(): void {
    dispatch("change", {tickLower: FULL_LOWER, tickUpper: FULL_UPPER, full: true});
  }

  // --- dragging ---
  let svgEl: SVGSVGElement;
  let dragging: "top" | "bottom" | null = null;
  function localY(clientY: number): number {
    const r = svgEl.getBoundingClientRect();
    return ((clientY - r.top) / r.height) * H;
  }
  function onPointerDown(which: "top" | "bottom", e: PointerEvent): void {
    dragging = which;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const p = priceAtY(localY(e.clientY));
    if (p <= 0) return;
    if (dragging === "top") applyBandPrices(minPrice, p);
    else applyBandPrices(p, maxPrice);
  }
  function onPointerUp(): void {
    dragging = null;
  }

  // --- min/max boxes + steppers ---
  const spacingFactor = Math.pow(1.0001, tickSpacing); // one tick-spacing in price
  function nudge(bound: "min" | "max", dir: 1 | -1): void {
    const f = dir > 0 ? spacingFactor : 1 / spacingFactor;
    if (bound === "min") applyBandPrices(minPrice * f, maxPrice);
    else applyBandPrices(minPrice, maxPrice * f);
  }
  function commitBox(bound: "min" | "max", raw: string): void {
    const v = parseFloat(raw);
    if (!isFinite(v) || v <= 0) return;
    if (bound === "min") applyBandPrices(v, maxPrice);
    else applyBandPrices(minPrice, v);
  }

  // --- presets (orientation-agnostic, in display-price space) ---
  function preset(loPct: number | null, hiPct: number | null): void {
    if (loPct === null && hiPct === null) return setFull();
    const lo = loPct === null ? currentPrice : currentPrice * (1 + loPct / 100);
    const hi = hiPct === null ? currentPrice : currentPrice * (1 + hiPct / 100);
    applyBandPrices(lo, hi);
  }

  function fmt(n: number): string {
    if (!isFinite(n)) return n > 0 ? "∞" : "0";
    if (n === 0) return "0";
    if (n < 1) return n.toPrecision(5).replace(/0+$/, "").replace(/\.$/, "");
    return n.toLocaleString("en-US", {maximumFractionDigits: 4});
  }
  function dev(bound: number): string {
    if (!isFinite(bound) || currentPrice <= 0) return "";
    const pct = ((bound - currentPrice) / currentPrice) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }
  $: unit = invert ? `${sym0}/${sym1}` : `${sym1}/${sym0}`;

  // Live estimated APR — recomputes as the handles / timeframe move.
  $: apr =
    usd0 != null && usd1 != null && tvlUSD > 0 && feesUSD24h != null
      ? estimatePositionApr({
          currentTick, tickLower, tickUpper, dec0, dec1, usd0, usd1,
          tvlUSD, feesUSD24h, priceSeries: activePrices, minPrice, maxPrice,
        })
      : null;
</script>

<svelte:window on:pointermove={onPointerMove} on:pointerup={onPointerUp} />

<div class="prs">
  <div class="prs-head">
    <span>Current price <strong>{fmt(currentPrice)}</strong> {unit}</span>
    <button class="seg" class:on={full} on:click={setFull}>Full range</button>
  </div>

  <svg
    bind:this={svgEl}
    class="prs-chart"
    viewBox={`0 0 ${W} ${H}`}
    preserveAspectRatio="none"
    role="img"
    aria-label="Price range selector"
  >
    <!-- selected band -->
    <rect x="0" y={Math.min(yTop, yBot)} width={W} height={Math.abs(yBot - yTop)} class="band" />
    <!-- liquidity depth histogram (right side) -->
    {#each depthRects as r}
      <rect x={W - r.w} y={r.y} width={r.w} height={r.h} class={r.sel ? "depth sel" : "depth"} />
    {/each}
    <!-- price line -->
    {#if linePath}
      <path d={linePath} class="line" />
    {/if}
    <!-- current price -->
    <line x1="0" y1={curY} x2={W} y2={curY} class="cur" />
    <!-- handles (full-width grab lines + knobs on the right) -->
    <g class="handle" on:pointerdown={(e) => onPointerDown("top", e)}>
      <line x1="0" y1={yTop} x2={W} y2={yTop} class="hline" />
      <rect x={W - 14} y={yTop - 6} width="14" height="12" rx="3" class="knob" />
    </g>
    <g class="handle" on:pointerdown={(e) => onPointerDown("bottom", e)}>
      <line x1="0" y1={yBot} x2={W} y2={yBot} class="hline" />
      <rect x={W - 14} y={yBot - 6} width="14" height="12" rx="3" class="knob" />
    </g>
  </svg>
  {#if hasSeries}
    <div class="prs-tf">
      {#each TIMEFRAMES as tf}
        <button class="seg" class:on={timeframe === tf} disabled={counts[tf] < 2} on:click={() => (timeframe = tf)}>
          {tf === "ALL" ? "All" : tf}
        </button>
      {/each}
    </div>
  {/if}
  <div class="prs-cap muted small-sub">Drag the handles to set your range · price · Uniswap subgraph</div>

  {#if apr}
    <div class="prs-apr">
      <div class="apr-row">
        <span class="apr-val">{formatPct(apr.aprAdjustedPct)}</span>
        <span class="apr-lbl">est. APR <span class="muted">· fees × time-in-range</span></span>
        <span class="apr-eff">{apr.capitalEfficiency.toFixed(1)}× <span class="muted">vs full range</span></span>
      </div>
      <div class="muted small-sub">
        {formatPct(apr.aprInRangePct)} while in range · price stayed in range
        {(apr.timeInRange * 100).toFixed(0)}% of {timeframe === "ALL" ? "all time" : timeframe}
      </div>
      <div class="muted small-sub apr-cap">
        Estimate from recent fees; excludes impermanent loss &amp; gas. Not a guarantee.
      </div>
    </div>
  {/if}

  <div class="prs-presets">
    <span class="muted">Strategies:</span>
    <button class="chip-btn" on:click={() => preset(-2, 2)}>Stable ±2%</button>
    <button class="chip-btn" on:click={() => preset(-50, 100)}>Wide</button>
    <button class="chip-btn" on:click={() => preset(-50, 0)}>One-sided ↓</button>
    <button class="chip-btn" on:click={() => preset(0, 100)}>One-sided ↑</button>
  </div>

  <div class="prs-boxes">
    <div class="box">
      <div class="box-lbl">Min price <span class="muted">{dev(minPrice)}</span></div>
      <div class="box-row">
        <input value={fmt(minPrice)} on:change={(e) => commitBox("min", e.currentTarget.value)} disabled={full} />
        <button class="step" on:click={() => nudge("min", 1)} disabled={full} aria-label="increase min">+</button>
        <button class="step" on:click={() => nudge("min", -1)} disabled={full} aria-label="decrease min">−</button>
      </div>
      <div class="box-unit muted small-sub">{unit}</div>
    </div>
    <div class="box">
      <div class="box-lbl">Max price <span class="muted">{dev(maxPrice)}</span></div>
      <div class="box-row">
        <input value={fmt(maxPrice)} on:change={(e) => commitBox("max", e.currentTarget.value)} disabled={full} />
        <button class="step" on:click={() => nudge("max", 1)} disabled={full} aria-label="increase max">+</button>
        <button class="step" on:click={() => nudge("max", -1)} disabled={full} aria-label="decrease max">−</button>
      </div>
      <div class="box-unit muted small-sub">{unit}</div>
    </div>
  </div>
</div>

<style>
  .prs {
    border: 1px solid #e3e7f0;
    border-radius: 12px;
    padding: 0.75rem 0.85rem;
    margin: 0.5rem 0 1rem;
    background: #fff;
    max-width: 640px;
  }
  .prs-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85rem;
    margin-bottom: 0.5rem;
  }
  .prs-chart {
    display: block;
    width: 100%;
    height: 220px;
    background: #fafbfe;
    border-radius: 8px;
    touch-action: none;
  }
  .band {
    fill: rgba(37, 99, 235, 0.1);
  }
  .depth {
    fill: #c3cde0;
    opacity: 0.55;
  }
  .depth.sel {
    fill: #3b82f6;
    opacity: 0.45;
  }
  .line {
    fill: none;
    stroke: #94a3b8;
    stroke-width: 1.4;
  }
  .cur {
    stroke: #c026d3;
    stroke-width: 1;
    stroke-dasharray: 4 3;
  }
  .handle {
    cursor: ns-resize;
  }
  .hline {
    stroke: #2563eb;
    stroke-width: 1.5;
  }
  .knob {
    fill: #2563eb;
  }
  .prs-tf {
    display: inline-flex;
    margin-top: 0.5rem;
  }
  .prs-tf .seg {
    border-radius: 0;
    border-left: none;
  }
  .prs-tf .seg:first-child {
    border-left: 1px solid #d8deea;
    border-radius: 6px 0 0 6px;
  }
  .prs-tf .seg:last-child {
    border-radius: 0 6px 6px 0;
  }
  .prs-tf .seg:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .prs-cap {
    margin-top: 0.3rem;
  }
  .prs-apr {
    margin: 0.7rem 0;
    padding: 0.55rem 0.7rem;
    border: 1px solid #d8e2f3;
    border-radius: 10px;
    background: #f4f8ff;
  }
  .apr-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .apr-val {
    font-size: 1.25rem;
    font-weight: 700;
    color: #1d4ed8;
  }
  .apr-lbl {
    font-size: 0.82rem;
    color: #334;
  }
  .apr-eff {
    margin-left: auto;
    font-size: 0.85rem;
    font-weight: 600;
    color: #1a1a2e;
  }
  .apr-cap {
    margin-top: 0.2rem;
    font-style: italic;
  }
  .prs-presets {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin: 0.6rem 0;
    font-size: 0.8rem;
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
  .seg {
    padding: 0.08rem 0.6rem;
    font-size: 0.72rem;
    background: #fff;
    border: 1px solid #d8deea;
    border-radius: 6px;
    color: #666;
    cursor: pointer;
  }
  .seg.on {
    background: #eef1f8;
    color: #1a1a2e;
    font-weight: 600;
  }
  .prs-boxes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .box {
    border: 1px solid #e3e7f0;
    border-radius: 8px;
    padding: 0.5rem 0.6rem;
  }
  .box-lbl {
    font-size: 0.75rem;
    color: #555;
    margin-bottom: 0.25rem;
  }
  .box-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .box-row input {
    flex: 1;
    min-width: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .step {
    width: 28px;
    padding: 0.1rem 0;
    font-size: 0.9rem;
    border-radius: 6px;
  }
  .box-unit {
    margin-top: 0.2rem;
  }
</style>
