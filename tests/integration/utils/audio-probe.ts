import type { Page } from 'playwright';

/** Observe native Web Audio calls without replacing playback or decoding. */
export async function installAudioProbe(
  page: Page,
  enabled = true,
  probe: { music?: boolean } = {}
): Promise<void> {
  await page.addInitScript(
    ([soundEnabled, musicEnabled]) => {
      localStorage.setItem('soundOn', String(soundEnabled));
      localStorage.setItem('musicOn', String(musicEnabled));
      const events: Array<{
        sourceId: number;
        at: number;
        duration: number;
        rate: number;
        loop: boolean;
        bufferId: number;
        contextId: number;
        position?: { x: number; z: number; model: string; rolloff: number };
      }> = [];
      const connections = new WeakMap<AudioNode, AudioNode>();
      const pannerStates = new WeakMap<PannerNode, { x: number; z: number }>();
      const positionParameters = new WeakMap<
        AudioParam,
        { state: { x: number; z: number }; axis: 'x' | 'z' }
      >();
      const nativeConnect = AudioNode.prototype.connect;
      function connect(
        this: AudioNode,
        destination: AudioNode,
        output?: number,
        input?: number
      ): AudioNode;
      function connect(this: AudioNode, destination: AudioParam, output?: number): void;
      function connect(
        this: AudioNode,
        destination: AudioNode | AudioParam,
        output?: number,
        input?: number
      ): AudioNode | undefined {
        if (destination instanceof AudioNode) {
          connections.set(this, destination);
          return nativeConnect.bind(this)(destination, output, input);
        }
        nativeConnect.call(this, destination, output);
        return undefined;
      }
      AudioNode.prototype.connect = connect;
      const active = new Set<AudioBufferSourceNode>();
      const sourceIds = new WeakMap<AudioBufferSourceNode, number>();
      const sourceStarts = new WeakMap<
        AudioBufferSourceNode,
        { duration: number | null; when: number; offset: number; requestedDuration: number | null }
      >();
      let nextSourceId = 0;
      const describeSource = (source: AudioBufferSourceNode) => ({
        sourceId: sourceIds.get(source),
        contextId: contextIds.get(source.context),
        state: source.context.state,
        rawTime: Number(readRawTime(source.context)),
        observedTime: source.context.currentTime,
        ...sourceStarts.get(source),
        currentBufferDuration: source.buffer?.duration ?? null,
        rate: source.playbackRate.value,
        loop: source.loop,
        connected: connections.has(source),
      });
      const nativeDisconnect = AudioNode.prototype.disconnect;
      AudioNode.prototype.disconnect = function (
        this: AudioNode,
        ...args:
          | []
          | [number]
          | [AudioNode]
          | [AudioNode, number]
          | [AudioNode, number, number]
          | [AudioParam]
          | [AudioParam, number]
      ) {
        const result = Reflect.apply(nativeDisconnect, this, args);
        connections.delete(this);
        if (this instanceof AudioBufferSourceNode) {
          record('source-disconnect', describeSource(this));
        }
        return result;
      };
      const rates = new WeakMap<AudioParam, (typeof events)[number]>();
      const buffers = new WeakMap<AudioBuffer, number>();
      let nextBufferId = 0;
      let contexts = 0;
      const contextIds = new WeakMap<BaseAudioContext, number>();
      const contextStates: AudioContextState[] = [];
      const nativeSnapshots: Array<
        () => {
          id: number;
          state: AudioContextState;
          time: number;
          rawTime: number;
          observedTime: number;
        }
      > = [];
      const lifecycle: Array<Record<string, unknown>> = [];
      let lifecycleSequence = 0;
      const record = (kind: string, details: Record<string, unknown> = {}) => {
        lifecycle.push({
          sequence: ++lifecycleSequence,
          at: performance.now(),
          kind,
          visibility: document.visibilityState,
          userActivation: navigator.userActivation
            ? {
                active: navigator.userActivation.isActive,
                everActive: navigator.userActivation.hasBeenActive,
              }
            : null,
          ...details,
        });
        if (lifecycle.length > 512) {
          lifecycle.shift();
        }
      };
      for (const type of ['pointerdown', 'touchend', 'keydown']) {
        document.addEventListener(
          type,
          (event) => {
            record('gesture', {
              type,
              trusted: event.isTrusted,
              target:
                event.target instanceof Element ? event.target.id || event.target.tagName : null,
              key: event instanceof KeyboardEvent ? event.key : null,
            });
          },
          true
        );
      }
      document.addEventListener('visibilitychange', () => record('visibility'));
      document.addEventListener('georoids-audio-probe-snapshot', () => {
        const snapshots = nativeSnapshots.map((read) => read());
        const sources = [...active].map(describeSource);
        record('snapshot', { contexts: snapshots, sources });
        document.documentElement.dataset['nativeAudioSources'] = JSON.stringify(sources);
        document.documentElement.dataset['nativeAudioContexts'] = JSON.stringify(snapshots);
        document.documentElement.dataset['audioLifecycle'] = JSON.stringify(lifecycle);
        document.documentElement.dataset['audioLifecycleDropped'] = String(
          lifecycleSequence - lifecycle.length
        );
      });
      let media = 0;
      let decoded = 0;
      const decodedDurations: number[] = [];
      const activeTones = new Set<OscillatorNode>();
      const toneParameters = new WeakSet<AudioParam>();
      const panParameters = new WeakSet<AudioParam>();
      const orbitMotion: Array<{ kind: 'detune' | 'pan'; value: number }> = [];
      const publish = () => {
        document.documentElement.dataset['audioEvents'] = JSON.stringify(events);
        document.documentElement.dataset['activeAudio'] = String(active.size);
        document.documentElement.dataset['activeLoops'] = String(
          [...active].filter((node) => node.loop).length
        );
        document.documentElement.dataset['audioContexts'] = String(contexts);
        document.documentElement.dataset['audioContextStates'] = JSON.stringify(contextStates);
        document.documentElement.dataset['activeLoopContexts'] = JSON.stringify(
          [...active].filter((node) => node.loop).map((node) => contextIds.get(node.context))
        );
        document.documentElement.dataset['audioMedia'] = String(media);
        document.documentElement.dataset['decodedAudio'] = String(decoded);
        document.documentElement.dataset['decodedAudioDurations'] =
          JSON.stringify(decodedDurations);
        document.documentElement.dataset['activeTones'] = String(activeTones.size);
        document.documentElement.dataset['orbitGains'] = JSON.stringify(
          [...activeTones].flatMap((tone) => {
            const gain = connections.get(tone);
            return gain instanceof GainNode ? [gain.gain.value] : [];
          })
        );
        document.documentElement.dataset['orbitMotion'] = JSON.stringify(orbitMotion);
      };
      const NativeContext = window.AudioContext;
      const nativeTimeGetter = Object.getOwnPropertyDescriptor(
        BaseAudioContext.prototype,
        'currentTime'
      )?.get;
      if (!nativeTimeGetter) {
        throw new Error('Native currentTime getter unavailable');
      }
      const readRawTime = nativeTimeGetter.call.bind(nativeTimeGetter);
      window.AudioContext = class extends NativeContext {
        private frozenTime: number | null = null;

        override get currentTime(): number {
          if (
            document.documentElement.dataset['freezeAudioContext'] === String(contextIds.get(this))
          ) {
            this.frozenTime ??= super.currentTime;
            return this.frozenTime;
          }
          return super.currentTime;
        }

        constructor(options?: AudioContextOptions) {
          super(options);
          contexts++;
          document.documentElement.dataset['audioSampleRate'] = String(this.sampleRate);
          const id = contexts;
          contextIds.set(this, id);
          nativeSnapshots.push(() => ({
            id,
            state: this.state,
            time: super.currentTime,
            rawTime: Number(readRawTime(this)),
            observedTime: this.currentTime,
          }));
          record('create', { contextId: id, state: this.state, sampleRate: this.sampleRate });
          const publishState = () => {
            contextStates[id - 1] = this.state;
            if (id === contexts) {
              document.documentElement.dataset['audioContextState'] = this.state;
            }
            publish();
          };
          this.addEventListener('statechange', () => {
            record('statechange', { contextId: id, state: this.state, time: super.currentTime });
            publishState();
          });
          publishState();
          publish();
        }
        private observeControl(operation: string, execute: () => Promise<void>): Promise<void> {
          const details = () => ({
            contextId: contextIds.get(this),
            state: this.state,
            time: super.currentTime,
          });
          record(`${operation}-call`, details());
          let result: Promise<void>;
          try {
            result = execute();
          } catch (error) {
            record(`${operation}-throw`, { ...details(), error: String(error) });
            throw error;
          }
          // Return the native promise unchanged. Observation must not delay activation.
          void result.then(
            () => record(`${operation}-fulfilled`, details()),
            (error: unknown) =>
              record(`${operation}-rejected`, { ...details(), error: String(error) })
          );
          return result;
        }
        override resume(): Promise<void> {
          return this.observeControl('resume', () => super.resume());
        }
        override suspend(): Promise<void> {
          return this.observeControl('suspend', () => super.suspend());
        }
        override close(): Promise<void> {
          return this.observeControl('close', () => super.close());
        }
        override createPanner(): PannerNode {
          const pan = super.createPanner();
          panParameters.add(pan.positionX);
          const state = { x: 0, z: 0 };
          pannerStates.set(pan, state);
          positionParameters.set(pan.positionX, { state, axis: 'x' });
          positionParameters.set(pan.positionZ, { state, axis: 'z' });
          return pan;
        }
        override decodeAudioData(
          data: ArrayBuffer,
          ...callbacks: [
            success?: DecodeSuccessCallback | null,
            failure?: DecodeErrorCallback | null,
          ]
        ): Promise<AudioBuffer> {
          return super.decodeAudioData(data, ...callbacks).then((buffer) => {
            decoded++;
            decodedDurations.push(buffer.duration);
            publish();
            return buffer;
          });
        }
      };
      const NativeAudio = window.Audio;
      window.Audio = class extends NativeAudio {
        constructor(src?: string) {
          super(src);
          media++;
          publish();
        }
      };
      const setValueAtTime = AudioParam.prototype.setValueAtTime;
      AudioParam.prototype.setValueAtTime = function (this: AudioParam, value, startTime) {
        const result = setValueAtTime.call(this, value, startTime);
        const position = positionParameters.get(this);
        if (position) {
          position.state[position.axis] = value;
        }
        const event = rates.get(this);
        if (event) {
          event.rate = value;
          publish();
        }
        return result;
      };
      const targetAt = AudioParam.prototype.setTargetAtTime;
      AudioParam.prototype.setTargetAtTime = function (
        this: AudioParam,
        value,
        startTime,
        constant
      ) {
        const result = targetAt.call(this, value, startTime, constant);
        if (toneParameters.has(this) || panParameters.has(this)) {
          orbitMotion.push({ kind: toneParameters.has(this) ? 'detune' : 'pan', value });
          if (orbitMotion.length > 512) {
            orbitMotion.shift();
          }
          publish();
        }
        return result;
      };
      const startTone = OscillatorNode.prototype.start;
      const stopTone = OscillatorNode.prototype.stop;
      OscillatorNode.prototype.start = function (this: OscillatorNode, when = 0) {
        startTone.call(this, when);
        activeTones.add(this);
        toneParameters.add(this.detune);
        this.addEventListener(
          'ended',
          () => {
            activeTones.delete(this);
            publish();
          },
          { once: true }
        );
        publish();
      };
      OscillatorNode.prototype.stop = function (this: OscillatorNode, when = 0) {
        stopTone.call(this, when);
        if (when <= this.context.currentTime) {
          activeTones.delete(this);
        }
        publish();
      };
      const start = AudioBufferSourceNode.prototype.start;
      const stop = AudioBufferSourceNode.prototype.stop;
      AudioBufferSourceNode.prototype.start = function (
        this: AudioBufferSourceNode,
        when = 0,
        offset = 0,
        duration?: number
      ) {
        if (duration === undefined) {
          start.call(this, when, offset);
        } else {
          start.call(this, when, offset, duration);
        }
        active.add(this);
        sourceIds.set(this, ++nextSourceId);
        sourceStarts.set(this, {
          duration: this.buffer?.duration ?? null,
          when,
          offset,
          requestedDuration: duration ?? null,
        });
        record('source-start', {
          ...describeSource(this),
          when,
          offset,
          requestedDuration: duration ?? null,
        });
        if (this.buffer && !buffers.has(this.buffer)) {
          buffers.set(this.buffer, ++nextBufferId);
        }
        const event: (typeof events)[number] = {
          sourceId: sourceIds.get(this) ?? 0,
          at: performance.now(),
          bufferId: this.buffer ? (buffers.get(this.buffer) ?? 0) : 0,
          contextId: contextIds.get(this.context) ?? 0,
          duration: this.buffer?.duration ?? 0,
          rate: this.playbackRate.value,
          loop: this.loop,
        };
        events.push(event);
        if (events.length > 512) {
          events.shift();
        }
        queueMicrotask(() => {
          let node: AudioNode | undefined = this;
          for (let hop = 0; node && hop < 8; hop++) {
            if (node instanceof PannerNode) {
              const state = pannerStates.get(node);
              if (state) {
                event.position = {
                  ...state,
                  model: node.panningModel,
                  rolloff: node.rolloffFactor,
                };
              }
              break;
            }
            node = connections.get(node);
          }
          publish();
        });
        // Howler schedules a per-voice rate immediately after start(). AudioParam
        // .value can lag until the next rendering quantum, so observe that schedule.
        rates.set(this.playbackRate, event);
        this.addEventListener(
          'ended',
          () => {
            active.delete(this);
            record('source-ended', describeSource(this));
            publish();
          },
          { once: true }
        );
        publish();
      };
      AudioBufferSourceNode.prototype.stop = function (this: AudioBufferSourceNode, when = 0) {
        stop.call(this, when);
        record('source-stop', { ...describeSource(this), when });
        // Immediate stops release voices now; scheduled synth stops finish through ended.
        if (when <= this.context.currentTime) {
          active.delete(this);
        }
        publish();
      };
      document.addEventListener('DOMContentLoaded', publish, { once: true });
    },
    [enabled, probe.music === true]
  );
}

