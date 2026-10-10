<script lang="ts">
  import { onMount } from 'svelte';

  let { mountTravel }: { mountTravel: (host: HTMLElement) => () => void } = $props();
  let host: HTMLDivElement;

  onMount(() => mountTravel(host));
</script>

<div id="legacy-furnace-travel" class="furnace-destinations" bind:this={host}></div>
