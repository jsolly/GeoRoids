// @vitest-environment node
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import type { SpiderFieldState } from '../../../../shared-types';
import { HAULER_UTILITY_STORAGE_KEY } from '../../../../src/entities/ship/haulerUtility';
import { getShipKit } from '../../../../src/entities/ship/shipKits';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { withFixtureEvidence } from '../../utils/fixture-evidence';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField, getFixtureState, placePlayer } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);
function field(page: Page): Promise<SpiderFieldState> {
  return page.evaluate(
    "import('/src/physics/terrain/spiderSession.ts').then(m => m.getSpiderField())"
  );
}

function captureFailure(scenario: unknown, capture: unknown): AggregateError {
  return new AggregateError([scenario, capture], 'Tow scenario and evidence capture failed', {
    cause: scenario,
  });
}
async function joinPilot(page: Page, game: GameInteractions, owner: boolean) {
  await page.addInitScript(() => {
    const events: unknown[] = [];
    for (const kind of ['pointerdown', 'pointerup', 'keydown']) {
      document.addEventListener(
        kind,
        (event) => {
          events.push({
            kind,
            at: performance.now(),
            trusted: event.isTrusted,
            target: event.target instanceof Element ? event.target.id : null,
            key: event instanceof KeyboardEvent ? event.key : null,
          });
          document.documentElement.dataset['towGestures'] = JSON.stringify(events);
        },
        true
      );
    }
  });
  await game.navigateToGame();
  await page.locator('#playerNameInput').fill(owner ? 'Tow owner' : 'Tow witness');
  await page.locator(`[data-kit-id="${owner ? 'hauler' : 'scout'}"]`).click();
  if (owner) {
    await page.evaluate(
      (key) => localStorage.setItem(key, 'tow_cable'),
      HAULER_UTILITY_STORAGE_KEY
    );
  }
  await game.startGame();
  await game.waitForGameReady();
  await game.waitForServerJoin();
}
async function clearAdmission(games: GameInteractions[]) {
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
      actor &&
        !actor.exploding &&
        actor.socketState === 1 &&
        actor.health === getShipKit(actor.kitId).maxHealth,
      `Tow pilot must join live at full kit health: ${JSON.stringify({ id, actor })}`
    );
  }
}
function clientEvidence(page: Page) {
  return page.evaluate(() => {
    const ship = window.gameController?.getCurrPlayer()?.ship;
    const ability = document.querySelector('#touch-ability');
    return {
      playerId: window.gameController?.getNetworkManager().getLocalPlayerId(),
      ship: ship
        ? {
            health: ship.health,
            maxHealth: ship.maxHealth,
            position: ship.position,
            epoch: ship.playerMotion?.epoch,
            protection: ship.blinkCount,
            kitId: ship.kitId,
            utility: ship.haulerUtility,
            cooldown: ship.abilityCooldownFrames,
            target: ship.harpoonTargetId,
            exploding: ship.exploding,
          }
        : null,
      ability: {
        visible: ability instanceof HTMLElement && ability.offsetWidth > 0,
        disabled: ability?.getAttribute('aria-disabled'),
      },
      gestures: JSON.parse(document.documentElement.dataset['towGestures'] ?? '[]'),
      remote: window.gameController
        ?.getPlayerManager()
        .getNonLocalPlayers()
        .map((player) => ({
          id: player.id,
          health: player.ship.health,
          target: player.ship.harpoonTargetId,
        })),
    };
  });
}

