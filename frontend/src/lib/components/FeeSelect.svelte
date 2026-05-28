<!--
  Pick a Uniswap fee tier. V3's four canonical tiers (100 / 500 / 3000 / 10000)
  each have a fixed tickSpacing (1 / 10 / 60 / 200). For V4 (`syncTickSpacing`
  bound), changing the fee also writes the matching spacing back up.
-->
<script lang="ts">
  export let value: string;
  /** When provided, this store of tickSpacing (as string) is kept in sync. */
  export let tickSpacing: string | undefined = undefined;

  const TIERS: Array<{fee: string; spacing: string; bps: string}> = [
    {fee: "100", spacing: "1", bps: "0.01% (1bp)"},
    {fee: "500", spacing: "10", bps: "0.05% (5bp)"},
    {fee: "3000", spacing: "60", bps: "0.30% (30bp)"},
    {fee: "10000", spacing: "200", bps: "1.00% (100bp)"},
  ];

  function onChange(e: Event): void {
    value = (e.target as HTMLSelectElement).value;
    const t = TIERS.find((x) => x.fee === value);
    if (t && tickSpacing !== undefined) tickSpacing = t.spacing;
  }
</script>

<select value={value} on:change={onChange}>
  {#each TIERS as t}
    <option value={t.fee}>{t.bps}</option>
  {/each}
</select>

<style>
  select {
    min-width: 130px;
  }
</style>
