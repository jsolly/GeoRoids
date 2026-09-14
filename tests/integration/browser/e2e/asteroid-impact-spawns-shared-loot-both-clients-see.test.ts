import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GROWTH } from '../../../../shared/shipGrowth';
import { DAMAGE } from '../../../../src/constants';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAsteroidDeathMessage(message: unknown, targetPlayerId: string): boolean {
  if (!isRecord(message) || message['type'] !== 'playerDamaged') {
    return false;
  }
  const data = message['data'];
  return (
    isRecord(data) &&
    data['targetPlayerId'] === targetPlayerId &&
    data['attackerId'] === 'asteroid' &&
    data['damage'] === DAMAGE.ASTEROID_COLLISION &&
    data['remainingHealth'] === 0 &&
    data['isDestroyed'] === true
  );
}

test(
  'an asteroid impact drops shared crew loot that another pilot can collect',
  async () => {
    const impactedPilotPage = browserManager.getCurrentPage();
    if (!impactedPilotPage) {
      throw new Error('Impact page is not available');
    }
    const collectorPage = await browserManager.createPage();
    const impactedPilotDiagnostics = watchBrowserDiagnostics(impactedPilotPage);
    const collectorDiagnostics = watchBrowserDiagnostics(collectorPage);
    const impactedPilot = new GameInteractions(impactedPilotPage);
    const collector = new GameInteractions(collectorPage);
    const damageMessages: unknown[] = [];
    impactedPilotPage.on('websocket', (socket) => {
      if (!/\/ws(?:\?|$)/.test(socket.url())) {
        return;
      }
      socket.on('framereceived', ({ payload }) => {
        try {
          const message: unknown = JSON.parse(String(payload));
          if (isRecord(message) && message['type'] === 'playerDamaged') {
            damageMessages.push(message);
          }
        } catch {
          // Snapshot frames are handled by the client decoder; this observer
          // only needs the small JSON damage event.
        }
      });
    });

    await impactedPilot.bootGame({ kitId: 'hauler', waitForCombatReady: false });
    await collector.bootGame({ kitId: 'surveyor', waitForCombatReady: false });
    const [impactedPilotId, collectorId] = await Promise.all([
      impactedPilot.getLocalPlayerId(),
      collector.getLocalPlayerId(),
    ]);
    await Promise.all([
      impactedPilot.waitForRemoteHumanPlayers(1),
      collector.waitForRemoteHumanPlayers(1),
    ]);

    const livesBefore = await impactedPilot.getLives();
    const scoreBefore = await collector.getScore();
    const knownLoot = new Set((await collector.getLoot()).map((drop) => drop.id));
    damageMessages.length = 0;

    // Start the first pilot at one impact's worth of health, then let the
    // real asteroid collision loop kill it and publish wreckage to both clients.
    await arrangeCrewField([impactedPilotId, collectorId], 'impact');

    await expect
      .poll(() => impactedPilot.getLives(), {
        timeout: 8000,
        message: 'the fixture asteroid should cost the impacted pilot one life',
      })
      .toBeLessThan(livesBefore);

    await expect
      .poll(
        () => damageMessages.some((message) => isAsteroidDeathMessage(message, impactedPilotId)),
        {
          timeout: 8000,
          message: 'the fixture death should report the authoritative asteroid damage event',
        }
      )
      .toBe(true);

    const deathPosition = await collector.getNetworkPlayerPosition(impactedPilotId);
    assert.ok(deathPosition, 'the collector should receive the impacted pilot position');

    const isImpactWreckage = (
      drop: Awaited<ReturnType<GameInteractions['getLoot']>>[number]
    ): boolean => {
      const scatter = Math.hypot(drop.x - deathPosition.x, drop.y - deathPosition.y);
      return (
        drop.kind === 'wreckage' &&
        drop.id.startsWith('loot-') &&
        !knownLoot.has(drop.id) &&
        scatter >= GROWTH.SCATTER_MIN - 0.001 &&
        scatter <= GROWTH.SCATTER_MAX + 0.001
      );
    };

    await expect
      .poll(
        async () => {
          const [impactedPilotLoot, collectorLoot] = await Promise.all([
            impactedPilot.getLoot(),
            collector.getLoot(),
          ]);
          const impactedPilotIds = impactedPilotLoot
            .filter(isImpactWreckage)
            .map((drop) => drop.id)
            .sort();
          const collectorIds = collectorLoot
            .filter(isImpactWreckage)
            .map((drop) => drop.id)
            .sort();
          return (
            impactedPilotIds.length > 0 && impactedPilotIds.join(',') === collectorIds.join(',')
          );
        },
        {
          timeout: 8000,
          message: 'both clients should receive the wreckage from the environmental impact',
        }
      )
      .toBe(true);

    const sharedLoot = (await collector.getLoot()).filter(isImpactWreckage);
    expect(sharedLoot.length).toBeGreaterThan(0);
    const impactedPilotView = await impactedPilot.getLoot();
    for (const drop of sharedLoot) {
      const peer = impactedPilotView.find((other) => other.id === drop.id);
      assert.ok(peer, `impactedPilot view is missing shared loot ${drop.id}`);
      expect(Math.abs(peer.x - drop.x)).toBeLessThan(8);
      expect(Math.abs(peer.y - drop.y)).toBeLessThan(8);
    }

    await collectorPage.screenshot({
      path: screenshotManager.getScreenshotPath('asteroid-impact-shared-loot.png'),
    });

    const pellet = sharedLoot[0];
    assert.ok(pellet, 'shared impact wreckage is required for collection');
    const startMass = await collector.getShipMass();
    const startRadius = await collector.getShipRadius();
    const startMaxHealth = await collector.getShipMaxHealth();
    await collector.placeShipAt(pellet.x, pellet.y);
    await expect
      .poll(async () => (await collector.getLoot()).some((drop) => drop.id === pellet.id), {
        timeout: 8000,
        message: 'the collector should remove the shared wreckage after pickup',
      })
      .toBe(false);

    await expect
      .poll(() => collector.getShipMass(), {
        timeout: 8000,
        message: 'the collector should grow after picking up environmental loot',
      })
      .toBeGreaterThan(startMass);
    expect(await collector.getShipRadius()).toBeGreaterThan(startRadius);
    expect(await collector.getShipMaxHealth()).toBeGreaterThan(startMaxHealth);
    expect(await collector.getScore()).toBe(scoreBefore);

    assertNoBrowserDiagnostics(impactedPilotDiagnostics);
    assertNoBrowserDiagnostics(collectorDiagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
