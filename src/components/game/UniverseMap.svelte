<script lang="ts">
  import { tick } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import {
    MAP_LEGEND_KINDS,
    paintMapLegend,
    UNIVERSE_MAP_IDS,
    UNIVERSE_MAP_LOCATE_LABEL,
    UNIVERSE_MAP_ZOOM,
    type UniverseMapChrome,
    type UniverseMapController,
  } from '../../ui/universeMap';
  import Button from '../ui/button/button.svelte';
  import Dialog from '../ui/dialog/dialog.svelte';
  import DialogContent from '../ui/dialog/dialog-content.svelte';
  import DialogDescription from '../ui/dialog/dialog-description.svelte';
  import DialogTitle from '../ui/dialog/dialog-title.svelte';

  let {
    open,
    touch,
    mountMap,
    onclose,
    closeFocusTarget,
    fallbackFocusTarget,
    restoreFocus = true,
  }: {
    open: boolean;
    touch: boolean;
    mountMap: (
      canvas: HTMLCanvasElement,
      onChrome: (chrome: UniverseMapChrome) => void
    ) => UniverseMapController;
    onclose: () => void;
    closeFocusTarget?: () => HTMLElement | null;
    fallbackFocusTarget?: () => HTMLElement | null;
    restoreFocus?: boolean;
  } = $props();

  let chrome = $state.raw<UniverseMapChrome | null>(null);
  let controller: UniverseMapController | undefined;
  let opener: HTMLElement | null = null;
  let closeButton = $state<HTMLButtonElement | null>(null);
  let stage: HTMLDivElement | null = null;
  let compass: HTMLDivElement | null = null;
  let legend: HTMLDivElement | null = null;
  let locate = $state<HTMLButtonElement | null>(null);
  let showLocations = $state(false);
  const frame = $derived(chrome?.frame ?? { x: 0, y: 0, size: 180 });

  function usable(target: HTMLElement | null | undefined): target is HTMLElement {
    if (
      !target?.isConnected ||
      target === document.body ||
      target.matches(':disabled, [aria-disabled="true"]')
    ) {
      return false;
    }
    for (let node: HTMLElement | null = target; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (
        node.hidden ||
        node.hasAttribute('inert') ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      ) {
        return false;
      }
    }
    return true;
  }

  function openFocus(event: Event) {
    event.preventDefault();
    const active = document.activeElement;
    opener =
      active instanceof HTMLElement && !active.closest('[role="dialog"], dialog') ? active : null;
    closeButton?.focus({ preventScroll: true });
  }

  function closeFocus(event: Event) {
    event.preventDefault();
    if (open || !restoreFocus) {
      return;
    }
    const explicit = closeFocusTarget?.();
    const target = usable(explicit) ? explicit : usable(opener) ? opener : fallbackFocusTarget?.();
    if (usable(target)) {
      target.focus({ preventScroll: true });
    }
  }

  function measureOcclusions() {
    if (!stage || !controller) {
      return;
    }
    const origin = stage.getBoundingClientRect();
    controller.setOcclusions(
      [compass, legend, locate].flatMap((element) => {
        if (!element) {
          return [];
        }
        const bounds = element.getBoundingClientRect();
        return [
          {
            left: bounds.left - origin.left,
            right: bounds.right - origin.left,
            top: bounds.top - origin.top,
            bottom: bounds.bottom - origin.top,
          },
        ];
      })
    );
  }

  const attachCanvas: Attachment<HTMLCanvasElement> = (canvas) => {
    let live = true;
    const mounted = mountMap(canvas, (next) => {
      if (!live) {
        return;
      }
      chrome = next;
      void tick().then(() => {
        if (live) {
          measureOcclusions();
        }
      });
    });
    controller = mounted;
    const observer = new ResizeObserver(measureOcclusions);
    if (legend) {
      observer.observe(legend);
    }
    return () => {
      live = false;
      observer.disconnect();
      mounted.dispose();
      if (controller === mounted) {
        controller = undefined;
      }
    };
  };

  function keydown(event: KeyboardEvent) {
    if (!open || event.defaultPrevented || event.code === 'Escape' || event.code === 'KeyM') {
      return;
    }
    controller?.keydown(event);
  }
</script>

<svelte:document onkeydown={keydown} />

<Dialog
  bind:open={
    () => open,
    (next) => {
      if (!next && open) onclose();
    }
  }