/** Decode reference audio at the playback context's native sample rate. */
export function readSampleDuration(page: Page, name: string): Promise<number> {
  return page.evaluate(async (sampleName) => {
    const sampleRate = Number(document.documentElement.dataset['audioSampleRate']);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('The audio probe has not observed a playback context');
    }
    const response = await fetch(`/sounds/${sampleName}.m4a`);
    if (!response.ok) {
      throw new Error(`Missing sound ${sampleName}`);
    }
    const context = new OfflineAudioContext(1, 1, sampleRate);
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    return buffer.duration;
  }, name);
}

/** Match the native playback probe to a decoded authored sample.
 * One millisecond covers a single priming sample between Howler and a fresh decode.
 */
export async function readSamplePlaybackRates(page: Page, name: string): Promise<number[]> {
  const duration = await readSampleDuration(page, name);
  return page.evaluate((sampleDuration) => {
    const events: Array<{ duration: number; rate: number }> = JSON.parse(
      document.documentElement.dataset['audioEvents'] ?? '[]'
    );
    return events
      .filter((event) => Math.abs(event.duration - sampleDuration) < 0.001)
      .map((event) => event.rate);
  }, duration);
}

/** Read native context state now, alongside the event-published observation. */
export function readNativeAudioSnapshot(page: Page) {
  return page.evaluate(() => {
    document.dispatchEvent(new Event('georoids-audio-probe-snapshot'));
    const data = document.documentElement.dataset;
    if (!data['nativeAudioContexts'] || !data['audioLifecycle']) {
      throw new Error('Native audio probe is unavailable');
    }
    const parsed: unknown = JSON.parse(data['nativeAudioContexts']);
    if (!Array.isArray(parsed)) {
      throw new Error('Native audio context snapshot is malformed');
    }
    const contexts = parsed.map((row: unknown) => {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('id' in row) ||
        typeof row.id !== 'number' ||
        !('state' in row) ||
        typeof row.state !== 'string' ||
        !('time' in row) ||
        typeof row.time !== 'number'
      ) {
        throw new Error('Native audio context observation is malformed');
      }
      return {
        id: row.id,
        state: row.state,
        time: row.time,
        rawTime: 'rawTime' in row ? row.rawTime : null,
        observedTime: 'observedTime' in row ? row.observedTime : null,
      };
    });
    const lifecycle: unknown = JSON.parse(data['audioLifecycle']);
    return {
      contexts,
      sources: JSON.parse(data['nativeAudioSources'] ?? '[]'),
      activeAudio: data['activeAudio'],
      lifecycleDropped: Number(data['audioLifecycleDropped']),
      cachedStates: data['audioContextStates'],
      activeLoopContexts: data['activeLoopContexts'],
      activeLoops: data['activeLoops'],
      lifecycle,
    };
  });
}
