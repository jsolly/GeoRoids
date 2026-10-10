<script lang="ts">
  import { onMount } from 'svelte';
  import type { ShipKitId } from '../../../shared-types';
  import type { PlayfieldGeometry } from '../../rendering/canvasSurface';
  import type { GameRuntime } from '../../runtime/gameRuntime';
  import { mountRuntime, type RuntimeMountState } from '../../runtime/runtimeMount';
  import type { GamePreference, GamePresentation } from '../../runtime/uiTypes';
  import Button from '../ui/button/button.svelte';
  import GameOverlay from './GameOverlay.svelte';
  import InventoryPanel from './InventoryPanel.svelte';
  import StartScreen from './StartScreen.svelte';
  import TownPanel from './TownPanel.svelte';

  let view = $state.raw<GamePresentation>({
    menu: {
      initialName: '',
      fallbackName: 'Pilot',
      selectedKit: 'scout',
      preferences: { sound: false, music: false, haptics: false, hapticsAvailable: false },
      buildInfo: '',
    },
    inPlay: false,
    joining: false,
    joinError: null,
    failureNotice: null,
    overlay: null,
    inventory: null,
    townStore: null,
  });
  let startup = $state.raw<RuntimeMountState<GameRuntime>>({ kind: 'loading' });
  let playerName = $state('');
  let touchControls = $state(false);
  let returnToFlight = false;
  let canvas: HTMLCanvasElement;
  let titleCanvas: HTMLCanvasElement;
  let wrapper: HTMLElement;
  let gameArea: HTMLDivElement;
  let collector: HTMLDivElement;
  let legacyMenu: HTMLDivElement;
  let legacyPlay: HTMLDivElement;
  let legacyOverlay: HTMLDivElement;
  let retry = () => {};

  function join(name: string) {
    if (startup.kind === 'ready') {
      startup.runtime.commands.join(name);
    }
  }
  function selectShip(kit: ShipKitId) {
    if (startup.kind === 'ready') {
      startup.runtime.commands.selectShip(kit);
    }
  }
  function setPreference(kind: GamePreference, enabled: boolean) {
    if (startup.kind === 'ready') {
      startup.runtime.commands.setPreference(kind, enabled);
    }
  }
  function openInventory() {
    returnToFlight = false;
    if (startup.kind === 'ready') {
      startup.runtime.commands.openInventory();
    }
  }
  function closeInventory(returning = false) {
    returnToFlight = returning;
    if (startup.kind === 'ready') {
      startup.runtime.commands.closeInventory();
    }
  }
  function closeTownStore(returning = false) {
    returnToFlight = returning;
    if (startup.kind === 'ready') {
      startup.runtime.commands.closeTownStore();
    }
  }

  onMount(() => {
    let live = true;
    let receivedInitialName = false;
    let unsubscribe: (() => void) | undefined;
    const wasInPlay = document.body.classList.contains('in-play');
    const wasTouchPlay = document.body.classList.contains('touch-play');
    const syncBody = () => {
      document.body.classList.toggle('in-play', view.inPlay);
      document.body.classList.toggle('touch-play', view.inPlay && touchControls);
    };
    syncBody();
    const lifetime = mountRuntime<GameRuntime>(
      async (signal) => {
        const { createGameRuntime } = await import('../../runtime/gameRuntime');
        signal.throwIfAborted();
        return createGameRuntime(
          {
            canvas,
            titleCanvas,
            collector,
            legacyMenu,
            legacyPlay,
            legacyOverlay,
            placeChrome(geometry: PlayfieldGeometry) {
              if (!live) {
                return;
              }
              touchControls = geometry.touchControls;
              gameArea.style.width = `${geometry.width}px`;
              gameArea.style.height = `${geometry.height}px`;
              wrapper.style.setProperty('--mobile-controls-top', `${geometry.mobileControlsTop}px`);
              wrapper.style.setProperty('--map-toggle-x', `${geometry.mapX}px`);
              wrapper.style.setProperty('--map-toggle-y', `${geometry.mapY}px`);
              wrapper.style.setProperty('--schematic-toggle-y', `${geometry.schematicY}px`);
              wrapper.style.setProperty('--store-toggle-y', `${geometry.storeY}px`);
              syncBody();
            },
          },
          signal
        );
      },
      (state) => {
        if (!live) {
          return;
        }
        startup = state;
        if (state.kind === 'ready') {
          unsubscribe = state.runtime.subscribe((next) => {
            if (!live) {
              return;
            }
            if (next.overlay !== null && next.overlay !== view.overlay) {
              returnToFlight = false;
            }
            view = next;
            if (!receivedInitialName) {
              playerName = next.menu.initialName;
              receivedInitialName = true;
            }
            syncBody();
          });
        }
      }
    );
    retry = lifetime.retry;
    return () => {
      live = false;
      unsubscribe?.();
      lifetime.dispose();
      document.body.classList.toggle('in-play', wasInPlay);
      document.body.classList.toggle('touch-play', wasTouchPlay);
    };
  });
