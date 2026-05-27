<!--
  Operating costs registry: paginated list of recurring cost entries, the
  permissionless processDue crank, and propose register/update/remove forms
  (vote-gated). Mirrors the payroll page's read + crank + propose layout.
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet, signer} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {costRegistryContract} from "$lib/contracts";
  import * as actions from "$lib/actions";
  import type {ProposalAction} from "$lib/actions";
  import ProposeAction from "$lib/components/ProposeAction.svelte";
  import {subgraphEnabled, fetchCostPayments, type CostPaymentRow} from "$lib/subgraph";

  // Payment history (subgraph-only — no cheap RPC equivalent without an
  // unbounded log scan). Loaded on demand by the "Load history" button.
  let payments: CostPaymentRow[] | null = null;
  let payErr: string | null = null;
  let payLoading = false;

  async function loadPayments(): Promise<void> {
    payErr = null;
    payLoading = true;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig($wallet.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");
      payments = await fetchCostPayments(cfg.dao.dao);
    } catch (err) {
      payErr = (err as Error).message;
    } finally {
      payLoading = false;
    }
  }

  const PAGE = 20;
  let offset = 0;

  type Row = {
    id: number;
    name: string;
    description: string;
    payee: string;
    costUsdc: ethers.BigNumber;
    frequencyDays: number;
    active: boolean;
    lastPaidAt: number;
    nextAt: number;
  };

  async function load(chainId: number, provider: ethers.providers.Provider, off: number) {
    const cfg = chainConfig(chainId);
    if (!cfg?.dao?.costRegistry) throw new Error("No CostRegistry plugin configured");
    const reg = costRegistryContract(cfg, provider);
    const [token, raw] = await Promise.all([reg.paymentToken(), reg.getEntries(off, PAGE)]);
    const page = raw[0];
    const total: ethers.BigNumber = raw[1];
    const rows: Row[] = page.map(
      (
        e: {
          payee: string;
          costUsdc: ethers.BigNumber;
          frequencyDays: number;
          lastPaidAt: ethers.BigNumber;
          active: boolean;
          name: string;
          description: string;
        },
        i: number
      ) => ({
        id: off + i,
        name: e.name,
        description: e.description,
        payee: e.payee,
        costUsdc: e.costUsdc,
        frequencyDays: e.frequencyDays,
        active: e.active,
        lastPaidAt: Number(e.lastPaidAt),
        nextAt: Number(e.lastPaidAt) + e.frequencyDays * 86_400,
      })
    );
    return {cfg, token, rows, total: total.toNumber()};
  }

  let crankBusy = false;
  let crankResult: string | null = null;
  let crankOffset = "0";
  let crankLimit = "100";

  async function runCrank(): Promise<void> {
    if ($wallet.status !== "connected" || !$signer) return;
    const cfg = chainConfig($wallet.chainId);
    if (!cfg?.dao?.costRegistry) return;
    crankBusy = true;
    crankResult = null;
    try {
      const tx = await costRegistryContract(cfg, $signer).processDue(
        ethers.BigNumber.from(crankOffset || "0"),
        ethers.BigNumber.from(crankLimit || "100")
      );
      crankResult = `Submitted: ${tx.hash}. Waiting…`;
      const receipt = await tx.wait();
      crankResult = `Confirmed in block ${receipt.blockNumber}.`;
    } catch (err) {
      crankResult = `Failed: ${(err as Error).message}`;
    } finally {
      crankBusy = false;
    }
  }

  // --- Propose: register / update / remove ---
  let rName = "";
  let rDesc = "";
  let rCost = "";
  let rFreq = "";
  let rPayee = "";
  let rId = ""; // blank → register; set → update
  let regAction: ProposalAction | null = null;

  function buildRegisterOrUpdate(): void {
    regAction = null;
    try {
      const cfg = chainConfig($wallet.status === "connected" ? $wallet.chainId : 1);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const cost = ethers.utils.parseUnits(rCost || "0", 6); // USDC 6dp
      const freq = parseInt(rFreq || "0", 10);
      regAction =
        rId.trim() === ""
          ? actions.costRegister(cfg, rName, rDesc, cost, freq, rPayee)
          : actions.costUpdate(cfg, parseInt(rId, 10), rName, rDesc, cost, freq, rPayee);
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  let removeId = "";
  let removeAction: ProposalAction | null = null;
  function buildRemove(): void {
    removeAction = null;
    try {
      const cfg = chainConfig($wallet.status === "connected" ? $wallet.chainId : 1);
      if (!cfg?.dao) throw new Error("No DAO configured");
      removeAction = actions.costRemove(cfg, parseInt(removeId, 10));
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  function fmtUsdc(v: ethers.BigNumber): string {
    return ethers.utils.formatUnits(v, 6);
  }
  function fmtTs(n: number): string {
    return n === 0 ? "—" : new Date(n * 1000).toISOString().slice(0, 10);
  }
  function due(r: Row): boolean {
    return r.active && Date.now() / 1000 >= r.nextAt;
  }
</script>

<h1>Operating costs</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect to load the cost registry.</p>
{:else}
  {@const cfg = chainConfig($wallet.chainId)}
  {#if !cfg?.dao}
    <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
  {:else if !cfg.dao.costRegistry}
    <p class="empty">
      No CostRegistry plugin configured (6th address in <code>PUBLIC_DAO_*</code>). You can
      still build proposal calldata below.
    </p>
  {:else}
    {#await load($wallet.chainId, $wallet.provider, offset)}
      <p class="muted">Loading…</p>
    {:then data}
      <p class="muted">
        Paid in <code>{data.token}</code> · {data.total} entr{data.total === 1 ? "y" : "ies"} total
      </p>
      {#if data.rows.length === 0}
        <p class="empty">No entries in this page.</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th>#</th><th>Name</th><th>Payee</th><th>Cost (USDC)</th>
              <th>Every</th><th>Next due</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each data.rows as r}
              <tr class={r.active ? "" : "inactive"}>
                <td>{r.id}</td>
                <td title={r.description}>{r.name}</td>
                <td><code>{r.payee.slice(0, 10)}…</code></td>
                <td>{fmtUsdc(r.costUsdc)}</td>
                <td>{r.frequencyDays}d</td>
                <td>{fmtTs(r.nextAt)}</td>
                <td>
                  {#if !r.active}<span class="muted">removed</span>
                  {:else if due(r)}<span class="warn">due</span>
                  {:else}<span class="ok">scheduled</span>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
      <div class="pager">
        <button disabled={offset === 0} on:click={() => (offset = Math.max(0, offset - PAGE))}>
          ← Prev
        </button>
        <span class="muted">rows {offset}–{offset + data.rows.length} of {data.total}</span>
        <button disabled={offset + PAGE >= data.total} on:click={() => (offset += PAGE)}>
          Next →
        </button>
      </div>
    {:catch err}
      <p class="error">Failed: {err.message}</p>
    {/await}

    <h2>Payment history</h2>
    {#if subgraphEnabled()}
      <button on:click={loadPayments} disabled={payLoading}>
        {payLoading ? "Loading…" : payments ? "Refresh" : "Load history"}
      </button>
      {#if payErr}<p class="error">{payErr}</p>{/if}
      {#if payments && payments.length > 0}
        <table>
          <thead>
            <tr><th>When</th><th>Entry</th><th>Payee</th><th>Amount</th><th>Tx</th></tr>
          </thead>
          <tbody>
            {#each payments as p}
              <tr>
                <td>{new Date(Number(p.paidAt) * 1000).toISOString().slice(0, 16).replace("T", " ")}</td>
                <td>#{p.entry.entryId} {p.entry.name}</td>
                <td><code>{p.payee.slice(0, 10)}…</code></td>
                <td>{p.amount}</td>
                <td><code>{p.txHash.slice(0, 10)}…</code></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else if payments}
        <p class="empty">No payments indexed yet.</p>
      {/if}
    {:else}
      <p class="muted">
        Set <code>PUBLIC_SUBGRAPH_URL</code> to see per-entry payment history
        (<code>CostPaid</code> events) here. Without a subgraph, only the live entry
        list above is available.
      </p>
    {/if}

    <h2>Crank (permissionless)</h2>
    <p class="muted">
      <code>processDue(offset, limit)</code> pays every due entry in the index window. Idempotent
      per entry — re-runs only pay entries that have since come due.
    </p>
    <div class="form">
      <label>offset <input bind:value={crankOffset} style="min-width:80px" /></label>
      <label>limit <input bind:value={crankLimit} style="min-width:80px" /></label>
      <button on:click={runCrank} disabled={crankBusy}>{crankBusy ? "Submitting…" : "processDue"}</button>
    </div>
    {#if crankResult}<p>{crankResult}</p>{/if}

    <h2>Propose: register / update entry</h2>
    <p class="muted">Leave "id" blank to register a new entry; set it to update an existing one.</p>
    <div class="form">
      <label>id (update only) <input bind:value={rId} placeholder="blank = new" style="min-width:110px" /></label>
      <label>name <input bind:value={rName} placeholder="AWS" /></label>
      <label>description <input bind:value={rDesc} placeholder="cloud bill" /></label>
      <label>cost (USDC) <input bind:value={rCost} placeholder="500" /></label>
      <label>frequency (days) <input bind:value={rFreq} placeholder="30" style="min-width:120px" /></label>
      <label>payee <input bind:value={rPayee} placeholder="0x..." /></label>
      <button on:click={buildRegisterOrUpdate}>Build</button>
    </div>
    <ProposeAction action={regAction} />

    <h2>Propose: remove entry</h2>
    <div class="form">
      <label>id <input bind:value={removeId} placeholder="0" style="min-width:90px" /></label>
      <button on:click={buildRemove}>Build</button>
    </div>
    <ProposeAction action={removeAction} />
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
  .form input {
    min-width: 200px;
  }
  .pager {
    display: flex;
    gap: 1rem;
    align-items: center;
    margin: 0.75rem 0;
  }
  tr.inactive {
    opacity: 0.5;
  }
  .error {
    color: #b00020;
  }
  .ok {
    color: #0a7;
  }
  .warn {
    color: #b67;
    font-weight: 600;
  }
</style>
