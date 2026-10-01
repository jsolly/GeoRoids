// @vitest-environment node
import { expect, test } from 'vitest';
import { installAudioProbe, readNativeAudioSnapshot } from '../../utils/audio-probe';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { writeScenarioReceipt } from '../../utils/write-scenario-receipt';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

type SampleSnapshot = {
  rawTime: number;
  startedAt: number;
  state: string;
  ended: boolean;
  duration: number;
  rate: number;
  handleRetained: boolean;
  voices: number;
  pilotId: string;
};

function lifecycleRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error('Missing native source lifecycle');
  }
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('Invalid native source lifecycle row');
    }
    return Object.fromEntries(Object.entries(row));
  });
}

test('muting stops a real sample whose Howler wall clock ended before its native source', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Missing browser page');
  }
  await installAudioProbe(page);
  const failures: unknown[] = [];
  const snapshots: unknown[] = [];
  let stage = 'boot';
  const capture = async (label: string) => {
    snapshots.push({
      label,
      audio: await readNativeAudioSnapshot(page),
      sample: await page.evaluate('window.sampleOwnershipDiagnostic?.read() ?? null'),
    });
  };
  try {
    await new GameInteractions(page).bootGame({ waitForCombatReady: false });
    stage = 'load-real-sound';
    await page.evaluate(`(async () => {
      const { Sound } = await import('/src/audio/Sound.ts');
      const sound = new Sound('/sounds/loot-pickup.m4a', 2);
      window.sampleOwnershipDiagnostic = { sound };
    })()`);
    await page.waitForFunction(`window.sampleOwnershipDiagnostic.sound.howl?.state() === 'loaded'`);
    stage = 'inject-early-howler-end';
    await page.evaluate(`(() => {
      const diagnostic = window.sampleOwnershipDiagnostic;
      const sound = diagnostic.sound;
      const howl = sound.howl;
      diagnostic.sourceIds = [];
      diagnostic.playSample = (volume, offset) => {
        const readStarts = () => {
          document.dispatchEvent(new Event('georoids-audio-probe-snapshot'));
          return JSON.parse(document.documentElement.dataset.audioLifecycle)
            .filter(event => event.kind === 'source-start');
        };
        const before = new Set(readStarts().map(event => event.sourceId));
        if (!sound.playNote(volume, -48, offset)) throw new Error('Real sample playback rejected');
        // This synchronous boundary excludes live-game cues using the same asset.
        const starts = readStarts().filter(event => !before.has(event.sourceId));
        if (starts.length !== 1) throw new Error('Expected one native source per diagnostic sample');
        const sourceId = starts[0].sourceId;
        if (!Number.isInteger(sourceId) || sourceId <= 0) throw new Error('Invalid diagnostic native source ID');
        diagnostic.sourceIds.push(sourceId);
      };
      diagnostic.playSample(1);
      const ids = [...sound.voices.keys()];
      if (ids.length !== 1) throw new Error('Expected one owned real sample');
      const voice = howl._soundById(ids[0]);
      const source = voice?._node?.bufferSource;
      if (!(source instanceof AudioBufferSourceNode)) throw new Error('Missing native sample source');
      const nativeTime = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime')?.get;
      if (!nativeTime) throw new Error('Missing raw native clock getter');
      const startedAt = nativeTime.call(source.context);
      let ended = false;
      source.addEventListener('ended', () => { ended = true; });
      diagnostic.read = () => ({
        rawTime: nativeTime.call(source.context), startedAt,
        state: source.context.state, ended,
        duration: source.buffer.duration, rate: source.playbackRate.value,
        handleRetained: voice._node.bufferSource === source,
        voices: sound.voices.size,
        pilotId: window.gameController.getCurrPlayer().id,
      });
      diagnostic.beforeFault = diagnostic.read();
      const gain = voice._node;
      const panner = voice._panner;
      diagnostic.startOverlap = () => {
        diagnostic.firstSettings = { gain: gain.gain.value, x: panner.positionX.value, z: panner.positionZ.value };
        diagnostic.playSample(0.5, { x: 200, y: 50 });
        const secondId = [...sound.voices.keys()].find(id => id !== ids[0]);
        const second = howl._soundById(secondId);
        diagnostic.overlap = () => ({ distinctGain: gain !== second._node, distinctPanner: panner !== second._panner,
          before: diagnostic.firstSettings, after: { gain: gain.gain.value, x: panner.positionX.value, z: panner.positionZ.value },
          second: { gain: second._node.gain.value, x: second._panner.positionX.value, z: second._panner.positionZ.value },
          voices: sound.voices.size, overflowAccepted: sound.playNote(1, 0) });
      };
      // Fault injection models Howler's wall timer firing before native completion.
      // Playback, decoding, clock, context and trusted Play authorization stay real.
      howl.once('end', () => { diagnostic.wallEnded = true; }, ids[0]);
      howl._ended(voice);
    })()`);
    await page.waitForFunction('window.sampleOwnershipDiagnostic.wallEnded === true');
    const precondition = await page.evaluate<{
      before: SampleSnapshot;
      after: SampleSnapshot;
    }>(`(() => {
      const diagnostic = window.sampleOwnershipDiagnostic;
      return { before: diagnostic.beforeFault, after: diagnostic.read() };
    })()`);
    expect(precondition.before.handleRetained).toBe(true);
    expect(precondition.after.ended).toBe(false);
    expect(precondition.after.state).toBe('running');
    expect(precondition.after.rawTime - precondition.after.startedAt).toBeLessThan(
      precondition.after.duration / precondition.after.rate
    );
    await capture('early-wall-end');
    stage = 'overlapping-native-voices';
    await page.evaluate('window.sampleOwnershipDiagnostic.startOverlap()');
    await new GameInteractions(page).waitForAnimationFrames(2);
    const overlap = await page.evaluate<{
      distinctGain: boolean;
      distinctPanner: boolean;
      before: unknown;
      after: unknown;
      voices: number;
      overflowAccepted: boolean;
      second: { gain: number; x: number; z: number };
    }>('window.sampleOwnershipDiagnostic.overlap()');
    snapshots.push({ stage, overlap });
    expect(overlap.distinctGain).toBe(true);
    expect(overlap.distinctPanner).toBe(true);
    expect(overlap.after).toEqual(overlap.before);
    expect(overlap.second.gain).toBeCloseTo(0.025);
    expect(overlap.second.x).toBe(2);
    expect(overlap.second.z).toBe(0.5);
    expect(overlap.voices).toBe(2);
    expect(overlap.overflowAccepted).toBe(false);
    stage = 'mute';
    // The live game's title checkbox is hidden; invoke its actual change handler.
    await page.locator('#soundPref').evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Missing sound preference checkbox');
      }
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['audioContextState']))
      .toBe('suspended');
    await capture('after-mute-suspend');
    const mutedSample = await page.evaluate<SampleSnapshot>(
      'window.sampleOwnershipDiagnostic.read()'
    );
    expect(mutedSample.pilotId).toBe(precondition.after.pilotId);
    const mutedAudio = await readNativeAudioSnapshot(page);
    const lifecycle = lifecycleRows(mutedAudio.lifecycle);
    const sampleSourceIds = await page.evaluate<number[]>(
      'window.sampleOwnershipDiagnostic.sourceIds'
    );
    expect(sampleSourceIds).toHaveLength(2);
    expect(new Set(sampleSourceIds).size).toBe(2);
    const sampleStarts = lifecycle.filter(
      (event) =>
        event['kind'] === 'source-start' && sampleSourceIds.includes(Number(event['sourceId']))
    );
    expect(sampleStarts).toHaveLength(2);
    for (const sampleStart of sampleStarts) {
      expect(sampleStart['duration']).toBe(precondition.after.duration);
      expect(
        lifecycle.some(
          (event) =>
            event['kind'] === 'source-stop' && event['sourceId'] === sampleStart?.['sourceId']
        )
      ).toBe(true);
      expect(
        lifecycle.some(
          (event) =>
            event['kind'] === 'source-disconnect' && event['sourceId'] === sampleStart?.['sourceId']
        )
      ).toBe(true);
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['activeAudio']), {
        timeout: 2000,
      })
      .toBe('0');
  } catch (error) {
    failures.push(error);
    try {
      await capture('failure');
    } catch (captureError) {
      failures.push(captureError);
    }
  }
  writeScenarioReceipt({
    path: screenshotManager.getScreenshotPath('early-howler-end-mute-receipt.json'),
    receipt: () => ({
      status: failures.length ? 'failed' : 'passed',
      stage,
      fault: 'explicit real Howler _ended before native source ended; no native clock mutation',
      snapshots,
      errors: failures.map(String),
    }),
    failures,
    message: 'Muting after an early Howler wall-clock end failed',
  });
}, 60000);

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
]) {
  test(`${viewport.name} title Sound Effects checkbox stops native cues through a visible gesture`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.mobile });
    await page.setViewportSize(viewport);
    await installAudioProbe(page);
    const diagnostics = watchBrowserDiagnostics(page);
    const failures: unknown[] = [];
    const snapshots: unknown[] = [];
    const screenshot = screenshotManager.getScreenshotPath(`native-mute-${viewport.name}.png`);
    let stage = 'visible-title';
    try {
      await new GameInteractions(page).navigateToGame();
      const preference = page.locator('#soundPref');
      expect(await preference.isVisible()).toBe(true);
      expect(await preference.isChecked()).toBe(true);
      expect(await page.locator('#musicPref').isChecked()).toBe(false);
      const kit = page.locator('#ship-kit-grid [aria-pressed="true"]');
      if (viewport.mobile) {
        await kit.tap();
      } else {
        await kit.click();
      }
      stage = 'real-native-cue';
      await page.evaluate(`(async () => {
        const { Sound } = await import('/src/audio/Sound.ts');
        window.titleMuteSound = new Sound('/sounds/loot-pickup.m4a', 1);
      })()`);
      await page.waitForFunction(`window.titleMuteSound.howl?.state() === 'loaded'`);
      expect(await page.evaluate('window.titleMuteSound.playNote(1, -48)')).toBe(true);
      // AudioParam.value reflects the next native rendering quantum, not the schedule call.
      await expect
        .poll(async () => {
          const native = await readNativeAudioSnapshot(page);
          return lifecycleRows(native.sources).some((row) => row['rate'] === 0.0625);
        })
        .toBe(true);
      const before = await readNativeAudioSnapshot(page);
      snapshots.push({ stage: 'before-mute', native: before });
      expect(before.contexts).toHaveLength(1);
      expect(before.contexts[0]?.state).toBe('running');
      const sources = lifecycleRows(before.sources);
      const source = sources.find((row) => row['rate'] === 0.0625);
      expect(source).toBeDefined();
      expect(source?.['connected']).toBe(true);
      stage = 'visible-checkbox-mute';
      if (viewport.mobile) {
        await preference.tap();
      } else {
        await preference.click();
      }
      expect(await preference.isChecked()).toBe(false);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset['activeAudio']))
        .toBe('0');
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset['audioContextState']))
        .toBe('suspended');
      const after = await readNativeAudioSnapshot(page);
      snapshots.push({ stage: 'after-mute', native: after });
      const events = lifecycleRows(after.lifecycle);
      expect(
        events.some(
          (row) => row['kind'] === 'source-stop' && row['sourceId'] === source?.['sourceId']
        )
      ).toBe(true);
      expect(
        events.some(
          (row) => row['kind'] === 'source-disconnect' && row['sourceId'] === source?.['sourceId']
        )
      ).toBe(true);
      await page.screenshot({ path: screenshot });
      assertNoBrowserDiagnostics(diagnostics);
    } catch (error) {
      failures.push(error);
      try {
        snapshots.push({ stage: 'failure', native: await readNativeAudioSnapshot(page) });
        await page.screenshot({ path: screenshot });
      } catch (captureError) {
        failures.push(captureError);
      }
    }
    writeScenarioReceipt({
      path: screenshotManager.getScreenshotPath(`native-mute-${viewport.name}-receipt.json`),
      receipt: () => ({
        status: failures.length ? 'failed' : 'passed',
        stage,
        route: page.url(),
        viewport,
        screenshot,
        interactions: [
          'trusted visible selected kit gesture',
          'visible Sound Effects checkbox click/tap',
        ],
        console: diagnostics,
        snapshots,
        errors: failures.map(String),
      }),
      failures,
      message: `${viewport.name} visible native mute UI failed`,
    });
  }, 60000);
}
