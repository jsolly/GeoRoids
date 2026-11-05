import { sanitizeDebugDiagnostics } from '../../shared/debugReports';
import { sanitizePlayerName } from '../../shared/player';
import { boundedDiagnosticError } from '../../shared/stateDiagnostics';
import { activateAudio, disposeAudioRuntime } from '../audio/audioRuntime';
import { playFeedback } from '../audio/feedbackSounds';
import { disposeMusicBeds, mountMusicBeds, setMusic } from '../audio/musicBeds';
import { setSound } from '../audio/Sound';
import { musicIsOn, soundIsOn } from '../constants/user-preferences';
import { EventLoop } from '../core/eventLoop';
import { GameController } from '../core/gameController';
import { clientPerformance, mountPerformanceMetrics } from '../diagnostics/performanceMetrics';
import { createPhoneCollector } from '../diagnostics/phoneCollector';
import { PlayerManager } from '../entities/player/PlayerManager';
import { SatellitePickupManager } from '../entities/satellitePickup/SatellitePickupManager';
import { hapticsApiAvailable, hapticsPreferenceOn, setHaptics } from '../fx/haptics';
import {
  disposeTouchControls,
  initializeTouchControls,
  mountTouchActionControls,
  readActionControls,
} from '../input/touchControls';
import { ConnectionManager } from '../network/services/ConnectionManager';

import { readStoredResumeName, readStoredResumeToken } from '../network/services/resumeCredential';
import { canvasManager, type PlayfieldGeometry } from '../rendering/canvasSurface';
import { mountShipSchematicCanvases } from '../rendering/shipSchematicCanvas';
import { initTitleTerrain } from '../rendering/titleTerrain';
import { resetCargoFullHint } from '../ui/cargoFullHint';
import {
  activateFieldHint,
  hideFieldHints,
  readFieldHints,
  subscribeFieldHints,
} from '../ui/fieldHint';
import type { FurnaceSite, FurnaceTravelView } from '../ui/furnaceTravelMap';
import { mountNetworkStatus, readNetworkStatus, subscribeNetworkStatus } from '../ui/networkStatus';
import { disposeSchematicEquipHint, initializeSchematicEquipHint } from '../ui/schematicEquipHint';
import { mountSpawnFlyIn, stopSpawnFlyIn } from '../ui/spawnFlyIn';
import { isPlayViewOn, resetPlayView } from '../ui/uiUtils';
import { mountUniverseMap, type UniverseMapController } from '../ui/universeMap';
import { shouldUseTouchControls } from '../ui/viewportChrome';
import { getBuildInfoString } from '../utils/buildInfo';
import { disposeGlobalErrorLogging, installGlobalErrorLogging } from '../utils/globalErrorLogging';
import { logger } from '../utils/Logger';
import { generatePilotNickname } from '../utils/pilotNickname';
import { readCrewRescue, sendCrewAction, signalHere } from './crewRescue';
import { createDebugPresentation } from './debugPresentation';
import {
  equipInventorySatellite,
  equipInventoryUtility,
  readInventoryView,
  readSchematicSelection,
} from './inventory';
import { mountInventoryShortcuts, openInventory } from './inventoryOverlay';
import {
  closeGameOverlay,
  getOpenGameOverlay,
  isGameOverlayOpen,
  openGameOverlay,
  subscribeGameOverlay,
} from './overlayState';
import { createPresentation, type PresentationSubscription } from './presentation';
import { getSelectedShipKitId, setSelectedShipKitId } from './shipSelection';
import {
  closeTownStore,
  mountTownStore,
  purchaseTownOffer,
  readTownStoreView,
  readTownTravelMap,
  requestFurnaceTravel,
  selectTownView,
  subscribeTownStore,
} from './townStore';
import type { GameCommands, GamePresentation } from './uiTypes';

export interface GameRuntime extends PresentationSubscription<GamePresentation> {
  readonly commands: GameCommands;
  dispose(): void;
}

