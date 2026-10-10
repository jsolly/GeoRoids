import { boundedDiagnosticError } from '../../shared/stateDiagnostics';
import { activateAudio, disposeAudioRuntime } from '../audio/audioRuntime';
import { playFeedback } from '../audio/feedbackSounds';
import { disposeMusicBeds, mountMusicBeds, setMusic } from '../audio/musicBeds';
import { setSound } from '../audio/Sound';
import { musicIsOn, soundIsOn } from '../constants/user-preferences';
import { EventLoop } from '../core/eventLoop';
import { GameController } from '../core/gameController';
import { clientPerformance, mountPerformanceMetrics } from '../diagnostics/performanceMetrics';
import { PlayerManager } from '../entities/player/PlayerManager';
import { SatellitePickupManager } from '../entities/satellitePickup/SatellitePickupManager';
import { hapticsApiAvailable, hapticsPreferenceOn, setHaptics } from '../fx/haptics';
import { readStoredResumeName } from '../network/services/resumeCredential';
import { mountClientRelease } from '../release/clientReleaseEntry';
import { canvasManager, type PlayfieldGeometry } from '../rendering/canvasSurface';
import { mountShipSchematicCanvases } from '../rendering/shipSchematicCanvas';
import { initTitleTerrain } from '../rendering/titleTerrain';
import { disposeDebugHud, mountDebugHud, paintDebugHud } from '../ui/debugHud';
import { disposeDebugIdentity, mountDebugIdentity } from '../ui/debugIdentity';
import { mountFieldHints } from '../ui/fieldHint';
import { disposeNetworkStatusUI, initNetworkStatusUI } from '../ui/networkStatus';
import { disposeSchematicEquipHint, initializeSchematicEquipHint } from '../ui/schematicEquipHint';
import { mountSpawnFlyIn, stopSpawnFlyIn } from '../ui/spawnFlyIn';
import { getBuildInfoString } from '../utils/buildInfo';
import { applyLockedPaletteCss } from '../utils/colorUtils';
import { disposeGlobalErrorLogging, installGlobalErrorLogging } from '../utils/globalErrorLogging';
import { logger } from '../utils/Logger';
import { generatePilotNickname } from '../utils/pilotNickname';
import { sanitizePlayerName } from '../utils/playerName';
import {
  equipInventorySatellite,
  equipInventoryUtility,
  readInventoryView,
  readSchematicSelection,
} from './inventory';
import { mountInventoryShortcuts, openInventory } from './inventoryOverlay';
import { type LegacyHosts, mountLegacyHosts } from './legacyHosts';
import {
  closeGameOverlay,
  getOpenGameOverlay,
  isGameOverlayOpen,
  subscribeGameOverlay,
} from './overlayState';
import { createPresentation, type PresentationSubscription } from './presentation';
import { getSelectedShipKitId, setSelectedShipKitId } from './shipSelection';
import {
  closeTownStore,
  mountTownStore,
  openTownStore,
  purchaseTownOffer,
  readTownStoreView,
  selectTownView,
  subscribeTownStore,
} from './townStore';
import { mountTownTravelHost } from './townTravelHost';
import type { GameCommands, GamePresentation } from './uiTypes';

export interface GameRuntime extends PresentationSubscription<GamePresentation> {
  readonly commands: GameCommands;
  dispose(): void;
}