for (const width of [1280, 390]) {
  for (const victim of ['passer', 'hauler'] as const) {
    test(`a towed spider bites the ${victim} within reach at ${width}px`, async () => {
      const page = await browserManager.recreatePage({ hasTouch: width === 390 });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const diagnostics = watchBrowserDiagnostics(page);
      const game = new GameInteractions(page);
      const games = [game];
      const pages = [page];
      let evidence: unknown = { phase: 'not-admitted' };
      let release: Awaited<ReturnType<typeof placePlayer>> | null = null;
      const capture = async () => {
        const results = await Promise.allSettled(pages.map(clientEvidence));
        const clients = results.map((result) =>
          result.status === 'fulfilled' ? result.value : { captureFailure: String(result.reason) }
        );
        const capturedAt = Date.now();
        evidence = { capturedAt, clients, release };
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Tow client evidence capture failed');
        }
        evidence = { capturedAt, clients, release, server: await getFixtureState() };
      };
      await withFixtureEvidence(
        page,
        `tow-bite-${victim}-${width}`,
        async (stage) => {
          const record = async (name: string) => {
            await capture();
            await stage(name);
          };
          try {
            await joinPilot(page, game, true);
            await clearAdmission(games);
            await record('owner-admitted');
            const otherPage = await browserManager.createAdditionalPage();
            const otherDiagnostics = watchBrowserDiagnostics(otherPage);
            const other = new GameInteractions(otherPage);
            pages.push(otherPage);
            await joinPilot(otherPage, other, false);
            games.push(other);
            await clearAdmission(games);
            await Promise.all(games.map((pilot) => pilot.waitForRemotePlayers(1)));
            await record('crew-admitted');
            const ownerId = await game.getLocalPlayerId();
            const passerId = await other.getLocalPlayerId();
            const epochs = await arrangeCrewField([ownerId, passerId], 'spider-tow-bite');
            await Promise.all(
              games.map((pilot, index) =>
                pilot.waitForControlledFixture(epochs.get(index === 0 ? ownerId : passerId))
              )
            );
            await Promise.all(
              pages.map((peer) =>
                expect
                  .poll(() =>
                    peer.evaluate(() => {
                      const ship = window.gameController?.getCurrPlayer()?.ship;
                      return Boolean(ship && !ship.exploding && ship.health === ship.maxHealth);
                    })
                  )
                  .toBe(true)
              )
            );
            await record('protected-tow-scene');
            await expect.poll(async () => (await field(page)).spiders.length).toBe(1);
            const captive = (await field(page)).spiders[0];
            if (!captive) {
              throw new Error('Missing captive');
            }
            await expect
              .poll(() =>
                page.evaluate(() => {
                  const ship = window.gameController?.getCurrPlayer()?.ship;
                  return (
                    ship?.kitId === 'hauler' &&
                    ship.haulerUtility === 'tow_cable' &&
                    !ship.exploding &&
                    ship.health === ship.maxHealth &&
                    ship.abilityCooldownFrames === 0
                  );
                })
              )
              .toBe(true);
            const admitted = await getFixtureState();
            for (const id of [ownerId, passerId]) {
              const actor = admitted.players.find((pilot) => pilot.id === id);
              assert.ok(
                actor &&
                  actor.motionEpoch === epochs.get(id) &&
                  actor.spawnProtectionTimer > 0 &&
                  actor.health === getShipKit(actor.kitId).maxHealth &&
                  actor.socketState === 1 &&
                  !actor.exploding,
                'Protected tow admission changed'
              );
            }
            await record('before-real-gesture');
            if (width === 390) {
              await page.locator('#touch-ability').tap();
            } else {
              await page.keyboard.press('e');
            }
            await record('after-real-gesture');
            const latch = () =>
              page.evaluate(() => window.gameController?.getCurrPlayer()?.ship.harpoonTargetId);
            await expect.poll(latch).toBe(captive.id);
            await expect
              .poll(() =>
                otherPage.evaluate(
                  (id) =>
                    window.gameController
                      ?.getPlayerManager()
                      .getNonLocalPlayers()
                      .find((p) => p.id === id)?.ship.harpoonTargetId,
                  ownerId
                )
              )
              .toBe(captive.id);
            const attached = await getFixtureState();
            const owner = attached.players.find((pilot) => pilot.id === ownerId);
            assert.ok(
              owner &&
                owner.harpoonTargetId === captive.id &&
                owner.spawnProtectionTimer > 0 &&
                owner.health === getShipKit(owner.kitId).maxHealth &&
                owner.socketState === 1 &&
                !owner.exploding,
              'Authoritative protected tow missing'
            );
            expect(
              attached.spiderField.spiders.find((spider) => spider.id === captive.id)?.towedBy
            ).toBe(ownerId);
            await record('protected-latch-confirmed');
            const target = victim === 'hauler' ? game : other;
            const targetId = victim === 'hauler' ? ownerId : passerId;
            const targetPage = victim === 'hauler' ? page : otherPage;
            await page.screenshot({
              path: screenshotManager.getScreenshotPath(
                `towed-spider-before-${victim}-${width}.png`
              ),
            });
            const live = (await field(page)).spiders.find((s) => s.id === captive.id);
            if (!live) {
              throw new Error('Captive disappeared');
            }
            // Put the real connected ship into reach; server combat must produce and broadcast the bite.
            release = await placePlayer(targetId, live.position, {
              clearSpawnProtection: true,
              expectedTowTargetId: captive.id,
            });
            assert.ok(
              release.motionEpoch !== undefined &&
                release.spawnProtectionCleared &&
                release.spawnProtectionTimer === 0,
              'Atomic combat release receipt missing'
            );
            expect(release.towOwnerId).toBe(ownerId);
            expect(release.towTargetId).toBe(captive.id);
            expect(release.expectedTowTargetId).toBe(captive.id);
            expect(release.placedActorTowTargetId).toBe(victim === 'hauler' ? captive.id : null);
            // Observe both clients before evidence capture can outlast the death animation.
            const witness = victim === 'hauler' ? otherPage : page;
            await Promise.all([
              expect
                .poll(
                  () =>
                    targetPage.evaluate(() => window.gameController?.getCurrPlayer()?.ship.health),
                  { interval: 25 }
                )
                .toBe(0),
              expect
                .poll(() =>
                  witness.evaluate(
                    (id) =>
                      window.gameController
                        ?.getPlayerManager()
                        .getNonLocalPlayers()
                        .find((p) => p.id === id)?.ship.health,
                    targetId
                  )
                )
                .toBe(0),
            ]);
            await record('victim-released');
            if (victim === 'passer') {
              expect(await latch()).toBe(captive.id);
            }
            await page.screenshot({
              path: screenshotManager.getScreenshotPath(`towed-spider-bite-${victim}-${width}.png`),
            });
            await record('real-bite-observed');
            await target.waitForShipAlive(25000);
            expect(await target.isGameRunning()).toBe(true);
            await page.goto(`${TestConfig.GAME_URL}/wiki/#hauler`);
            const rule = page.locator('p').filter({ hasText: 'A towed spider can still bite' });
            await rule.scrollIntoViewIfNeeded();
            await page.screenshot({
              path: screenshotManager.getScreenshotPath(`towed-spider-wiki-${victim}-${width}.png`),
            });
            assertNoBrowserDiagnostics(diagnostics);
            assertNoBrowserDiagnostics(otherDiagnostics);
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
        { evidence: () => evidence }
      );
    }, 45000);
  }
}
