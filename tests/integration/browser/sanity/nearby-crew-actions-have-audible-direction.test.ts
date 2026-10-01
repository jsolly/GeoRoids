// @vitest-environment node
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { SHIP } from '../../../../src/constants';
import { installAudioProbe, readSampleDuration } from '../../utils/audio-probe';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { withFixtureEvidence } from '../../utils/fixture-evidence';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField, getFixtureState } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

function captureFailure(scenario: unknown, capture: unknown): AggregateError {
  return new AggregateError(
    [scenario, capture],
    'Audio scenario and fresh evidence capture failed',
    { cause: scenario }
  );
}

function decodedSamplesReady(page: Page, durations: number[]): Promise<boolean> {
  return page.evaluate((required) => {
    const decoded: number[] = JSON.parse(
      document.documentElement.dataset['decodedAudioDurations'] ?? '[]'
    );
    return required.every((duration) =>
      decoded.some((value) => Math.abs(value - duration) < 0.00001)
    );
  }, durations);
}

async function positionsForSample(page: Page, name: string) {
  const duration = await readSampleDuration(page, name);
  return page.evaluate((sampleDuration) => {
    const events: Array<{
      duration: number;
      position?: { x: number; z: number; model: string; rolloff: number };
    }> = JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]');
    return events
      .filter((event) => Math.abs(event.duration - sampleDuration) < 0.00001)
      .map((event) => event.position);
  }, duration);
}

