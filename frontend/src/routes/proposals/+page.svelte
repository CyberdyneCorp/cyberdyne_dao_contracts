<!--
  Proposals View (MVVM). Thin: binds the proposals ViewModel — build an action,
  submit it as a TokenVoting proposal, list/vote/simulate/execute. Logic lives
  in $lib/viewmodels/proposals.ts.
-->
<script lang="ts">
  import {wallet} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {governanceConfigured, VoteOption} from "$lib/governance";
  import {createProposalsVM, voteLabel, tsLabel, needsArgB} from "$lib/viewmodels/proposals";

  const vm = createProposalsVM();
  const {kind, argA, argB, argC, built, submitMsg, submitting, proposals, loading, rowBusy, simResults} =
    vm;

  $: cfg = $wallet.status === "connected" ? chainConfig($wallet.chainId) : undefined;
  $: hasGov = cfg ? governanceConfigured(cfg) : false;

  // Auto-load the list once per connected account (keyed to avoid loops).
  let autoLoadedFor: string | undefined;
  $: {
    const key = $wallet.status === "connected" ? `${$wallet.chainId}:${$wallet.address}` : undefined;
    if (hasGov && key && key !== autoLoadedFor) {
      autoLoadedFor = key;
      vm.refresh();
    }
  }
</script>

<h1>Proposals</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect a wallet to build proposals and vote.</p>
{:else if !cfg?.dao}
  <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
{:else}
  {#if !hasGov}
    <p class="muted">
      No TokenVoting plugin configured for this DAO (5th address in <code>PUBLIC_DAO_*</code>). You
      can still build calldata below and paste it into an external proposal builder.
    </p>
  {/if}

  <h2>Build an action</h2>
  <div class="form">
    <label>
      Action
      <select bind:value={$kind}>
        <option value="raw">Raw call (any contract) — to, data, value</option>
        <option value="uniswap-setRouter">Uniswap.setUniversalRouter(address)</option>
        <option value="uniswap-setAllowedToken">UniswapV4.setAllowedToken(address, bool)</option>
        <option value="uniswap-setV4PositionManager">UniswapV4.setV4PositionManager(address)</option>
        <option value="uniswapV3-setPositionManager">UniswapV3.setPositionManager(address)</option>
        <option value="uniswapV3-setAllowedToken">UniswapV3.setAllowedToken(address, bool)</option>
        <option value="aave-setAdapter">AAVE.setAdapter(address)</option>
        <option value="aave-setAllowedAsset">AAVE.setAllowedAsset(address, bool)</option>
        <option value="payroll-removeRecipient">Payroll.removeRecipient(address)</option>
        <option value="payroll-setAmount">Payroll.setAmount(payee, newAmount)</option>
        <option value="payroll-setPayDayOfMonth">Payroll.setPayDayOfMonth(1..28)</option>
      </select>
    </label>
    <label>
      {$kind === "raw" ? "to (address)" : "Arg A"}
      <input bind:value={$argA} placeholder="address / number" />
    </label>
    {#if needsArgB.has($kind)}
      <label>
        {$kind === "raw" ? "data (0x…)" : "Arg B"}
        <input bind:value={$argB} placeholder={$kind === "raw" ? "0x…" : "value / true|false"} />
      </label>
    {/if}
    {#if $kind === "raw"}
      <label>value (wei) <input bind:value={$argC} placeholder="0" /></label>
    {/if}
    <button on:click={vm.build}>Build</button>
  </div>
  {#if $built}
    <pre>{JSON.stringify({to: $built.to, value: $built.value, data: $built.data}, null, 2)}</pre>
    <p class="muted">{$built.summary}</p>
    {#if hasGov}
      <button on:click={vm.submit} disabled={$submitting}>
        {$submitting ? "Submitting…" : "Submit as proposal"}
      </button>
    {/if}
    {#if $submitMsg}<p>{$submitMsg}</p>{/if}
  {/if}

  <h2>Open proposals</h2>
  {#if !hasGov}
    <p class="empty">Configure a TokenVoting address to list + vote.</p>
  {:else}
    <button on:click={vm.refresh} disabled={$loading}>{$loading ? "Loading…" : "Refresh"}</button>
    {#if $proposals.length === 0 && !$loading}
      <p class="empty">No proposals in the lookback window.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Summary</th><th>Window</th><th>Tally (Y/N/A)</th>
            <th>State</th><th>Your vote</th>
            <th title="Simulate the proposal's actions via dao.callStatic.execute(...)">Sim</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each $proposals as p (p.id)}
            {@const sim = $simResults[p.id]}
            <tr>
              <td>{p.id}</td>
              <td title={p.summary}>{p.summary.slice(0, 48)}{p.summary.length > 48 ? "…" : ""}<br /><span class="muted">{p.actions.length} action(s)</span></td>
              <td class="muted">{tsLabel(p.startDate)}<br />→ {tsLabel(p.endDate)}</td>
              <td>{p.tally ? `${p.tally.yes}/${p.tally.no}/${p.tally.abstain}` : "—"}</td>
              <td>
                {#if p.executed}<span class="ok">executed</span>
                {:else if p.canExecute}<span class="warn">passable</span>
                {:else if p.open === false}<span class="muted">closed</span>
                {:else}<span>open</span>{/if}
              </td>
              <td>{voteLabel(p.myVote)}</td>
              <td>
                {#if sim === undefined}
                  <button class="small" disabled={p.executed} on:click={() => vm.simulateRow(p)}>
                    Simulate
                  </button>
                {:else if sim === "loading"}
                  <span class="muted">…</span>
                {:else if sim.ok}
                  <span class="ok" title="dao.execute(actions) would succeed against current state">✓ ok</span>
                {:else}
                  <span class="error" title={sim.reason}>✗ {sim.reason.slice(0, 32)}{sim.reason.length > 32 ? "…" : ""}</span>
                {/if}
              </td>
              <td class="row-actions">
                {#if !p.executed}
                  <button disabled={$rowBusy[p.id]} on:click={() => vm.doVote(p.id, VoteOption.Yes)}>Yes</button>
                  <button disabled={$rowBusy[p.id]} on:click={() => vm.doVote(p.id, VoteOption.No)}>No</button>
                  <button disabled={$rowBusy[p.id]} on:click={() => vm.doVote(p.id, VoteOption.Abstain)}>Abstain</button>
                  {#if p.canExecute}
                    <button class="exec" disabled={$rowBusy[p.id]} on:click={() => vm.doExecute(p.id)}>Execute</button>
                  {/if}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
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
  pre {
    background: #f5f5f5;
    padding: 0.75rem;
    overflow-x: auto;
    font-size: 0.8rem;
  }
  .row-actions {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }
  .row-actions .exec {
    background: #1a7f37;
    color: #fff;
    border: none;
    border-radius: 3px;
  }
  .small {
    padding: 0.1rem 0.4rem;
    font-size: 0.8rem;
  }
  .ok {
    color: #1a7f37;
  }
  .warn {
    color: #8a4a00;
    font-weight: 600;
  }
  .error {
    color: #b00020;
  }
</style>
