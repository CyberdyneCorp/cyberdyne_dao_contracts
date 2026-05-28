<!-- Friendly "connect a wallet" CTA shown when the wallet is disconnected.
     Larger and more inviting than a plain muted paragraph; renders the actual
     Connect button so users don't have to scroll up to the header. -->
<script lang="ts">
  import {connectInjected, connectWalletConnect} from "$lib/wallet";
  export let context = "load DAO state";
</script>

<div class="connect-prompt">
  <div class="logo" aria-hidden="true">◆</div>
  <div class="copy">
    <strong>Connect a wallet</strong>
    <span>to {context}.</span>
  </div>
  <div class="actions">
    <!-- The header WalletBar already has a "Connect injected" / "WalletConnect"
         pair; use entirely distinct labels here so test fixtures locating
         those buttons by substring-name keep matching only the header's. -->
    <button class="primary" on:click={connectInjected}>Connect browser wallet</button>
    <button on:click={connectWalletConnect}>Use WalletConnect bridge</button>
  </div>
</div>

<style>
  .connect-prompt {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    padding: 1.5rem 1.5rem;
    margin: 1rem 0 1.5rem;
    background: var(--color-surface);
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-lg);
    flex-wrap: wrap;
  }
  .logo {
    display: inline-flex;
    width: 2.4rem;
    height: 2.4rem;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, var(--color-primary) 0%, #2d5cb0 100%);
    color: #fff;
    border-radius: 8px;
    font-size: 1.3rem;
  }
  .copy {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1 1 auto;
    min-width: 200px;
  }
  .copy strong {
    font-size: 1.05rem;
  }
  .copy span {
    color: var(--color-text-muted);
    font-size: 0.92rem;
  }
  .actions {
    display: inline-flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
</style>
