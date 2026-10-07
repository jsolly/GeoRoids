// @vitest-environment node
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { DAMAGE } from '../../../../src/constants';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewFieldWithEvidence } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
const WS_PATH_PATTERN = /\/ws(?:\?|$)/u;

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
  'an asteroid impact respawns the pilot without leaving debris for either client',
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
      if (!WS_PATH_PATTERN.test(socket.url())) {
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
    await collector.bootGame({ kitId: 'scout', waitForCombatReady: false });
    const [impactedPilotId, collectorId] = await Promise.all([
      impactedPilot.getLocalPlayerId(),
      collector.getLocalPlayerId(),
    ]);
    await Promise.all([impactedPilot.waitForRemotePlayers(1), collector.waitForRemotePlayers(1)]);

    const healthBefore = await impactedPilot.getShipHealth();
    expect(healthBefore).toBeGreaterThan(0);
    damageMessages.length = 0;

    // Start the first pilot at one impact's worth of health, then let the
    // real asteroid collision loop kill it and publish the death to the crew.
    await arrangeCrewFieldWithEvidence([impactedPilotId, collectorId], 'delivery');
    const fixture = await arrangeCrewFieldWithEvidence([impactedPilotId, collectorId], 'impact');
    // Respawn can finish before either browser observes the death. Retain the
    // acknowledged impact pose instead of reading the pilot's latest pose.
    const deathPosition = fixture.positions.get(impactedPilotId);
    assert.ok(deathPosition, 'the fixture should acknowledge the impacted pilot position');

    await expect
      .poll(
        () => damageMessages.some((message) => isAsteroidDeathMessage(message, impactedPilotId)),
        {
          timeout: 8000,
          message: 'the fixture death should report the authoritative asteroid damage event',
        }
      )
      .toBe(true);

    await impactedPilot.waitForShipAlive();
    const [victimLoot, peerLoot] = await Promise.all([
      impactedPilot.getLoot(),
      collector.getLoot(),
    ]);
    // Ramming also breaks the ore rock: keep its one cargo pickup and shard.
    // Ship death must contribute no additional pickup.
    const atImpact = (loot: typeof victimLoot) =>
      loot
        .filter((drop) => Math.hypot(drop.x - deathPosition.x, drop.y - deathPosition.y) < 60)
        .map((drop) => drop.kind)
        .sort();
    expect(atImpact(victimLoot)).toEqual(['points', 'shard']);
    expect(atImpact(peerLoot)).toEqual(['points', 'shard']);
    expect(await impactedPilot.getCargo()).toBe(0);
    expect(await impactedPilot.isGameRunning()).toBe(true);
    await collectorPage.screenshot({
      path: screenshotManager.getScreenshotPath('asteroid-impact-without-debris.png'),
    });
    assertNoBrowserDiagnostics(impactedPilotDiagnostics);
    assertNoBrowserDiagnostics(collectorDiagnostics);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
