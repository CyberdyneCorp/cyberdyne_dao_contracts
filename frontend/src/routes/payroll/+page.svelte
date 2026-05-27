<!--
  Payroll schedule: active recipients, amounts, pay day, last-paid period,
  + the permissionless crank button + an "add recipient" form that builds an
  Action[] payload to paste into a proposal.
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet, signer} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {payrollContract} from "$lib/contracts";
  import * as actions from "$lib/actions";
  import type {ProposalAction} from "$lib/actions";
  import ProposeAction from "$lib/components/ProposeAction.svelte";

  async function load(chainId: number, provider: ethers.providers.Provider) {
    const cfg = chainConfig(chainId);
    if (!cfg?.dao) throw new Error("No DAO configured");
    const payroll = payrollContract(cfg, provider);
    const [recipients, payDay, lastPeriod, cursor, cursorPeriod, perPage] = await Promise.all([
      payroll.allActiveRecipients(),
      payroll.payDayOfMonth(),
      payroll.lastPayoutPeriod(),
      payroll.payoutCursor(),
      payroll.cursorPeriod(),
      payroll.MAX_RECIPIENTS_PER_PAGE(),
    ]);
    return {cfg, recipients, payDay, lastPeriod, cursor, cursorPeriod, perPage};
  }

  let crankBusy = false;
  let crankResult: string | null = null;
  let pageSize = "100";

  // Run the crank. `full` → executePayroll() (one batch); else
  // executePayrollPage(pageSize) for large/paginated payrolls.
  async function runCrank(full: boolean): Promise<void> {
    if ($wallet.status !== "connected" || !$signer) return;
    const cfg = chainConfig($wallet.chainId);
    if (!cfg?.dao) return;
    crankBusy = true;
    crankResult = null;
    try {
      const payroll = payrollContract(cfg, $signer);
      const tx = full
        ? await payroll.executePayroll()
        : await payroll.executePayrollPage(ethers.BigNumber.from(pageSize || "100"));
      crankResult = `Submitted: ${tx.hash}. Waiting…`;
      const receipt = await tx.wait();
      crankResult = `Confirmed in block ${receipt.blockNumber}.`;
    } catch (err) {
      crankResult = `Failed: ${(err as Error).message}`;
    } finally {
      crankBusy = false;
    }
  }

  // --- Proposal builders (vote-gated) ---
  let newPayee = "";
  let newToken = ethers.constants.AddressZero; // 0x0 = ETH
  let newAmount = "";
  let addAction: ProposalAction | null = null;

  function buildAddRecipient(): void {
    addAction = null;
    try {
      const cfg = chainConfig($wallet.status === "connected" ? $wallet.chainId : 1);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const decimals = newToken === ethers.constants.AddressZero ? 18 : 6; // ETH=18, USDC=6 default
      const amount = ethers.utils.parseUnits(newAmount || "0", decimals);
      addAction = actions.payrollAddRecipient(cfg, newPayee, newToken, amount);
    } catch (err) {
      crankResult = null;
      addAction = null;
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  let setAmtPayee = "";
  let setAmtValue = "";
  let setAmtToken = ethers.constants.AddressZero;
  let setAmountAction: ProposalAction | null = null;

  function buildSetAmount(): void {
    setAmountAction = null;
    try {
      const cfg = chainConfig($wallet.status === "connected" ? $wallet.chainId : 1);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const decimals = setAmtToken === ethers.constants.AddressZero ? 18 : 6;
      const amount = ethers.utils.parseUnits(setAmtValue || "0", decimals);
      setAmountAction = actions.payrollSetAmount(cfg, setAmtPayee, amount);
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  function periodLabel(p: bigint | ethers.BigNumber): string {
    const n = Number(p);
    if (n === 0) return "—";
    const year = Math.floor(n / 12);
    const month = n - year * 12;
    return `${year}-${String(month).padStart(2, "0")}`;
  }
</script>

<h1>Payroll</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect to load payroll schedule.</p>
{:else}
  {@const cfg = chainConfig($wallet.chainId)}
  {#if !cfg?.dao}
    <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
  {:else}
    {#await load($wallet.chainId, $wallet.provider)}
      <p class="muted">Loading…</p>
    {:then data}
      <h2>Schedule</h2>
      <p>
        Pay day of month: <strong>{data.payDay}</strong> ·
        Last paid period: <strong>{periodLabel(data.lastPeriod)}</strong> ·
        Page size cap: <strong>{data.perPage.toString()}</strong>
      </p>
      {#if !data.cursor.isZero()}
        <p class="muted">
          Pagination in progress for period {periodLabel(data.cursorPeriod)} — resume at recipient
          index {data.cursor.toString()} via "Run page" below.
        </p>
      {/if}

      <h2>Active recipients ({data.recipients.length})</h2>
      {#if data.recipients.length === 0}
        <p class="empty">No active recipients.</p>
      {:else}
        <table>
          <thead>
            <tr><th>Payee</th><th>Token</th><th>Amount</th></tr>
          </thead>
          <tbody>
            {#each data.recipients as r}
              <tr>
                <td><code>{r.payee}</code></td>
                <td>{r.token === ethers.constants.AddressZero ? "ETH" : r.token.slice(0, 10) + "…"}</td>
                <td>{r.amount.toString()}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      <h2>Crank (permissionless)</h2>
      <p class="muted">
        <code>executePayroll()</code> pays the whole period in one batch (reverts if it
        exceeds {data.perPage.toString()} recipients). For larger payrolls run pages with
        <code>executePayrollPage(n)</code> until the period completes.
      </p>
      <div class="form">
        <button on:click={() => runCrank(true)} disabled={crankBusy}>
          {crankBusy ? "Submitting…" : "executePayroll()"}
        </button>
        <label>Page size <input bind:value={pageSize} placeholder="100" style="min-width:80px" /></label>
        <button on:click={() => runCrank(false)} disabled={crankBusy}>Run page</button>
      </div>
      {#if crankResult}
        <p>{crankResult}</p>
      {/if}
    {:catch err}
      <p class="error">Failed: {err.message}</p>
    {/await}

    <h2>Propose: add recipient</h2>
    <p class="muted">Vote-gated — builds an action the DAO executes after a vote passes.</p>
    <div class="form">
      <label>Payee <input bind:value={newPayee} placeholder="0x..." /></label>
      <label>Token <input bind:value={newToken} placeholder="0x... (or 0x0 for ETH)" /></label>
      <label>Amount (decimal) <input bind:value={newAmount} placeholder="1000" /></label>
      <button on:click={buildAddRecipient}>Build</button>
    </div>
    <ProposeAction action={addAction} />

    <h2>Propose: set recipient amount</h2>
    <div class="form">
      <label>Payee <input bind:value={setAmtPayee} placeholder="0x..." /></label>
      <label>Token <input bind:value={setAmtToken} placeholder="0x... (0x0 = ETH)" /></label>
      <label>New amount (decimal) <input bind:value={setAmtValue} placeholder="1500" /></label>
      <button on:click={buildSetAmount}>Build</button>
    </div>
    <ProposeAction action={setAmountAction} />
  {/if}
{/if}

<style>
  .form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .form label {
    display: flex;
    flex-direction: column;
    font-size: 0.85rem;
  }
  .form input {
    min-width: 240px;
  }
  .error {
    color: #b00020;
  }
</style>
