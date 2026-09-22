import type { Howl } from 'howler';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { disposeAudioSound } from '../../../src/audio/audioRuntime';

const decodedBuffer = { duration: 1 };

class BrowserAudio extends EventTarget {
  static instances: BrowserAudio[] = [];
  muted = false;
  load = vi.fn();
  pause = vi.fn();
  play = vi.fn(() => Promise.resolve());

  constructor() {
    super();
    BrowserAudio.instances.push(this);
  }

  canPlayType() {
    return 'probably';
  }
}

class BrowserBufferSource {
  static startedBuffers: unknown[] = [];
  buffer: unknown;
  playbackRate = { setValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn();

  start() {
    BrowserBufferSource.startedBuffers.push(this.buffer);
  }
}

class BrowserAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};

  createGain() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: { setValueAtTime: vi.fn() },
    };
  }

  createBufferSource() {
    return new BrowserBufferSource();
  }

  decodeAudioData(_bytes: ArrayBuffer) {
    return Promise.resolve(decodedBuffer);
  }
}

class BrowserDownload {
  static instances: BrowserDownload[] = [];
  status = 0;
  response = new ArrayBuffer(0);
  onload: (() => void) | undefined;
  onerror: (() => void) | undefined;
  open = vi.fn();
  send = vi.fn();
  setRequestHeader = vi.fn();

  constructor() {
    BrowserDownload.instances.push(this);
  }

  finish() {
    if (!this.onload) {
      throw new Error('Howler did not register the download completion handler');
    }
    this.status = 200;
    this.response = new ArrayBuffer(4);
    this.onload();
  }

  fail() {
    if (!this.onerror) {
      throw new Error('Howler did not register the download failure handler');
    }
    this.onerror();
  }
}

let sounds: Howl[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('howler');
  vi.useFakeTimers();
  BrowserAudio.instances = [];
  BrowserBufferSource.startedBuffers = [];
  BrowserDownload.instances = [];
  vi.stubGlobal('Audio', BrowserAudio);
  vi.stubGlobal('AudioContext', BrowserAudioContext);
  vi.stubGlobal('XMLHttpRequest', BrowserDownload);
});

afterEach(() => {
  for (const sound of sounds) {
    sound.off();
    sound.unload();
  }
  sounds = [];
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a late download failure cannot silence sounds after an audio restart', async () => {
  // Keep Howler's real download, cache, unload and playback implementation.
  const { Howl: DownloadedSound, Howler } = await import('howler');
  Howler.autoUnlock = false;
  Howler.autoSuspend = false;
  const discarded = new DownloadedSound({ src: ['/sounds/restarted-laser.mp3'] });
  sounds.push(discarded);
  disposeAudioSound(discarded);
  const replacement = new DownloadedSound({ src: ['/sounds/restarted-laser.mp3'] });
  sounds.push(replacement);

  const [oldDownload, replacementDownload] = BrowserDownload.instances;
  if (!oldDownload || !replacementDownload) {
    throw new Error('Expected separate downloads for the discarded and replacement sounds');
  }
  replacementDownload.finish();
  await Promise.resolve();
  expect(replacement.state()).toBe('loaded');
  const firstVoice = replacement.play();
  expect(BrowserBufferSource.startedBuffers[0]).toBe(decodedBuffer);
  replacement.stop(firstVoice);
  const mediaCount = BrowserAudio.instances.length;

  // Howler 2.2.4 otherwise deletes the new cached buffer and loads HTML media
  // for the discarded Howl when its outstanding XHR fails after unload().
  oldDownload.fail();
  expect(discarded.state()).toBe('unloaded');
  expect(BrowserAudio.instances).toHaveLength(mediaCount);
  expect(BrowserDownload.instances).toHaveLength(2);
  expect(replacement.state()).toBe('loaded');
  const nextVoice = replacement.play();
  expect(BrowserBufferSource.startedBuffers).toHaveLength(2);
  expect(BrowserBufferSource.startedBuffers[1]).toBe(decodedBuffer);
  replacement.stop(nextVoice);
});