</script>

<div id="safe-area-probe" aria-hidden="true"></div>
<canvas id="title-terrain" bind:this={titleCanvas} aria-hidden="true"></canvas>
<main id="gameWrapper" bind:this={wrapper}>
  <div id="start-screen" hidden={view.inPlay}>
    <StartScreen
      view={view.menu}
      bind:playerName
      ready={startup.kind === 'ready'}
      joining={view.joining}
      initializationError={startup.kind === 'error' ? startup.message : null}
      joinError={view.joinError ?? view.failureNotice}
      onjoin={join}
      onretry={() => retry()}
      onselectship={selectShip}
      onpreference={setPreference}
    >
      <div bind:this={legacyMenu}></div>
    </StartScreen>
  </div>
  <div id="gameArea" bind:this={gameArea} hidden={!view.inPlay}>
    <canvas id="gameCanvas" bind:this={canvas} tabindex="-1" aria-label="GeoRoids playfield"
    ></canvas>
    <Button
      id="ship-schematic-toggle"
      variant="outline"
      class={touchControls ? 'inventory-toggle touch-toggle min-h-11' : 'inventory-toggle min-h-11'}
      hidden={!view.inPlay}
      disabled={startup.kind !== 'ready'}
      aria-label={touchControls
        ? 'Open inventory and ship schematic'
        : 'Open inventory and ship schematic (V)'}
      aria-keyshortcuts={touchControls ? undefined : 'V'}
      aria-expanded={view.overlay === 'inventory'}
      onclick={openInventory}
      >Inventory {#if !touchControls}<kbd class="ml-2 text-xs text-muted-foreground">V</kbd
        >{/if}</Button
    >
    <div bind:this={legacyPlay}></div>
  </div>
  <GameOverlay
    open={view.overlay === 'inventory'}
    title="Ship and inventory"
    description="Manage your ship tools and stored satellites."
    onclose={() => closeInventory()}
    closeFocusTarget={() => (returnToFlight ? canvas : null)}
    fallbackFocusTarget={() => (view.inPlay ? canvas : null)}
    restoreFocus={view.overlay === null && view.inPlay}
  >
    {#if view.overlay === 'inventory' && view.inventory && startup.kind === 'ready'}
      <InventoryPanel
        view={view.inventory}
        onpage={startup.runtime.commands.inventoryPage}
        onequip={startup.runtime.commands.equipSatellite}
        onutility={startup.runtime.commands.equipUtility}
        draw={startup.runtime.commands.drawInventory}
        onclose={() => closeInventory(true)}
      />
    {/if}
  </GameOverlay>
  <GameOverlay
    open={view.overlay === 'town-store'}
    title={view.townStore?.title ?? 'Town Square'}
    description="Shop at Town Square or travel between lit furnaces."
    onclose={() => closeTownStore()}
    closeFocusTarget={() => (returnToFlight ? canvas : null)}
    fallbackFocusTarget={() => (view.inPlay ? canvas : null)}
    restoreFocus={view.overlay === null && view.inPlay}
  >
    {#if view.overlay === 'town-store' && view.townStore && startup.kind === 'ready'}
      <TownPanel
        view={view.townStore}
        onmode={startup.runtime.commands.selectTownView}
        onpurchase={startup.runtime.commands.purchaseTownOffer}
        mountTravel={startup.runtime.commands.mountTownTravel}
        onclose={() => closeTownStore(true)}
      />
    {/if}
  </GameOverlay>
  <div bind:this={legacyOverlay}></div>
  <div bind:this={collector}></div>
</main>

<style>
  :global(.inventory-toggle) {
    position: fixed;
    z-index: 25;
    right: max(12px, env(safe-area-inset-right));
    top: var(--schematic-toggle-y);
  }
  :global(.inventory-toggle.touch-toggle) {
    top: var(--mobile-controls-top);
    right: auto;
    left: max(12px, env(safe-area-inset-left));
  }
</style>
