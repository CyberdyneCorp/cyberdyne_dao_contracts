<!-- Shimmer placeholder for loading states. `rows` stacked bars; `width` of the
     last row can be shortened for a more natural look. -->
<script lang="ts">
  export let rows = 3;
</script>

<div class="skeleton" aria-busy="true" aria-label="Loading">
  {#each Array(rows) as _, i}
    <div class="bar" style="width: {i === rows - 1 ? '60%' : '100%'}"></div>
  {/each}
</div>

<style>
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .bar {
    height: 1rem;
    border-radius: 4px;
    background: linear-gradient(90deg, #eee 25%, #f5f5f5 37%, #eee 63%);
    background-size: 400% 100%;
    animation: shimmer 1.4s ease infinite;
  }
  @keyframes shimmer {
    0% {
      background-position: 100% 0;
    }
    100% {
      background-position: 0 0;
    }
  }
</style>
