<script lang="ts">
  import { onMount } from 'svelte';
  import type { DebugDiagnosticSnapshot, ShipKitId } from '../../../shared-types';
  import { debugIsOn } from '../../constants/user-preferences';
  import {
    createDebugReportClient,
    type DebugReportClientView,
  } from '../../diagnostics/debugReportClient';
  import type { PlayfieldGeometry } from '../../rendering/canvasSurface';
  import type { GameRuntime } from '../../runtime/gameRuntime';
  import { closeGameOverlay, openGameOverlay } from '../../runtime/overlayState';
  import { mountRuntime, type RuntimeMountState } from '../../runtime/runtimeMount';
  import type { GamePreference, GamePresentation } from '../../runtime/uiTypes';
  import UpdateNotice from '../UpdateNotice.svelte';
  import Button from '../ui/button/button.svelte';
  import ActionControls from './ActionControls.svelte';
  import CrewControls from './CrewControls.svelte';
  import DebugPanel from './DebugPanel.svelte';
  import DebugReportForm from './DebugReportForm.svelte';
  import FieldHints from './FieldHints.svelte';
  import GameOverlay from './GameOverlay.svelte';
  import InventoryPanel from './InventoryPanel.svelte';
  import PhoneCollector from './PhoneCollector.svelte';
  import StartScreen from './StartScreen.svelte';
  import TownPanel from './TownPanel.svelte';
  import UniverseMap from './UniverseMap.svelte';

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
    townTravel: null,
    debug: null,
    network: null,
    hints: [],
    phone: null,
    spawnActive: false,
    controls: {
      inPlay: false,
      touchMode: false,
      ability: {
        label: 'E',
        name: 'Ability',
        ready: false,
        active: false,
        cooling: false,
        unavailable: true,
        cooldownRatio: 0,
        pressed: false,
        disabled: true,
      },
      contourLock: {
        label: 'CONTOUR LOCK',
        name: 'Contour Lock',
        active: false,
        disabled: true,
        pressed: false,
      },
    },
  });
  let startup = $state.raw<RuntimeMountState<GameRuntime>>({ kind: 'loading' });
  let reportDescription = $state('');
  let reportSnapshot = $state.raw<DebugDiagnosticSnapshot | null>(null);
  let reportView = $state.raw<DebugReportClientView>({
    state: 'idle',
    message: 'Checking saved reports…',
    submission: null,
    reportId: null,
    canSend: false,
  });
  let reports: ReturnType<typeof createDebugReportClient> | null = null;
  let openingReport = false;
  async function openReport() {
    if (startup.kind !== 'ready' || openingReport) {
      return;
    }
    const runtime = startup.runtime;
    const client = reports;
    const previousOverlay = view.overlay;
    const delivered = reportView.state === 'delivered';
    const snapshot =
      reportView.reportId === null || delivered ? runtime.commands.captureDiagnostics() : null;
    openingReport = true;
    try {
      if (delivered && (await client?.newReport()) === true) {
        reportDescription = '';
      }
      if (
        reports !== client ||
        startup.kind !== 'ready' ||
        startup.runtime !== runtime ||
        view.overlay !== previousOverlay
      ) {
        return;
      }
      if (reportView.reportId === null) {
        reportSnapshot = snapshot;
      }
      openGameOverlay('debug-report');
    } finally {
      openingReport = false;
    }
  }
  async function startNewReport() {
    if (startup.kind !== 'ready') {
      return false;
    }
    const client = reports;
    const snapshot = startup.runtime.commands.captureDiagnostics();
    if ((await client?.newReport()) !== true || reports !== client) {
      return false;
    }
    reportDescription = '';
    reportSnapshot = snapshot;
    return true;
  }
  let playerName = $state('');
  let playerNameInitialized = false;
  let touchControls = $state(false);
  let returnToFlight = false;
  let canvas: HTMLCanvasElement;
  let titleCanvas: HTMLCanvasElement;
  let wrapper: HTMLElement;
  let gameArea: HTMLDivElement;
  let spawnCanvas: HTMLCanvasElement;
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
    if (debugIsOn()) {
      reports = createDebugReportClient((next) => {
        reportView = next;
      });
      void reports.restore();
    }
    let unsubscribe: (() => void) | undefined;
    const wasInPlay = document.body.classList.contains('in-play');
    const wasTouchPlay = document.body.classList.contains('touch-play');
    const wasOverlayOpen = document.body.classList.contains('game-overlay-open');
    const syncBody = () => {
      document.body.classList.toggle('in-play', view.inPlay);
      document.body.classList.toggle('touch-play', view.inPlay && touchControls);
      document.body.classList.toggle('game-overlay-open', view.overlay !== null);
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
            spawnCanvas,
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
            if (!playerNameInitialized) {
              playerName = next.menu.initialName;
              playerNameInitialized = true;
            }
            syncBody();
          });
        }
      }
    );
    retry = lifetime.retry;
    return () => {
      live = false;
      reports?.dispose();
      reports = null;
      unsubscribe?.();
      lifetime.dispose();
      document.body.classList.toggle('in-play', wasInPlay);
      document.body.classList.toggle('touch-play', wasTouchPlay);
      document.body.classList.toggle('game-overlay-open', wasOverlayOpen);
    };
  });
</script>

<UpdateNotice activeGame={view.inPlay || view.joining} />

