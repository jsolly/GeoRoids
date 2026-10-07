import type { Page } from 'playwright';

/** Retain native offline progress without replacing rendering or its promise. */
export async function installOfflineAudioObservation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const events: Array<Record<string, unknown>> = [];
    let nextId = 0;
    let dropped = 0;
    const snapshots: Array<() => Record<string, unknown>> = [];
    document.addEventListener('georoids-offline-audio-snapshot', () => {
      document.documentElement.dataset['offlineAudioOperations'] = JSON.stringify(events);
      document.documentElement.dataset['offlineAudioDropped'] = String(dropped);
      document.documentElement.dataset['offlineAudioSnapshots'] = JSON.stringify(
        snapshots.map((read) => read())
      );
    });
    const record = (id: number, operation: string, details: Record<string, unknown> = {}) => {
      events.push({ id, operation, at: performance.now(), ...details });
      if (events.length > 128) {
        events.shift();
        dropped++;
      }
      document.documentElement.dataset['offlineAudioOperations'] = JSON.stringify(events);
    };
    const startRendering = OfflineAudioContext.prototype.startRendering;
    const contexts = new WeakMap<OfflineAudioContext, number>();
    OfflineAudioContext.prototype.startRendering = function (this: OfflineAudioContext) {
      let id = contexts.get(this);
      if (id === undefined) {
        id = ++nextId;
        contexts.set(this, id);
        const contextId = id;
        if (snapshots.length >= 16) {
          throw new Error('Offline observation context limit exceeded');
        }
        snapshots.push(() => ({ id: contextId, state: this.state, time: this.currentTime }));
        record(id, 'created', { length: this.length, sampleRate: this.sampleRate });
        this.addEventListener('statechange', () =>
          record(contextId, 'statechange', { state: this.state, time: this.currentTime })
        );
        this.addEventListener('complete', () => record(contextId, 'complete'));
      }
      record(id, 'render-called', { state: this.state });
      const contextId = id;
      const rendered = startRendering.call(this);
      void rendered.then(
        (buffer) => record(contextId, 'render-fulfilled', { duration: buffer.duration }),
        (error: unknown) => record(contextId, 'render-rejected', { error: String(error) })
      );
      return rendered;
    };
  });
}

export function readOfflineAudioObservation(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    document.dispatchEvent(new Event('georoids-offline-audio-snapshot'));
    const { offlineAudioOperations, offlineAudioSnapshots, offlineAudioDropped } =
      document.documentElement.dataset;
    if (
      offlineAudioOperations === undefined ||
      offlineAudioSnapshots === undefined ||
      offlineAudioDropped !== '0'
    ) {
      throw new Error('Offline native observation unavailable or truncated');
    }
    return {
      operations: JSON.parse(offlineAudioOperations),
      native: JSON.parse(offlineAudioSnapshots),
    };
  });
}
