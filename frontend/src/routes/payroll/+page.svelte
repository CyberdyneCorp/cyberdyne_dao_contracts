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
  import {getAbi} from "@cyberdyne/dao-contracts";

  async function load(chainId: number, provider: ethers.providers.Provider) {
    const cfg = chainConfig(chainId);
    if (!cfg?.dao) throw new Error("No DAO configured");
    const payroll = payrollContract(cfg, provider);
    const [recipients, payDay, lastPeriod] = await Promise.all([
      payroll.allActiveRecipients(),
      payroll.payDayOfMonth(),
      payroll.lastPayoutPeriod(),
    ]);
    return {cfg, recipients, payDay, lastPeriod};
  }

  let crankBusy = false;
  let crankResult: string | null = null;

  async function runCrank(): Promise<void> {
    if ($wallet.status !== "connected" || !$signer) return;
    const cfg = chainConfig($wallet.chainId);
    if (!cfg?.dao) return;
    crankBusy = true;
    crankResult = null;
    try {
      const tx = await payrollContract(cfg, $signer).executePayroll();
      crankResult = `Submitted: ${tx.hash}. Waiting…`;
      const receipt = await tx.wait();
      crankResult = `Confirmed in block ${receipt.blockNumber}.`;
    } catch (err) {
      crankResult = `Failed: ${(err as Error).message}`;
    } finally {
      crankBusy = false;
    }
  }

  // Add-recipient proposal builder.
  let newPayee = "";
  let newToken = ethers.constants.AddressZero; // 0x0 = ETH
  let newAmount = "";
  let actionCalldata: string | null = null;

  function buildAddRecipientAction(): void {
    actionCalldata = null;
    try {
      const cfg = chainConfig($wallet.status === "connected" ? $wallet.chainId : 1);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const iface = new ethers.utils.Interface(getAbi("PayrollPlugin"));
      const decimals = newToken === ethers.constants.AddressZero ? 18 : 6; // ETH=18, USDC=6 default; UI can refine
      const amount = ethers.utils.parseUnits(newAmount || "0", decimals);
      const data = iface.encodeFunctionData("addRecipient", [newPayee, newToken, amount]);
      actionCalldata = JSON.stringify(
        {to: cfg.dao.payroll, value: "0", data},
        null,
        2
      );
    } catch (err) {
      actionCalldata = `// error: ${(err as Error).message}`;
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
        Last paid period: <strong>{periodLabel(data.lastPeriod)}</strong>
      </p>

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
      <button on:click={runCrank} disabled={crankBusy}>
        {crankBusy ? "Submitting…" : "executePayroll()"}
      </button>
      {#if crankResult}
        <p>{crankResult}</p>
      {/if}
    {:catch err}
      <p class="error">Failed: {err.message}</p>
    {/await}

    <h2>Build "add recipient" action (proposal-only)</h2>
    <p class="muted">
      Paste the JSON into your proposal builder. Vote-gated; the DAO must execute it.
    </p>
    <div class="form">
      <label>Payee <input bind:value={newPayee} placeholder="0x..." /></label>
      <label>
        Token <input bind:value={newToken} placeholder="0x... (or 0x0 for ETH)" />
      </label>
      <label>Amount (decimal) <input bind:value={newAmount} placeholder="1000" /></label>
      <button on:click={buildAddRecipientAction}>Encode</button>
    </div>
    {#if actionCalldata}
      <pre>{actionCalldata}</pre>
    {/if}
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
  pre {
    background: #f5f5f5;
    padding: 0.75rem;
    overflow-x: auto;
    font-size: 0.8rem;
  }
  .error {
    color: #b00020;
  }
</style>
