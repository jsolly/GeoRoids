<script lang="ts">
  import { flushSync, untrack } from 'svelte';
  import {
    createFurnaceTravelLayout,
    type FurnaceTravelView,
    mountFurnaceMapGestures,
  } from '../../ui/furnaceTravelMap';
  import Button from '../ui/button/button.svelte';

  let { view, ontravel }: { view: FurnaceTravelView; ontravel: (id: string) => void } = $props();
  let width = $state(320);
  let windowHeight = $state(768);
  let zoom = $state(1);
  let describedId = $state<string | null>(null);
  const layout = $derived(createFurnaceTravelLayout(view, width, windowHeight));
  const described = $derived(view.destinations.find((site) => site.id === describedId));
  const caption = $derived(
    described ? `Travel to ${described.name}` : `You are at ${view.source.name}.`
  );

  function gestures(viewport: HTMLDivElement) {
    // Geometry updates must not retire captures or reset a pilot's zoom mid-gesture.
    const initial = untrack(() => layout.initialScroll);
    viewport.scrollLeft = initial.x;
    viewport.scrollTop = initial.y;
    return mountFurnaceMapGestures(viewport, (next) => {
      // Commit the larger scroll bounds before the browser clamps the new offsets.
      flushSync(() => {
        zoom = next;
      });
    });
  }
</script>

<svelte:window bind:innerHeight={windowHeight} />

<div class="furnace-destinations" bind:clientWidth={width}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (This named scroll region needs keyboard focus for native scrolling and its +/− zoom commands.) -->
  <div
    class="furnace-travel-viewport"
    tabindex="0"
    role="region"
    aria-label="Furnace destination map. Pinch or use +/− keys to zoom, drag or scroll to explore; Tab to choose a furnace."
    {@attach gestures}
  >
    <div
      class="furnace-travel-bounds"
      style:width={`${layout.size * zoom}px`}
      style:height={`${layout.size * zoom}px`}
    >
      <div
        class="furnace-travel-map"
        style:width={`${layout.size}px`}
        style:height={`${layout.size}px`}
        style:transform={`scale(${zoom})`}
      >
        <svg
          class="furnace-travel-pipes"
          viewBox={`0 0 ${layout.size} ${layout.size}`}
          aria-hidden="true"
        >
          {#each layout.routes as route (route.id)}
            <polyline points={route.points} />
          {/each}
        </svg>
        {#each layout.sites as site (site.id)}
          {@const current = site.id === view.source.id}
          {@const label = current ? `${site.name} — You are here` : `Travel to ${site.name}`}
          <Button
            variant="outline"
            class="furnace-travel-marker"
            style={`left: ${site.position.x}px; top: ${site.position.y}px; width: ${layout.markerSize}px; height: ${layout.markerSize}px;`}
            title={label}
            aria-label={label}
            aria-current={current ? 'location' : undefined}
            disabled={current}
            data-furnace-id={current ? undefined : site.id}
            onfocus={() => {
              if (!current) describedId = site.id;
            }}
            onpointerenter={() => {
              if (!current) describedId = site.id;
            }}
            onpointerdown={() => {
              if (!current) describedId = site.id;
            }}
            onclick={() => {
              if (!current) ontravel(site.id);
            }}
          >
            <span class="furnace-travel-symbol" aria-hidden="true">{current ? '◎' : '♨'}</span>
            <span class="furnace-travel-label">{current ? 'Here' : site.name}</span>
          </Button>
        {/each}
      </div>
    </div>
  </div>
  <p class="furnace-travel-caption" aria-live="polite">{caption}</p>
  <p class="furnace-travel-hint">
    {view.destinations.length === 0
      ? 'No other furnaces are lit yet. Build a furnace to open a route.'
      : 'Select a lit furnace to travel. Pinch or use +/− keys to zoom; drag or scroll to explore.'}
  </p>
</div>

<style>
  .furnace-destinations {
    display: grid;
    gap: 8px;
    min-height: 0;
  }
  .furnace-travel-viewport {
    touch-action: none;
    user-select: none;
    height: min(42dvh, 340px);
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--border);
    background: var(--background);
    scrollbar-width: thin;
  }
  .furnace-travel-bounds {
    position: relative;
  }
  .furnace-travel-map {
    contain: size;
    position: absolute;
    transform-origin: top left;
    background-image:
      linear-gradient(var(--border) 1px, transparent 1px),
      linear-gradient(90deg, var(--border) 1px, transparent 1px);
    background-size: 32px 32px;
  }
  .furnace-travel-pipes {
    position: absolute;
    width: 100%;
    height: 100%;
    fill: none;
    stroke: #b89558;
    stroke-width: 2;
    opacity: 0.65;
    pointer-events: none;
  }
  .furnace-destinations :global(.furnace-travel-marker) {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 4px;
    transform: translate(-50%, -50%);
    border-radius: 8px;
    background: var(--card);
    color: var(--foreground);
    border-color: var(--border);
    text-align: center;
    letter-spacing: normal;
    text-transform: none;
    cursor: pointer;
    white-space: normal;
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .furnace-destinations :global(.furnace-travel-marker:hover),
  .furnace-destinations :global(.furnace-travel-marker:focus-visible) {
    z-index: 1;
    outline: 3px solid var(--ring);
    outline-offset: 2px;
  }
  .furnace-destinations :global(.furnace-travel-marker[aria-current]) {
    pointer-events: none;
    color: var(--primary);
    border-color: var(--primary);
    opacity: 1;
    cursor: default;
  }
  .furnace-travel-symbol {
    font-size: 23px;
    line-height: 1;
  }
  .furnace-travel-label {
    width: 100%;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
    font-size: 10px;
    line-height: 1.3;
  }
  .furnace-travel-caption,
  .furnace-travel-hint {
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--muted-foreground);
  }
</style>
