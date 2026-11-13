import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, Page } from 'playwright';
import { summarizePhoneRecording } from '../src/diagnostics/phoneRecordingSummary';
import { CandidatePoseObserver, type CandidateProtocol } from './ci-browser-smoke-protocol';

type Exercise = {
  browser: Browser;
  artifacts: string;
  origin: string;
  capture: (page: Page, name: string) => Promise<void>;
  monitor: (page: Page, name: string) => void;
};

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

async function until(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    assert(Date.now() < deadline, description);
    await delay(50);
  }
}

async function enter(page: Page, pilot: string): Promise<void> {
  await page.getByLabel('Pilot name', { exact: true }).fill(pilot);
  await page.getByRole('button', { name: 'Enter Game', exact: true }).click();
  await page.getByLabel('GeoRoids playfield', { exact: true }).waitFor({ state: 'visible' });
  await page.keyboard.press('Space');
  await page.locator('#spawn-fly-in').waitFor({ state: 'hidden' });
}

// Passive protocol observations identify only the two owned pilots. No socket is replaced,
// no packet is delayed, and no runtime or world state is injected into the candidate.
function observe(page: Page, target: () => string | null, protocol: CandidateProtocol) {
  const observer = new CandidatePoseObserver({ createDecoder: protocol.createDecoder, target });
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/ws') {
      return;
    }
    const channel = observer.openSocket();
    socket.on('framereceived', ({ payload }) => {
      channel.receive(payload);
    });
    socket.on('close', () => channel.close());
  });
  return observer;
}

export async function runRemoteMotion(
  exercise: Exercise & { protocol: CandidateProtocol }
): Promise<void> {
  const { browser, artifacts, origin, capture, monitor, protocol } = exercise;
  const options = {
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: join(artifacts, 'video'), size: { width: 1280, height: 800 } },
  };
  const observerContext = await browser.newContext(options);
  const subjectContext = await browser.newContext(options);
  const observer = await observerContext.newPage();
  const subject = await subjectContext.newPage();
  monitor(observer, 'remote-observer');
  monitor(subject, 'remote-subject');
  const subjectWire = observe(subject, () => subjectWire.state.id, protocol);
  const observerWire = observe(observer, () => subjectWire.state.id, protocol);
  try {
    assert((await observer.goto(origin))?.ok());
    await enter(observer, 'CI observer');
    assert((await subject.goto(origin))?.ok());
    await enter(subject, 'CI subject');
    await until(
      () => observerWire.state.ownPose !== null && observerWire.state.pose !== null,
      'Observer did not receive the identified subject'
    );
    assert(
      observerWire.state.id !== subjectWire.state.id,
      'Pilots must have independent identities'
    );
    const before = observerWire.state.pose;
    const observerBefore = observerWire.state.ownPose;
    assert(before);
    await capture(observer, 'remote-observer-before');
    await capture(subject, 'remote-subject-before');
    await subject.getByLabel('GeoRoids playfield', { exact: true }).focus();
    await subject.keyboard.down('ArrowUp');
    await subject.keyboard.down('ArrowRight');
    try {
      // A short held input supplies visual material; the received pose proves movement.
      await delay(800);
      await until(() => {
        const pose = observerWire.state.pose;
        return (
          pose !== null &&
          pose.sequence > before.sequence &&
          Math.hypot(pose.x - before.x, pose.y - before.y) > 1
        );
      }, 'Observer did not receive subject movement');
    } finally {
      await subject.keyboard.up('ArrowRight');
      await subject.keyboard.up('ArrowUp');
    }
    const after = observerWire.state.pose;
    await capture(observer, 'remote-observer-after');
    await capture(subject, 'remote-subject-after');
    assert.deepEqual([...subjectWire.failures, ...observerWire.failures], []);
    await writeFile(
      join(artifacts, 'remote-motion.json'),
      `${JSON.stringify(
        {
          observerId: observerWire.state.id,
          subjectId: subjectWire.state.id,
          before,
          after,
          observerBefore,
          observerAfter: observerWire.state.ownPose,
          limitation:
            'Identified authoritative poses and observer video during ordinary steering; no packet-free-frame, 60 fps or perceptual-quality assertion.',
        },
        null,
        2
      )}\n`
    );
  } catch (error) {
    await capture(observer, 'remote-observer-failure').catch(() => undefined);
    await capture(subject, 'remote-subject-failure').catch(() => undefined);
    throw error;
  } finally {
    await Promise.all([observerContext.close(), subjectContext.close()]);
  }
}