<div id="safe-area-probe" aria-hidden="true"></div>
<canvas id="title-terrain" bind:this={titleCanvas} aria-hidden="true"></canvas>
<main id="gameWrapper" bind:this={wrapper}>
  <div id="start-screen" hidden={view.inPlay}>
    <StartScreen
      view={view.menu}
      bind:playerName={
        () => playerName,
        (name) => {
          playerName = name;
          playerNameInitialized = true;
        }
      }
      ready={startup.kind === 'ready'}
      joining={view.joining}
      initializationError={startup.kind === 'error' ? startup.message : null}
      joinError={view.joinError ?? view.failureNotice}
      onjoin={join}
      onretry={() => retry()}
      onselectship={selectShip}
      onpreference={setPreference}
    >
      {#if view.debug && startup.kind === 'ready'}
        <DebugPanel
          view={view.debug}
          inPlay={false}
          ontoggle={startup.runtime.commands.toggleDebugHud}
          diagnostics={startup.runtime.commands.readDiagnostics}
          onreport={openReport}
        />
      {/if}
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
    <canvas id="spawn-fly-in" bind:this={spawnCanvas} hidden={!view.spawnActive} aria-hidden="true"
    ></canvas>
    {#if startup.kind === 'ready'}
      {#if view.inPlay && view.overlay === null && view.crew?.active}
        <CrewControls
          view={view.crew}
          act={startup.runtime.commands.crewAction}
          signal={startup.runtime.commands.signalHere}
        />
      {/if}
      <ActionControls
        view={view.controls}
        mountActions={startup.runtime.commands.mountTouchActions}
      />
      <Button
        id="universe-map-toggle"
        variant="outline"
        class={touchControls ? 'map-toggle touch-toggle min-h-11' : 'map-toggle min-h-11'}
        aria-label={touchControls ? 'Open universe map' : 'Open universe map (M)'}
        aria-keyshortcuts={touchControls ? undefined : 'M'}
        aria-expanded={view.overlay === 'universe-map'}
        onclick={startup.runtime.commands.openUniverseMap}
        >Map {#if !touchControls}<kbd class="ml-2 text-xs">M</kbd>{/if}</Button
      >
      {#if view.debug}<DebugPanel
          view={view.debug}
          inPlay={true}
          ontoggle={startup.runtime.commands.toggleDebugHud}
          diagnostics={startup.runtime.commands.readDiagnostics}
          onreport={openReport}
        />{/if}
    {/if}
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
        travel={view.townTravel}
        ontravel={startup.runtime.commands.requestFurnaceTravel}
        onclose={() => closeTownStore(true)}
      />
    {/if}
  </GameOverlay>
  <GameOverlay
    open={view.overlay === 'debug-report'}
    title="Report a problem"
    description="Send your description and captured diagnostics to the GeoRoids project team."
    onclose={() => closeGameOverlay('debug-report')}
    fallbackFocusTarget={() => (view.inPlay ? canvas : null)}
    restoreFocus={view.overlay === null}
  >
    <DebugReportForm
      bind:description={reportDescription}
      snapshot={reportSnapshot}
      view={reportView}
      onsend={(description, diagnostics) => {
        void reports?.send(description, diagnostics);
      }}
      onretry={() => {
        void reports?.retry();
      }}
      onnew={startNewReport}
      onclose={() => closeGameOverlay('debug-report')}
    />
  </GameOverlay>
  {#if startup.kind === 'ready'}
    <UniverseMap
      open={view.overlay === 'universe-map'}
      touch={touchControls}
      mountMap={startup.runtime.commands.mountUniverseMap}
      onclose={startup.runtime.commands.closeUniverseMap}
      fallbackFocusTarget={() => (view.inPlay ? canvas : null)}
      restoreFocus={view.overlay === null && view.inPlay}
    />
    <FieldHints hints={view.hints} onactivate={startup.runtime.commands.activateHint} />
    {#if view.phone}<div hidden={view.overlay !== null}>
        <PhoneCollector
          view={view.phone}
          inPlay={view.inPlay}
          onstart={startup.runtime.commands.startPhoneCollection}
          onstop={startup.runtime.commands.stopPhoneCollection}
          onrecover={startup.runtime.commands.recoverPhoneCollection}
          ondownload={startup.runtime.commands.downloadPhoneCollection}
        />
      </div>{/if}
  {/if}
  {#if view.network}<div
      id="network-status-banner"
      role="alert"
      class="network-banner rounded-lg border border-border bg-card px-4 py-3 text-foreground"
    >
      {view.network.message}
    </div>{/if}
</main>

<style>
  main {
    --mobile-diagnostic-max-height: calc(
      (
          100dvh - var(--mobile-controls-top, 80px) - 56px -
            max(100px, calc(env(safe-area-inset-bottom) + 88px)) - 12px
        ) /
        2
    );
  }
  #spawn-fly-in {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 5;
  }
  #spawn-fly-in[hidden] {
    display: none;
  }
  :global(.map-toggle) {
    position: fixed;
    z-index: 25;
    left: var(--map-toggle-x);
    top: var(--map-toggle-y);
    transform: translateX(-50%);
  }
  :global(.map-toggle.touch-toggle) {
    top: var(--mobile-controls-top);
    left: calc(var(--action-left) + var(--action-width) + 6px);
    width: var(--action-width);
    transform: none;
  }
  .network-banner {
    position: fixed;
    z-index: 100;
    top: max(12px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    max-width: min(32rem, 90vw);
  }

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
