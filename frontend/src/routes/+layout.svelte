<script lang="ts">
  import Banner from "$lib/components/Banner.svelte";
  import WalletBar from "$lib/components/WalletBar.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
</script>

<Banner />
<WalletBar />
<Toasts />

<main>
  <slot />
</main>

<style>
  :global(body) {
    font-family: system-ui, sans-serif;
    margin: 0;
    color: #222;
  }
  :global(h1) {
    font-size: 1.4rem;
    margin: 1rem 0 0.5rem;
  }
  :global(h2) {
    font-size: 1.1rem;
    margin: 1rem 0 0.5rem;
    color: #444;
  }
  :global(table) {
    border-collapse: collapse;
    width: 100%;
  }
  :global(th),
  :global(td) {
    border-bottom: 1px solid #eee;
    padding: 0.5rem 0.75rem;
    text-align: left;
  }
  :global(th) {
    background: #fafafa;
    font-weight: 600;
  }
  :global(input),
  :global(textarea),
  :global(select),
  :global(button) {
    font: inherit;
    padding: 0.3rem 0.5rem;
  }
  :global(.muted) {
    color: #888;
  }
  :global(.empty) {
    color: #888;
    font-style: italic;
    padding: 1rem;
  }
  main {
    margin: 0 auto;
    max-width: 1100px;
    padding: 1rem;
  }
</style>
