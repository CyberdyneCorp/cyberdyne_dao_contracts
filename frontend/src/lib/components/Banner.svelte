<!--
  Banner — every screen MUST surface that this is NOT the production UI.
  Per TRD §3b: "Prominent banner: 'Dev / inspector tool — not the production UI'".
-->
<div class="banner">
  <span class="badge">DEV</span>
  <strong>Dev / inspector tool</strong> — not the production UI (see TRD §3a).
  Wallet writes go straight to chain. Use with care on mainnet.
</div>

<style>
  .banner {
    background: linear-gradient(180deg, #fff7e0 0%, #fff3cd 100%);
    border-bottom: 1px solid #ffe7a0;
    color: #6f4e00;
    font-size: 0.85rem;
    padding: 0.45rem 1rem;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.55rem;
  }
  .badge {
    display: inline-block;
    background: #d97757;
    color: #fff;
    border-radius: 4px;
    padding: 0.05rem 0.4rem;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
</style>