export async function runPhoneDiagnostics(exercise: Exercise): Promise<void> {
  const { browser, artifacts, origin, capture, monitor } = exercise;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    recordVideo: { dir: join(artifacts, 'video'), size: { width: 390, height: 844 } },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  monitor(page, 'phone-diagnostics');
  try {
    assert((await page.goto(`${origin}/?performance=collect`))?.ok());
    await enter(page, 'CI diagnostics');
    const collector = page.getByRole('complementary', {
      name: 'Performance collection',
      exact: true,
    });
    const metadataToggle = collector.getByText('Device and conditions', { exact: true });
    await metadataToggle.click();
    await collector
      .getByLabel('Device model and OS', { exact: true })
      .fill('Hosted Chromium mobile viewport');
    await collector
      .getByLabel('Test conditions', { exact: true })
      .fill('Ephemeral CI world; short flight and map; not a physical phone');
    // Close the metadata disclosure to expose the mobile panel's recording controls.
    await metadataToggle.click();
    await collector.getByRole('button', { name: 'Start', exact: true }).click();
    await collector.getByRole('status').filter({ hasText: 'Performance: recording' }).waitFor();
    await page
      .getByLabel('GeoRoids playfield', { exact: true })
      .tap({ position: { x: 200, y: 150 } });
    // Explicit bounded collection windows, not frame-rate or speed assertions.
    await delay(1400);
    await capture(page, 'phone-recording-flight');
    await page.getByRole('button', { name: /^Open universe map/u }).click();
    const map = page.getByRole('dialog', { name: 'Universe map', exact: true });
    await map.waitFor({ state: 'visible' });
    await capture(page, 'phone-recording-map');
    await delay(1100);
    await map.getByRole('button', { name: 'Close', exact: true }).click();
    await map.waitFor({ state: 'hidden' });
    await collector.getByRole('button', { name: 'Stop', exact: true }).click();
    await capture(page, 'phone-recording-stopped');
    const pendingDownload = page.waitForEvent('download');
    await collector.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await pendingDownload;
    const rawPath = join(artifacts, 'phone-recording.json');
    await download.saveAs(rawPath);
    assert((await stat(rawPath)).size <= 2 * 1024 * 1024, 'Brief recording exceeded 2 MiB');
    const envelope = object(JSON.parse(await readFile(rawPath, 'utf8')));
    assert(envelope['checksumAlgorithm'] === 'SHA-256');
    const content = envelope['content'];
    assert(typeof content === 'string');
    const checksum = createHash('sha256').update(content).digest('hex');
    assert.equal(envelope['checksum'], checksum, 'Raw recording checksum mismatch');
    const recording = object(JSON.parse(content));
    assert(recording['schemaVersion'] === 2);
    assert(typeof recording['sessionId'] === 'string');
    assert(recording['incompleteReason'] === null, 'Recording reported incomplete data');
    const metadata = object(recording['metadata']);
    assert(typeof metadata['startedAt'] === 'string');
    assert(typeof metadata['device'] === 'string');
    assert(typeof metadata['conditions'] === 'string');
    const samples = recording['samples'];
    assert(Array.isArray(samples) && samples.length > 0 && samples.length <= 15);
    const chunks = samples.map(object);
    const summary = summarizePhoneRecording({
      id: recording['sessionId'],
      metadata: {
        startedAt: metadata['startedAt'],
        device: metadata['device'],
        conditions: metadata['conditions'],
      },
      incompleteReason: null,
      samples: chunks.map((sample) => JSON.stringify(sample)),
      stopped: true,
      recovered: false,
    });
    assert(object(summary['metrics'])['play.frameIntervalMs'], 'No gameplay frames recorded');
    await writeFile(
      join(artifacts, 'phone-summary.json'),
      `${JSON.stringify(
        {
          checksum,
          checksumVerified: true,
          summary,
          extendedDiagnostics: {
            bitmapBudgetChunks: chunks.filter((sample) => sample['bitmapBudget'] !== undefined)
              .length,
            heartbeatChunks: chunks.filter(
              (sample) => sample['heartbeat'] !== undefined && sample['heartbeat'] !== null
            ).length,
            interpretation:
              'Presence counts only. Inspect raw bitmap estimates and heartbeat clocks for candidate acceptance; fields may be absent on the main self-check.',
          },
          limitation:
            'Same-runtime export flow in hosted Chromium. This does not establish physical iPhone memory pressure, GPU memory use or suspension behavior.',
        },
        null,
        2
      )}\n`
    );
  } catch (error) {
    await capture(page, 'phone-diagnostics-failure').catch(() => undefined);
    throw error;
  } finally {
    await context.close();
  }
}
