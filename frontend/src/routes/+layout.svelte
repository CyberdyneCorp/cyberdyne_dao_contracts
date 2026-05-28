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
  :global(:root) {
    /* Palette — Cyberdyne navy + warm accent, light surfaces. */
    --color-bg: #f5f7fb;
    --color-surface: #ffffff;
    --color-surface-elev: #fbfcfe;
    --color-border: #e2e6ef;
    --color-border-strong: #ccd3e0;
    --color-text: #1a2540;
    --color-text-muted: #5a6b8a;
    --color-text-dim: #8390a8;
    --color-primary: #1a3f7f;
    --color-primary-hover: #15346b;
    --color-accent: #d97757;
    --color-success: #1a7f37;
    --color-success-bg: #e7f3ec;
    --color-warn: #8a4a00;
    --color-warn-bg: #fdf3e7;
    --color-error: #b00020;
    --color-error-bg: #fdeaea;

    /* Type scale. */
    --font-sans:
      "Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
      Arial, sans-serif;
    --font-mono:
      "Roboto Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono",
      monospace;

    /* Spacing + radius + shadow. */
    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --shadow-sm: 0 1px 2px rgba(26, 37, 64, 0.06);
    --shadow-md: 0 4px 12px rgba(26, 37, 64, 0.08);
  }

  :global(body) {
    font-family: var(--font-sans);
    margin: 0;
    color: var(--color-text);
    background: var(--color-bg);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  :global(h1) {
    font-size: 1.6rem;
    font-weight: 700;
    margin: 1.25rem 0 0.5rem;
    letter-spacing: -0.01em;
  }
  :global(h2) {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 1.5rem 0 0.5rem;
    color: var(--color-text);
    letter-spacing: -0.005em;
  }
  :global(h3) {
    font-size: 0.98rem;
    font-weight: 600;
    margin: 1rem 0 0.4rem;
    color: var(--color-text-muted);
  }
  :global(p) {
    line-height: 1.55;
  }
  :global(code) {
    font-family: var(--font-mono);
    font-size: 0.85em;
    background: #f2f4f9;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
  :global(table) {
    border-collapse: collapse;
    width: 100%;
    background: var(--color-surface);
    border-radius: var(--radius-md);
    overflow: hidden;
    box-shadow: var(--shadow-sm);
  }
  :global(th),
  :global(td) {
    border-bottom: 1px solid var(--color-border);
    padding: 0.6rem 0.85rem;
    text-align: left;
  }
  :global(tbody tr:last-child td) {
    border-bottom: none;
  }
  :global(tbody tr:hover) {
    background: var(--color-surface-elev);
  }
  :global(th) {
    background: #f6f8fc;
    font-weight: 600;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }
  :global(input),
  :global(textarea),
  :global(select) {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  :global(input:focus),
  :global(textarea:focus),
  :global(select:focus) {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px rgba(26, 63, 127, 0.12);
  }
  :global(button) {
    font: inherit;
    padding: 0.4rem 0.85rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  :global(button:hover:not(:disabled)) {
    background: var(--color-surface-elev);
    border-color: var(--color-primary);
  }
  :global(button:disabled) {
    opacity: 0.55;
    cursor: not-allowed;
  }
  :global(button.primary) {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #fff;
  }
  :global(button.primary:hover:not(:disabled)) {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
  }
  :global(button.ghost) {
    background: transparent;
    border-color: var(--color-border-strong);
  }
  :global(.muted) {
    color: var(--color-text-muted);
  }
  :global(.empty) {
    color: var(--color-text-dim);
    font-style: italic;
    padding: 1rem;
  }
  :global(.error) {
    color: var(--color-error);
  }
  :global(.warn) {
    color: var(--color-warn);
  }
  :global(.ok) {
    color: var(--color-success);
  }
  :global(a) {
    color: var(--color-primary);
    text-decoration: none;
  }
  :global(a:hover) {
    text-decoration: underline;
  }
  main {
    margin: 0 auto;
    max-width: 1160px;
    padding: 0.5rem 1.25rem 3rem;
  }
</style>
