<!--
  Wallet bar — brand mark, connect / disconnect, chain switcher, primary nav.
-->
<script lang="ts">
  import {page} from "$app/stores";
  import {wallet, connectInjected, connectWalletConnect, disconnect, switchChain} from "$lib/wallet";
  import {supportedChainIds, chainConfig} from "$lib/chains";

  const chains = supportedChainIds().map((id) => ({
    id,
    name: chainConfig(id)?.name ?? `chain-${id}`,
  }));

  const NAV = [
    {href: "/", label: "Overview"},
    {href: "/proposals", label: "Proposals"},
    {href: "/payroll", label: "Payroll"},
    {href: "/costs", label: "Costs"},
    {href: "/lending", label: "Lending"},
    {href: "/swaps", label: "Swaps"},
    {href: "/positions", label: "Positions"},
  ];

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

  $: currentPath = $page.url.pathname;
</script>

<header class="bar">
  <div class="brand-row">
    <a class="brand" href="/" aria-label="Cyberdyne DAO home">
      <span class="logo" aria-hidden="true">◆</span>
      <span class="brand-text">Cyberdyne <span class="brand-light">DAO</span></span>
    </a>
    <div class="wallet">
      {#if $wallet.status === "connected"}
        <span class="conn-pill">
          <span class="dot ok"></span>
          <strong>{short($wallet.address)}</strong>
          <span class="muted">·</span>
          <em title="MetaMask-reported chain id">
            {chains.find((c) => c.id === $wallet.chainId)?.name ?? `chain-${$wallet.chainId}`}
            <span class="chain-id">· id {$wallet.chainId}</span>
          </em>
          <span class="muted">·</span>
          <span class="kind">{$wallet.kind}</span>
        </span>
        <select on:change={handleChainChange} aria-label="Switch chain">
          {#each chains as c}
            <option value={c.id} selected={c.id === $wallet.chainId}>{c.name}</option>
          {/each}
        </select>
        <button on:click={disconnect}>Disconnect</button>
      {:else if $wallet.status === "connecting"}
        <span class="conn-pill">
          <span class="dot pending"></span>
          Connecting…
        </span>
      {:else if $wallet.status === "error"}
        <span class="conn-pill err">
          <span class="dot err"></span>
          Error: {$wallet.message}
        </span>
        <button on:click={reset}>Reset</button>
      {:else}
        <button class="primary" on:click={connectInjected}>Connect injected</button>
        <button on:click={connectWalletConnect}>WalletConnect</button>
      {/if}
    </div>
  </div>
  <nav class="nav" aria-label="Primary">
    {#each NAV as n}
      <a href={n.href} class:active={n.href === "/" ? currentPath === "/" : currentPath.startsWith(n.href)}>
        {n.label}
      </a>
    {/each}
  </nav>
</header>

<style>
  .bar {
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    box-shadow: var(--shadow-sm);
    padding: 0.6rem 1.25rem 0;
  }
  .brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--color-text);
    font-weight: 700;
    font-size: 1.05rem;
    text-decoration: none;
    letter-spacing: -0.01em;
  }
  .brand:hover {
    text-decoration: none;
    color: var(--color-primary);
  }
  .logo {
    display: inline-flex;
    width: 1.6rem;
    height: 1.6rem;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, var(--color-primary) 0%, #2d5cb0 100%);
    color: #fff;
    border-radius: 6px;
    font-size: 0.9rem;
    line-height: 1;
  }
  .brand-light {
    color: var(--color-text-muted);
    font-weight: 500;
  }
  .wallet {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .conn-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--color-success-bg);
    border: 1px solid #b9e0c6;
    border-radius: 999px;
    padding: 0.2rem 0.7rem;
    font-size: 0.85rem;
  }
  .conn-pill.err {
    background: var(--color-error-bg);
    border-color: #efb3b8;
  }
  .conn-pill em {
    font-style: normal;
    color: var(--color-text-muted);
  }
  .conn-pill .kind {
    color: var(--color-text-muted);
    font-size: 0.78rem;
  }
  .chain-id {
    color: var(--color-text-muted);
    font-size: 0.78rem;
    font-style: normal;
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--color-text-dim);
    display: inline-block;
  }
  .dot.ok {
    background: var(--color-success);
    box-shadow: 0 0 0 3px rgba(26, 127, 55, 0.15);
  }
  .dot.pending {
    background: var(--color-accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .dot.err {
    background: var(--color-error);
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .nav {
    display: flex;
    gap: 0.25rem;
    margin-top: 0.6rem;
    flex-wrap: wrap;
  }
  .nav a {
    color: var(--color-text-muted);
    text-decoration: none;
    padding: 0.5rem 0.85rem;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    font-size: 0.92rem;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    transition: color 120ms ease, border-color 120ms ease;
  }
  .nav a:hover {
    color: var(--color-text);
    text-decoration: none;
  }
  .nav a.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
    font-weight: 600;
  }
</style>