test.each([1280, 390])(
  'nearby crew shots and mining have independent HRTF directions at %i pixels',
  async (width) => {
    const listenerPage = browserManager.getCurrentPage();
    assert.ok(listenerPage);
    await listenerPage.setViewportSize({ width, height: 900 });
    const diagnostics = [watchBrowserDiagnostics(listenerPage)];
    await installAudioProbe(listenerPage);
    const listener = new GameInteractions(listenerPage);
    const games = [listener];
    let admitted = false;
    let evidence: unknown = { phase: 'not-admitted' };
    const capture = async () => {
      const audio = await listenerPage.evaluate(() => {
        document.dispatchEvent(new Event('georoids-audio-probe-snapshot'));
        const data = document.documentElement.dataset;
        return Object.fromEntries(
          [
            'audioEvents',
            'audioLifecycle',
            'audioLifecycleDropped',
            'nativeAudioSources',
            'nativeAudioContexts',
            'decodedAudioDurations',
            'audioContextStates',
          ].map((key) => [key, JSON.parse(data[key] ?? 'null')])
        );
      });
      const capturedAt = Date.now();
      evidence = { capturedAt, audio };
      if (admitted) {
        assert.ok(
          Array.isArray(audio['audioEvents']) &&
            Array.isArray(audio['audioLifecycle']) &&
            Array.isArray(audio['nativeAudioContexts']) &&
            audio['nativeAudioContexts'].length > 0,
          'Admitted audio scene requires native probe evidence'
        );
      }
      evidence = {
        capturedAt,
        audio,
        fixture: await getFixtureState(['crew-fixture-ore']),
      };
    };
    const admit = async () => {
      const ids = await Promise.all(games.map((game) => game.getLocalPlayerId()));
      const epochs = await arrangeCrewField(ids, 'empty');
      await Promise.all(
        games.map(async (game, index) => {
          await game.waitForControlledFixture(epochs.get(ids[index] ?? ''));
          await game.placeControlledShipAt(index * 120, -360);
        })
      );
      const state = await getFixtureState();
      for (const id of ids) {
        const actor = state.players.find((player) => player.id === id);
        assert.ok(
          actor && actor.health === SHIP.MAX_HEALTH && !actor.exploding && actor.socketState === 1,
          `Audio crew must join live at full health: ${JSON.stringify({ id, actor })}`
        );
      }
      await Promise.all(games.map((game) => game.waitForShipHealth(SHIP.MAX_HEALTH)));
    };
    const join = async (game: GameInteractions, page: Page, name: string) => {
      await game.navigateToGame();
      await page.locator('#playerNameInput').fill(name);
      await page.locator('[data-kit-id="scout"]').click();
      await game.startGame();
      await game.waitForGameReady();
      await game.waitForServerJoin();
    };
    await withFixtureEvidence(
      listenerPage,
      `spatial-audio-${width}`,
      async (stage) => {
        const record = async (name: string) => {
          await capture();
          await stage(name);
        };
        try {
          await record('before-admission');
          await join(listener, listenerPage, 'Audio listener');
          await admit();
          admitted = true;
          await record('listener-admitted');
          const shooterPage = await browserManager.createAdditionalPage();
          diagnostics.push(watchBrowserDiagnostics(shooterPage));
          const shooter = new GameInteractions(shooterPage);
          await join(shooter, shooterPage, 'Audio shooter');
          games.push(shooter);
          await admit();
          await Promise.all(games.map((game) => game.waitForRemotePlayers(1)));
          const ids = await Promise.all(games.map((game) => game.getLocalPlayerId()));
          await Promise.all(games.map((game) => game.waitForCombatReady()));
          await record('crew-admitted');
          // Wait for the two samples this scenario uses, not the global bank size.
          const requiredDurations = await Promise.all(
            ['laser', 'asteroid-explode'].map((name) => readSampleDuration(listenerPage, name))
          );
          await expect.poll(() => decodedSamplesReady(listenerPage, requiredDurations)).toBe(true);
          const listenerId = ids[0];
          assert.ok(listenerId);
          await shooter.fireLaserAtRemotePlayer(listenerId, 110);
          await expect
            .poll(async () => (await positionsForSample(listenerPage, 'laser')).length)
            .toBe(1);
          await shooter.fireLaserAtRemotePlayer(listenerId, -110);
          await expect
            .poll(async () => (await positionsForSample(listenerPage, 'laser')).length)
            .toBe(2);
          const shots = await positionsForSample(listenerPage, 'laser');
          expect(shots[0]?.x).toBeLessThan(0);
          expect(shots[1]?.x).toBeGreaterThan(0);
          expect(
            shots.every((position) => position?.model === 'HRTF' && position.rolloff === 0)
          ).toBe(true);

          await record('before-mining');
          const miningEpochs = await arrangeCrewField(ids, 'mining');
          await Promise.all(
            games.map((game, index) =>
              game.waitForControlledFixture(miningEpochs.get(ids[index] ?? ''))
            )
          );
          await listener.placeControlledShipAt(120, -460);
          // The fixture response does not wait for the shooter's next snapshot.
          await expect
            .poll(async () => (await shooter.getAsteroidPositions()).map((asteroid) => asteroid.id))
            .toContain('crew-fixture-ore');
          const rock = (await shooter.getAsteroidPositions()).find(
            (asteroid) => asteroid.id === 'crew-fixture-ore'
          );
          assert.ok(rock);
          await record('mining-admitted');
          await shooter.destroyAsteroidWithLaser(rock);
          await record('target-removed');
          await expect
            .poll(async () => (await positionsForSample(listenerPage, 'asteroid-explode')).length)
            .toBe(1);
          const [impact] = await positionsForSample(listenerPage, 'asteroid-explode');
          expect(impact?.x).toBeLessThan(0);
          expect(impact?.model).toBe('HRTF');
          await listenerPage.screenshot({
            path: screenshotManager.getScreenshotPath(`spatial-audio-${width}.png`),
          });
          for (const diagnostic of diagnostics) {
            assertNoBrowserDiagnostics(diagnostic);
          }
          await record('scenario-teardown');
        } catch (error) {
          try {
            await capture();
          } catch (captureError) {
            throw captureFailure(error, captureError);
          }
          throw error;
        }
      },
      { asteroidIds: () => ['crew-fixture-ore'], evidence: () => evidence }
    );
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);

test(
  'the shipped laser renders louder in the nearer ear with native HRTF',
  async () => {
    const page = browserManager.getCurrentPage();
    assert.ok(page);
    await page.goto(TestConfig.GAME_URL);
    const energies = await page.evaluate(async () => {
      const bytes = await (await fetch('/sounds/laser.m4a')).arrayBuffer();
      const results: number[][] = [];
      for (const x of [-2, 2]) {
        const context = new OfflineAudioContext(2, 48000, 48000);
        const source = context.createBufferSource();
        source.buffer = await context.decodeAudioData(bytes.slice(0));
        const pan = context.createPanner();
        pan.panningModel = 'HRTF';
        pan.rolloffFactor = 0;
        pan.positionX.value = x;
        pan.positionZ.value = -1;
        source.connect(pan).connect(context.destination);
        source.start(0.1);
        const rendered = await context.startRendering();
        results.push(
          [0, 1].map((channel) =>
            rendered.getChannelData(channel).reduce((sum, value) => sum + value * value, 0)
          )
        );
      }
      return results;
    });
    const left = energies[0];
    const right = energies[1];
    assert.ok(left?.[0] && left[1] && right?.[0] && right[1]);
    expect(left[0]).toBeGreaterThan(left[1] * 1.2);
    expect(right[1]).toBeGreaterThan(right[0] * 1.2);
  },
  TestConfig.DEFAULT_TIMEOUT
);