export interface GameRuntimeHosts extends LegacyHosts {
  readonly canvas: HTMLCanvasElement;
  readonly titleCanvas: HTMLCanvasElement;
  readonly collector: HTMLElement;
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
  const cleanup: (() => void)[] = [];
  const painters = new Set<() => void>();
  const travelHosts = new Set<ReturnType<typeof mountTownTravelHost>>();
  cleanup.push(() => {
    for (const stop of painters) {
      stop();
    }
    painters.clear();
    for (const host of travelHosts) {
      host.dispose();
    }
    travelHosts.clear();
  });
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const stop of cleanup.reverse()) {
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
    cleanup.push(mountClientRelease());
    cleanup.push(mountLegacyHosts(hosts));
    cleanup.push(mountFieldHints(hosts.legacyOverlay));
    const spawnHost = hosts.legacyPlay.querySelector<HTMLElement>('#spawn-fly-in-host');
    if (!spawnHost) {
      throw new Error('The spawn canvas host is missing.');
    }
    cleanup.push(mountSpawnFlyIn(spawnHost));
    cleanup.push(disposeGlobalErrorLogging);
    installGlobalErrorLogging();
    cleanup.push(disposeAudioRuntime, disposeMusicBeds);
    mountMusicBeds();
    cleanup.push(mountPerformanceMetrics(hosts.collector));
    cleanup.push(disposeSchematicEquipHint);
    initializeSchematicEquipHint();
    cleanup.push(disposeNetworkStatusUI);
    initNetworkStatusUI(hosts.legacyOverlay);
    cleanup.push(disposeDebugIdentity, disposeDebugHud);
    mountDebugIdentity();
    mountDebugHud();
    applyLockedPaletteCss();
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
    let inPlay = false;
    let inventoryPage = 0;
    const project = (): GamePresentation =>
      Object.freeze({
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
        inPlay,
        joining,
        joinError,
        failureNotice,
        overlay: getOpenGameOverlay(),
        inventory: isGameOverlayOpen('inventory') ? readInventoryView(inventoryPage) : null,
        townStore: isGameOverlayOpen('town-store') ? readTownStoreView() : null,
      });
    const presentation = createPresentation(
      project,
      (previous, next) => JSON.stringify(previous) === JSON.stringify(next)
    );
    cleanup.push(() => presentation.dispose());
    cleanup.push(
      subscribeGameOverlay((next, previous) => {
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
    cleanup.push(mountInventoryShortcuts(() => inPlay));
    cleanup.push(subscribeTownStore(() => presentation.transition()));
    cleanup.push(mountTownStore());
    let nextTravelRefresh = 0;
    const events = new AbortController();
    cleanup.push(() => events.abort());
    window.addEventListener(
      'playViewOn',
      () => {
        inPlay = true;
        presentation.transition();
      },
      { signal: events.signal }
    );
    window.addEventListener(
      'playViewOff',
      () => {
        inPlay = false;
        const overlay = getOpenGameOverlay();
        if (overlay !== null) {
          closeGameOverlay(overlay);
        }
        presentation.transition();
      },
      { signal: events.signal }
    );
    const eventLoop = new EventLoop(controller, {
      window,
      document,
      requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
      cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
      now: () => performance.now(),
      paintDebugHud,
      observeRenderer: () =>
        clientPerformance.recordRendererFrame(canvasManager.getRendererBackend()),
      present: (now) => {
        presentation.sample(now);
        if (now >= nextTravelRefresh) {
          nextTravelRefresh = now + 100;
          for (const host of travelHosts) {
            host.refresh();
          }
        }
      },
      reportFailure(error) {
        logger.error(
          'STATE',
          'game_loop_failed',
          boundedDiagnosticError(error, 'Unknown game runtime failure'),
          { observedAt: Date.now() }
        );
        failureNotice = 'An unexpected error occurred. Enter the game again to restart.';
        inPlay = false;
        const overlay = getOpenGameOverlay();
        if (overlay !== null) {
          closeGameOverlay(overlay);
        }
        presentation.transition();
      },
    });
    cleanup.push(() => eventLoop.dispose());
    const commands: GameCommands = {
      openTownStore() {
        if (!disposed) {
          openTownStore();
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
      mountTownTravel(host) {
        if (disposed || !isGameOverlayOpen('town-store')) {
          return () => {};
        }
        const mounted = mountTownTravelHost(host);
        travelHosts.add(mounted);
        return () => {
          mounted.dispose();
          travelHosts.delete(mounted);
        };
      },
      openInventory() {
        if (!disposed) {
          openInventory(inPlay);
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