>
  <DialogContent
    id={UNIVERSE_MAP_IDS.dialog}
    showCloseButton={false}
    onOpenAutoFocus={openFocus}
    onCloseAutoFocus={closeFocus}
    class={`universe-map-dialog !fixed !inset-0 !left-0 !top-0 !m-0 !h-dvh !w-screen !max-w-none !translate-x-0 !translate-y-0 !gap-0 !rounded-none !p-0 ${touch ? 'universe-map-touch' : ''}`}
  >
    <header class="universe-map-header">
      <div>
        <p class="universe-map-eyebrow">Shared field cartography</p>
        <DialogTitle id="universe-map-title">Universe map</DialogTitle>
        <DialogDescription class="universe-map-subtitle"
          >Your nearby discoveries. Zoom out to explore the whole world.</DialogDescription
        >
      </div>
      <div class="universe-map-actions">
        <Button
          id={UNIVERSE_MAP_IDS.close}
          bind:ref={closeButton}
          aria-label="Close"
          onclick={onclose}
          >Close {#if !touch}<kbd>Esc</kbd>{/if}</Button
        >
      </div>
    </header>
    <div class="universe-map-stage" bind:this={stage}>
      <p id="universe-map-navigation" class="sr-only">
        {touch
          ? 'Drag to pan and pinch to zoom. Use Center on you to return to your ship.'
          : 'Arrow keys pan, plus and minus zoom, and Home centers on your ship.'}
      </p>
      <canvas
        id={UNIVERSE_MAP_IDS.canvas}
        tabindex="0"
        aria-label="Shared universe map"
        aria-describedby="universe-map-navigation"
        aria-details={UNIVERSE_MAP_IDS.locations}
        {@attach attachCanvas}
      ></canvas>
      <div
        class="universe-map-compass"
        bind:this={compass}
        style:left={`${frame.x + 12}px`}
        style:top={`${frame.y + 12}px`}
        style:transform={`rotate(${chrome?.heading ?? 0}rad)`}
        aria-hidden="true"
      >
        <span>N</span><i></i>
      </div>
      <Button
        id={UNIVERSE_MAP_IDS.center}
        bind:ref={locate}
        class="universe-map-locate"
        style={`left:${frame.x + frame.size - 56}px;top:${frame.y + frame.size - 56}px;right:auto;bottom:auto`}
        aria-label={UNIVERSE_MAP_LOCATE_LABEL}
        title={UNIVERSE_MAP_LOCATE_LABEL}
        aria-keyshortcuts={touch ? undefined : 'Home'}
        aria-pressed={chrome?.centered ?? true}
        onclick={() => controller?.center()}
      >
        <svg
          class="universe-map-locate-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          ><title>{UNIVERSE_MAP_LOCATE_LABEL}</title><circle
            class="universe-map-locate-dot"
            cx="12"
            cy="12"
            r="3"
          /><circle class="universe-map-locate-ring" cx="12" cy="12" r="7" /><path
            class="universe-map-locate-cross"
            d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2"
          /></svg
        >
      </Button>
      <div
        class="universe-map-legend"
        bind:this={legend}
        style:left={`${frame.x + 12}px`}
        style:top={`${frame.y + frame.size - 12}px`}
        style:max-width={`${Math.max(0, frame.size - 80)}px`}
        style:transform="translateY(-100%)"
      >
        {#each MAP_LEGEND_KINDS as kind (kind)}
          <span
            ><canvas
              class="map-key"
              width="32"
              height="32"
              aria-hidden="true"
              {@attach (canvas) => paintMapLegend(canvas, kind)}
            ></canvas>{kind}</span
          >
        {/each}
      </div>
    </div>
    <div class="map-accessibility-controls">
      <Button
        variant="outline"
        aria-label="Zoom out"
        onclick={() => controller?.zoomBy(1 / UNIVERSE_MAP_ZOOM.step)}>−</Button
      >
      <Button
        variant="outline"
        aria-label="Zoom in"
        onclick={() => controller?.zoomBy(UNIVERSE_MAP_ZOOM.step)}>+</Button
      >
      <Button
        variant="outline"
        aria-expanded={showLocations}
        aria-controls={UNIVERSE_MAP_IDS.locations}
        onclick={() => {
          showLocations = !showLocations;
        }}>Locations</Button
      >
    </div>
    <section
      class={showLocations ? 'map-location-panel' : 'sr-only'}
      aria-label="Revealed landmarks and crew coordinates"
      onfocusin={() => {
        showLocations = true;
      }}
    >
      <ul id={UNIVERSE_MAP_IDS.locations}>
        {#each chrome?.locations ?? [] as location, index (`${chrome?.locationPage}:${index}:${location}`)}<li
          >
            {location}
          </li>{/each}
      </ul>
      <nav aria-label="Location pages">
        <Button
          variant="outline"
          disabled={!chrome || chrome.locationPage === 0}
          onclick={() => controller?.setLocationPage((chrome?.locationPage ?? 0) - 1)}
          >Previous locations</Button
        >
        <span role="status"
          >Page {(chrome?.locationPage ?? 0) + 1} of {chrome?.locationPages ?? 1} · {chrome?.locationCount ??
            0} locations</span
        >
        <Button
          variant="outline"
          disabled={!chrome || chrome.locationPage + 1 >= chrome.locationPages}
          onclick={() => controller?.setLocationPage((chrome?.locationPage ?? 0) + 1)}
          >Next locations</Button
        >
      </nav>
    </section>
  </DialogContent>
</Dialog>

<style>
  :global(.universe-map-dialog) {
    display: flex;
    flex-direction: column;
  }
  .universe-map-stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  canvas {
    touch-action: none;
  }
  #universe-map-canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .map-accessibility-controls {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem max(0.75rem, env(safe-area-inset-right))
      max(0.5rem, env(safe-area-inset-bottom));
  }
  .map-location-panel {
    position: absolute;
    z-index: 2;
    left: 0.75rem;
    bottom: 4rem;
    max-height: 60dvh;
    max-width: calc(100vw - 1.5rem);
    overflow: auto;
    padding: 1rem;
    background: var(--card);
    color: var(--card-foreground);
    font-family: var(--font-sans, system-ui, sans-serif);
    border: 1px solid var(--border);
  }
  .map-location-panel nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .map-location-panel li {
    margin-bottom: 0.25rem;
  }
</style>
