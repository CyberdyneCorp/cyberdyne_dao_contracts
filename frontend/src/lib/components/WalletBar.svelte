<!--
  Wallet bar — connect, disconnect, switch chain.
-->
<script lang="ts">
  import {wallet, connectInjected, connectWalletConnect, disconnect, switchChain} from "$lib/wallet";
  import {supportedChainIds, chainConfig} from "$lib/chains";

  const chains = supportedChainIds().map((id) => ({
    id,
    name: chainConfig(id)?.name ?? `chain-${id}`,
  }));

  function short(addr: string): string {
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

  function handleChainChange(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    switchChain(parseInt(select.value));
  }

  function reset(): void {
    wallet.set({status: "disconnected"});
  }
</script>

<div class="bar">
  <div class="left">
    {#if $wallet.status === "connected"}
      <span>
        <strong>{short($wallet.address)}</strong>
        on <em>{chains.find((c) => c.id === $wallet.chainId)?.name ?? `chain-${$wallet.chainId}`}</em>
        ({$wallet.kind})
      </span>
      <select on:change={handleChainChange}>
        {#each chains as c}
          <option value={c.id} selected={c.id === $wallet.chainId}>{c.name}</option>
        {/each}
      </select>
      <button on:click={disconnect}>Disconnect</button>
    {:else if $wallet.status === "connecting"}
      <span>Connecting…</span>
    {:else if $wallet.status === "error"}
      <span class="error">Error: {$wallet.message}</span>
      <button on:click={reset}>Reset</button>
    {:else}
      <button on:click={connectInjected}>Connect injected</button>
      <button on:click={connectWalletConnect}>WalletConnect</button>
    {/if}
  </div>
  <nav class="right">
    <a href="/">Overview</a>
    <a href="/proposals">Proposals</a>
    <a href="/payroll">Payroll</a>
    <a href="/lending">Lending</a>
    <a href="/swaps">Swaps</a>
  </nav>
</div>

<style>
  .bar {
    align-items: center;
    border-bottom: 1px solid #ccc;
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    padding: 0.5rem 1rem;
  }
  .left,
  .right {
    align-items: center;
    display: flex;
    gap: 0.5rem;
  }
  .error {
    color: #b00020;
  }
  nav a {
    text-decoration: none;
  }
  nav a:hover {
    text-decoration: underline;
  }
</style>
