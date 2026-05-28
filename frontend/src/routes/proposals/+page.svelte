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
  import {decodeCall, targetDisplay} from "$lib/decode";

  const vm = createProposalsVM();
  const {kind, argA, argB, argC, built, buildSim, submitMsg, submitting, proposals, loading, rowBusy, simResults} =
    vm;
  const {exAddress, exAbi, exLoading, exError, exPaste, exFn, exArgs, exValue} = vm;

  let showPaste = false;

  // Live human-readable decode of whatever the user has Built.
  $: decoded = $built ? decodeCall(cfg, $built.to, $built.data) : null;
  // The currently selected function's descriptor (for its input fields).
  $: selectedFn = $exAbi?.functions.find((f) => f.key === $exFn) ?? null;

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

  <h2>Call a contract function</h2>
  <p class="muted">
    Paste a contract address to load its ABI (bundled for this DAO's plugins/tokens, else fetched
    from <a href="https://sourcify.dev" target="_blank" rel="noreferrer">Sourcify</a>), pick a
    function, fill its parameters, and build the call.
  </p>
  <div class="form">
    <label>
      Contract address
      <input bind:value={$exAddress} placeholder="0x… contract" style="min-width:380px" />
    </label>
    <button on:click={vm.loadAbi} disabled={$exLoading}>{$exLoading ? "Loading…" : "Load ABI"}</button>
    <button class="ghost" on:click={() => (showPaste = !showPaste)}>
      {showPaste ? "Hide paste" : "Paste ABI"}
    </button>
  </div>
  {#if showPaste}
    <div class="paste">
      <textarea
        bind:value={$exPaste}
        rows="4"
        placeholder={'Full ABI JSON array, or one signature per line:\nfunction transfer(address to, uint256 amount)'}
      ></textarea>
      <button on:click={vm.applyPastedAbi}>Use pasted ABI</button>
    </div>
  {/if}
  {#if $exError}<p class="error">{$exError}</p>{/if}

  {#if $exAbi}
    <div class="abi">
      <p class="muted">
        ABI source: <span class="chip ok-chip">{$exAbi.source}</span>
        {#if $exAbi.label}<span class="chip">{$exAbi.label}</span>{/if}
        · {$exAbi.functions.length} function(s)
      </p>
      <div class="form">
        <label>
          Function
          <select value={$exFn} on:change={(e) => vm.selectExFn(e.currentTarget.value)}>
            {#each $exAbi.functions as f}
              <option value={f.key}>
                {f.name}({f.inputs.map((i) => i.type).join(",")}){f.stateMutability === "view" ||
                f.stateMutability === "pure"
                  ? " — read"
                  : f.payable
                    ? " — payable"
                    : ""}
              </option>
            {/each}
          </select>
        </label>
      </div>
      {#if selectedFn}
        <div class="args">
          {#each selectedFn.inputs as inp, i}
            <label>
              {inp.name} <span class="muted">({inp.type})</span>
              <input
                value={$exArgs[i] ?? ""}
                on:input={(e) => vm.setExArg(i, e.currentTarget.value)}
                placeholder={inp.type}
              />
            </label>
          {/each}
          {#if selectedFn.payable}
            <label>value (wei) <input bind:value={$exValue} placeholder="0" /></label>
          {/if}
        </div>
        <button on:click={vm.buildFromExplorer}>Build call</button>
      {/if}
    </div>
  {/if}

  {#if $built}
    <div class="built">
      <div class="built-summary">{$built.summary}</div>
      {#if decoded}
        <table class="decode">
          <tbody>
            <tr>
              <th>Target</th>
              <td>
                {#if decoded.targetLabel}
                  <span class="chip ok-chip">{decoded.targetLabel}</span>
                {:else}
                  <span class="chip warn-chip" title="Not one of this DAO's plugins or tracked tokens">unknown contract</span>
                {/if}
                <code>{$built.to}</code>
              </td>
            </tr>
            <tr>
              <th>Function</th>
              <td>
                {#if decoded.signature}<code>{decoded.signature}</code>
                {:else}<span class="warn">unrecognized selector {decoded.selector}</span>{/if}
              </td>
            </tr>
            {#if decoded.args}
              {#each decoded.args as a}
                <tr>
                  <th class="arg">{a.name} <span class="muted">({a.type})</span></th>
                  <td>
                    {#if a.label}<span class="chip ok-chip">{a.label}</span>{/if}
                    <code>{a.value}</code>
                  </td>
                </tr>
              {/each}
            {/if}
            {#if $built.value !== "0"}
              <tr><th>ETH value</th><td>{$built.value} wei</td></tr>
            {/if}
          </tbody>
        </table>
      {/if}
      <details class="raw">
        <summary class="muted">raw calldata</summary>
        <pre>{JSON.stringify({to: $built.to, value: $built.value, data: $built.data}, null, 2)}</pre>
      </details>
      <div class="build-actions">
        <button class="ghost" on:click={vm.simulateBuilt}>Simulate</button>
        {#if $buildSim === "loading"}
          <span class="muted">simulating…</span>
        {:else if $buildSim}
          {#if $buildSim.ok}
            <span class="ok">✓ would execute successfully</span>
          {:else}
            <span class="error" title={$buildSim.reason}>✗ {$buildSim.reason.slice(0, 60)}{$buildSim.reason.length > 60 ? "…" : ""}</span>
          {/if}
        {/if}
        {#if hasGov}
          <button class="primary" on:click={vm.submit} disabled={$submitting}>
            {$submitting ? "Submitting…" : "Submit as proposal"}
          </button>
        {/if}
      </div>
      {#if $submitMsg}<p class="submit-msg">{$submitMsg}</p>{/if}
    </div>
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
              <td title={p.summary}>
                {p.summary.slice(0, 48)}{p.summary.length > 48 ? "…" : ""}
                {#if p.actions.length}
                  <details class="row-decode">
                    <summary class="muted">{p.actions.length} action(s)</summary>
                    <ol>
                      {#each p.actions as a}
                        {@const dc = decodeCall(cfg, a.to, a.data)}
                        <li>
                          <span class="muted">{targetDisplay(dc)}</span>
                          {#if dc.signature}<code>{dc.fn}()</code>{:else}<span class="warn">raw {dc.selector}</span>{/if}
                        </li>
                      {/each}
                    </ol>
                  </details>
                {:else}
                  <br /><span class="muted">0 action(s)</span>
                {/if}
              </td>
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

  .built {
    border: 1px solid #e2e6ef;
    border-radius: 8px;
    padding: 0.85rem 1rem;
    margin: 0.5rem 0 1.25rem;
    background: #fbfcfe;
  }
  .built-summary {
    font-weight: 600;
    margin-bottom: 0.6rem;
  }
  table.decode {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 0.5rem;
  }
  table.decode th,
  table.decode td {
    text-align: left;
    vertical-align: top;
    padding: 0.28rem 0.6rem 0.28rem 0;
    font-size: 0.85rem;
    border: none;
  }
  table.decode th {
    color: #555;
    font-weight: 600;
    white-space: nowrap;
    width: 1%;
  }
  table.decode th.arg {
    padding-left: 1rem;
    font-weight: 500;
  }
  table.decode code {
    word-break: break-all;
  }
  .chip {
    display: inline-block;
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 600;
    margin-right: 0.35rem;
    white-space: nowrap;
  }
  .ok-chip {
    background: #e7f3ec;
    color: #1a7f37;
    border: 1px solid #b9e0c6;
  }
  .warn-chip {
    background: #fdf3e7;
    color: #8a4a00;
    border: 1px solid #f0d9b9;
  }
  .raw {
    margin-bottom: 0.5rem;
  }
  .raw summary {
    cursor: pointer;
    font-size: 0.8rem;
  }
  .build-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .build-actions .primary {
    background: #1a3f7f;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.3rem 0.8rem;
  }
  .build-actions .ghost {
    background: #fff;
    border: 1px solid #ccd3e0;
    border-radius: 4px;
    padding: 0.3rem 0.8rem;
    cursor: pointer;
  }
  .submit-msg {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
  }
  .row-decode summary {
    cursor: pointer;
  }
  .row-decode ol {
    margin: 0.3rem 0 0;
    padding-left: 1.1rem;
    font-size: 0.8rem;
  }
  .row-decode code {
    font-size: 0.78rem;
  }
  .paste {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    align-items: flex-start;
    margin: 0.25rem 0 0.5rem;
  }
  .paste textarea {
    width: 100%;
    max-width: 640px;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    padding: 0.5rem;
  }
  .abi {
    border: 1px solid #e2e6ef;
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin: 0.5rem 0 1rem;
    background: #fbfcfe;
  }
  .args {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .args label {
    display: flex;
    flex-direction: column;
    font-size: 0.85rem;
  }
  .args input {
    min-width: 240px;
  }
</style>