export interface GameRuntimeHosts {
  readonly canvas: HTMLCanvasElement;
  readonly titleCanvas: HTMLCanvasElement;
  readonly spawnCanvas: HTMLCanvasElement;
  readonly placeChrome: (geometry: PlayfieldGeometry) => void;
}

let activeRuntime: (() => void) | undefined;

/** Import only after the shell mounts. Production managers retain one object graph. */
export function createGameRuntime(hosts: GameRuntimeHosts, signal: AbortSignal): GameRuntime {
  signal.throwIfAborted();
  if (activeRuntime) {
    throw new Error('A game shell is already mounted.');
  }
  let disposed = false;
  const cleanup: (() => void)[] = [resetPlayView];
  const painters = new Set<() => void>();
  const mapControllers = new Set<UniverseMapController>();
  const actionBindings = new Set<() => void>();
  let spawnActive = false;
  let notifyPresentation = () => {};
  cleanup.push(() => {
    for (const stop of painters) {
      stop();
    }
    painters.clear();
    for (const map of mapControllers) {
      map.dispose();
    }
    mapControllers.clear();
    for (const stop of actionBindings) {
      stop();
    }
    actionBindings.clear();
  });
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    const closeOverlay = () => {
      const overlay = getOpenGameOverlay();
      if (overlay !== null) {
        closeGameOverlay(overlay);
      }
    };
    for (const stop of [closeOverlay, ...cleanup.reverse()]) {
      try {
        stop();
      } catch (error) {
        logger.error(
          'STATE',
          'Game runtime cleanup failed',
          boundedDiagnosticError(error, 'Unknown game runtime failure')
        );
      }
    }
    cleanup.length = 0;
    if (activeRuntime === dispose) {
      activeRuntime = undefined;
    }
  };
  activeRuntime = dispose;
  try {
    signal.addEventListener('abort', dispose, { once: true });
    cleanup.push(() => signal.removeEventListener('abort', dispose));
    cleanup.push(() => logger.detachRuntime());
    logger.attachRuntime();
    cleanup.push(hideFieldHints, resetCargoFullHint);
    cleanup.push(
      mountSpawnFlyIn(hosts.spawnCanvas, (visible) => {
        spawnActive = visible;
        if (!disposed) {
          notifyPresentation();
        }
      })
    );
    cleanup.push(disposeGlobalErrorLogging);
    installGlobalErrorLogging();
    cleanup.push(disposeAudioRuntime, disposeMusicBeds);
    mountMusicBeds();
    clientPerformance.observeServerRelease(() =>
      ConnectionManager.getInstance().getServerReleaseId()
    );
    cleanup.push(() => clientPerformance.observeServerRelease(undefined));
    cleanup.push(mountPerformanceMetrics());
    cleanup.push(disposeSchematicEquipHint);
    initializeSchematicEquipHint();
    cleanup.push(mountNetworkStatus());
    cleanup.push(initTitleTerrain(hosts.titleCanvas));
    cleanup.push(() => canvasManager.destroy());
    canvasManager.initialize(hosts.canvas, hosts.placeChrome);
    const controller = GameController.getInstance();
    cleanup.push(() => controller.detachRuntime(), stopSpawnFlyIn);
    controller.attachRuntime();

    const fallbackName = generatePilotNickname();
    const initialName = readStoredResumeName() ?? '';
    let joining = false;
    let joinError: string | null = null;
    let failureNotice: string | null = null;

    let inventoryPage = 0;
    const debug = createDebugPresentation(() => notifyPresentation());
    cleanup.push(() => debug.dispose());
    const phone =
      clientPerformance.enabled &&
      new URLSearchParams(window.location.search).get('performance') === 'collect'
        ? createPhoneCollector(clientPerformance, () => notifyPresentation())
        : null;
    cleanup.push(() => phone?.dispose());
    const freezeSite = (site: FurnaceSite): FurnaceSite =>
      Object.freeze({
        id: site.id,
        name: site.name,
        position: Object.freeze({ x: site.position.x, y: site.position.y }),
      });
    const projectTravel = (): FurnaceTravelView | null => {
      const travel = readTownTravelMap();
      if (!travel.source) {
        return null;
      }
      // This list is bounded by the world's fixed civic-lot catalog.
      return Object.freeze({
        source: freezeSite(travel.source),
        destinations: Object.freeze(travel.destinations.map(freezeSite)),
        pilots: Object.freeze(
          ConnectionManager.getInstance()
            .getAllPlayers()
            .filter(
              (pilot) =>
                pilot.botRole === undefined && pilot.ship.health > 0 && !pilot.ship.exploding
            )
            .map((pilot) =>
              Object.freeze({
                id: pilot.id,
                name: pilot.name,
                position: Object.freeze({ ...pilot.ship.position }),
                local: pilot.type === 'local',
              })
            )
        ),
      });
    };
    const project = (): GamePresentation => {
      const townStore = isGameOverlayOpen('town-store') ? readTownStoreView() : null;
      const controls = readActionControls(PlayerManager.getInstance().getLocalPlayer());
      return Object.freeze({
        menu: Object.freeze({
          initialName,
          fallbackName,
          selectedKit: getSelectedShipKitId(),
          preferences: Object.freeze({
            sound: soundIsOn(),
            music: musicIsOn(),
            haptics: hapticsPreferenceOn(),
            hapticsAvailable: hapticsApiAvailable(),
          }),
          buildInfo: getBuildInfoString(),
        }),
        inPlay: isPlayViewOn(),
        crew: readCrewRescue(),

        joining,
        joinError,
        failureNotice,
        overlay: getOpenGameOverlay(),
        inventory: isGameOverlayOpen('inventory') ? readInventoryView(inventoryPage) : null,
        townStore,
        townTravel: townStore?.mode === 'travel' ? projectTravel() : null,
        debug: debug.read(isPlayViewOn()),
        network: readNetworkStatus(),
        hints: isPlayViewOn() ? readFieldHints() : Object.freeze([]),
        controls: Object.freeze({
          ...controls,
          ability: Object.freeze(controls.ability),
          contourLock: Object.freeze(controls.contourLock),
        }),
        spawnActive,
        phone: phone?.read() ?? null,
      });
    };
    const presentation = createPresentation(
      project,
      (previous, next) => JSON.stringify(previous) === JSON.stringify(next)
    );
    notifyPresentation = () => {
      if (!disposed) {
        presentation.transition();
      }
    };
    cleanup.push(() => presentation.dispose());
    cleanup.push(
      subscribeNetworkStatus(notifyPresentation),
      subscribeFieldHints(notifyPresentation)
    );
    cleanup.push(
      subscribeGameOverlay((next, previous) => {
        playFeedback('interface');
        if (previous === 'universe-map' && next !== 'universe-map') {
          for (const map of mapControllers) {
            map.dispose();
          }
          mapControllers.clear();
        }
        if (next === 'inventory' && previous !== 'inventory') {
          inventoryPage = 0;
        }
        presentation.transition();
      })
    );
    cleanup.push(
      SatellitePickupManager.getInstance().subscribeInventory((owners) => {
        const player = PlayerManager.getInstance().getLocalPlayer();
        if (player && owners.has(player.id) && isGameOverlayOpen('inventory')) {
          presentation.transition();
        }
      })
    );
    cleanup.push(mountInventoryShortcuts(() => isPlayViewOn()));
    cleanup.push(subscribeTownStore(() => presentation.transition()));
    cleanup.push(mountTownStore());
    const events = new AbortController();
    cleanup.push(() => events.abort());
    window.addEventListener(
      'playViewOn',
      () => {
        presentation.transition();
      },
      { signal: events.signal }
    );
    window.addEventListener(
      'playViewOff',
      () => {
        const overlay = getOpenGameOverlay();
        if (overlay !== null) {
          closeGameOverlay(overlay);
        }
        presentation.transition();
      },
      { signal: events.signal }
    );
    cleanup.push(disposeTouchControls);
    initializeTouchControls({
      canvas: hosts.canvas,
      readInPlay: () => isPlayViewOn(),
      readTouchMode: shouldUseTouchControls,
      onActionState: notifyPresentation,
    });
    const openMap = () => {
      if (!disposed && isPlayViewOn()) {
        openGameOverlay('universe-map');
      }
    };
    document.addEventListener(
      'keydown',
      (event) => {
        if (
          event.code !== 'KeyM' ||
          !isPlayViewOn() ||
          (event.target instanceof Element &&
            event.target.closest('input, textarea, select, [contenteditable]'))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) {
          return;
        }
        if (isGameOverlayOpen('universe-map')) {
          closeGameOverlay('universe-map');
        } else {
          openMap();
        }
      },
      { capture: true, signal: events.signal }
    );
    const eventLoop = new EventLoop(controller, {
      window,
      document,
      requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
      cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
      now: () => performance.now(),
      observeRenderer: () =>
        clientPerformance.recordRendererFrame(canvasManager.getRendererBackend()),
      present: (now) => presentation.sample(now),
      reportFailure(error) {
        logger.error(
          'STATE',
          'game_loop_failed',
          boundedDiagnosticError(error, 'Unknown game runtime failure'),
          { observedAt: Date.now() }
        );
        failureNotice = 'An unexpected error occurred. Enter the game again to restart.';

        const overlay = getOpenGameOverlay();
        if (overlay !== null) {
          closeGameOverlay(overlay);
        }
        presentation.transition();
      },
    });
    cleanup.push(() => eventLoop.dispose());
    const commands: GameCommands = {
      crewAction(action) {
        if (!disposed) {
          sendCrewAction(action);
        }
      },
      signalHere(kind) {
        if (!disposed) {
          signalHere(kind);
        }
      },

      closeTownStore() {
        if (!disposed) {
          closeTownStore();
        }
      },
      selectTownView(mode) {
        if (!disposed) {
          selectTownView(mode);
        }
      },
      purchaseTownOffer(id) {
        if (!disposed) {
          purchaseTownOffer(id);
        }
      },
      requestFurnaceTravel(id) {
        if (!disposed && isPlayViewOn()) {
          requestFurnaceTravel(id);
        }
      },
      openUniverseMap: openMap,
      closeUniverseMap() {
        if (!disposed) {
          closeGameOverlay('universe-map');
        }
      },
      mountUniverseMap(canvas, onChrome) {
        if (disposed || !isGameOverlayOpen('universe-map')) {
          return {
            center() {},
            signalHelpAtCenter() {},
            zoomBy() {},
            keydown() {},
            setLocationPage() {},
            setOcclusions() {},
            dispose() {},
          };
        }
        const map = mountUniverseMap(canvas, onChrome);
        mapControllers.add(map);
        return {
          center: map.center,
          signalHelpAtCenter: map.signalHelpAtCenter,
          zoomBy: map.zoomBy,
          keydown: map.keydown,
          setLocationPage: map.setLocationPage,
          setOcclusions: map.setOcclusions,
          dispose() {
            map.dispose();
            mapControllers.delete(map);
          },
        };
      },
      mountTouchActions(elements) {
        if (disposed) {
          return () => {};
        }
        const stop = mountTouchActionControls(elements);
        const retire = () => {
          stop();
          actionBindings.delete(retire);
        };
        actionBindings.add(retire);
        return retire;
      },
      activateHint(id) {
        if (!disposed && isPlayViewOn() && getOpenGameOverlay() === null) {
          activateFieldHint(id);
        }
      },
      toggleDebugHud() {
        if (!disposed) {
          debug.toggleHud();
        }
      },
      readDiagnostics() {
        return disposed ? '' : debug.diagnostics();
      },
      captureDiagnostics() {
        const snapshot = debug.captureDiagnostics();
        if (!phone) {
          return snapshot;
        }
        const metrics = snapshot.state['metrics'];
        const performance = sanitizeDebugDiagnostics(
          { state: phone.readDiagnostics(), recentLogs: [] },
          [readStoredResumeName(), readStoredResumeToken()].filter((value): value is string =>
            Boolean(value)
          )
        ).state;
        snapshot.state['metrics'] = {
          ...(metrics !== null && typeof metrics === 'object' && !Array.isArray(metrics)
            ? metrics
            : {}),
          performance,
        };
        return snapshot;
      },
      startPhoneCollection(device, conditions) {
        if (!disposed) {
          void phone?.start(device, conditions);
        }
      },
      stopPhoneCollection() {
        if (!disposed) {
          phone?.stop();
        }
      },
      recoverPhoneCollection() {
        if (!disposed) {
          void phone?.recover();
        }
      },
      downloadPhoneCollection() {
        return disposed || !phone ? Promise.resolve(null) : phone.download();
      },
      openInventory() {
        if (!disposed) {
          openInventory(isPlayViewOn());
        }
      },
      closeInventory() {
        if (!disposed) {
          closeGameOverlay('inventory');
        }
      },
      inventoryPage(page) {
        if (!disposed && isGameOverlayOpen('inventory')) {
          inventoryPage = readInventoryView(page).page;
          presentation.transition();
        }
      },
      equipSatellite(id) {
        if (!disposed && isGameOverlayOpen('inventory')) {
          equipInventorySatellite(id);
          presentation.transition();
        }
      },
      equipUtility(id) {
        if (!disposed && isGameOverlayOpen('inventory')) {
          equipInventoryUtility(id);
          presentation.transition();
        }
      },
      drawInventory(hull, tool) {
        if (disposed || !isGameOverlayOpen('inventory')) {
          return { refresh() {}, dispose() {} };
        }
        const painter = mountShipSchematicCanvases(hull, tool, readSchematicSelection);
        let active = true;
        const disposePainter = () => {
          if (active) {
            active = false;
            painters.delete(disposePainter);
            painter.dispose();
          }
        };
        painters.add(disposePainter);
        return {
          refresh: () => {
            if (active && !disposed) {
              painter.refresh();
            }
          },
          dispose: disposePainter,
        };
      },
      join(name) {
        if (disposed || joining) {
          return;
        }
        // No await or import before this call: preserve the accepted user gesture.
        activateAudio();
        joining = true;
        joinError = null;
        failureNotice = null;
        presentation.transition();
        const pilotName = sanitizePlayerName(name.trim()) || fallbackName;
        void controller
          .startGame(pilotName, getSelectedShipKitId())
          .then(
            () => {
              if (!disposed && !controller.getIsGameRunning()) {
                joinError = 'The game could not join the server. Please try again.';
              }
            },
            () => {
              if (!disposed) {
                joinError = 'Cannot connect to the game server. Please try again.';
              }
            }
          )
          .finally(() => {
            if (!disposed) {
              joining = false;
              presentation.transition();
            }
          });
      },
      selectShip(kit) {
        if (disposed || joining) {
          return;
        }
        activateAudio();
        const changed = getSelectedShipKitId() !== kit;
        setSelectedShipKitId(kit);
        if (changed) {
          playFeedback('interface');
        }
        presentation.transition();
      },
      setPreference(kind, enabled) {
        if (disposed || joining) {
          return;
        }
        if (kind === 'sound') {
          setSound(enabled);
        } else if (kind === 'music') {
          setMusic(enabled);
        } else {
          setHaptics(enabled);
        }
        presentation.transition();
      },
    };
    return { commands, subscribe: presentation.subscribe, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

import.meta.hot?.dispose(() => activeRuntime?.());
