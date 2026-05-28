<!-- Fixed-position toast stack. Mounted once in the layout; reads the toasts
     store. Each toast is dismissable; errors stay until dismissed. -->
<script lang="ts">
  import {toasts} from "$lib/stores/toasts";
</script>

<div class="toasts" role="region" aria-label="Notifications">
  {#each $toasts as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === "error" ? "alert" : "status"}>
      <span class="msg">{t.message}</span>
      <button class="x" aria-label="Dismiss" on:click={() => toasts.dismiss(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: min(440px, 92vw);
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
    font-size: 0.9rem;
    line-height: 1.3;
    border: 1px solid;
  }
  .toast.error {
    background: #fdecec;
    border-color: #f3b4b4;
    color: #8a1f1f;
  }
  .toast.success {
    background: #eafaef;
    border-color: #a9e2bd;
    color: #1d6b38;
  }
  .toast.info {
    background: #eef3fc;
    border-color: #b8cdf0;
    color: #244a86;
  }
  .msg {
    flex: 1;
    word-break: break-word;
  }
  .x {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    color: inherit;
    padding: 0;
    opacity: 0.7;
  }
  .x:hover {
    opacity: 1;
  }
</style>
