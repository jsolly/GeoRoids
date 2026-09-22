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
      const rates = new WeakMap<AudioParam, (typeof events)[number]>();
      const buffers = new WeakMap<AudioBuffer, number>();
      let nextBufferId = 0;
      let contexts = 0;
      const contextIds = new WeakMap<BaseAudioContext, number>();
      const contextStates: AudioContextState[] = [];
      let media = 0;
      let decoded = 0;
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
          const id = contexts;
          contextIds.set(this, id);
          const publishState = () => {
            contextStates[id - 1] = this.state;
            if (id === contexts) {
              document.documentElement.dataset['audioContextState'] = this.state;
            }
            publish();
          };
          this.addEventListener('statechange', publishState);
          publishState();
          publish();
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
        if (this.buffer && !buffers.has(this.buffer)) {
          buffers.set(this.buffer, ++nextBufferId);
        }
        const event: (typeof events)[number] = {
          bufferId: this.buffer ? (buffers.get(this.buffer) ?? 0) : 0,
          contextId: contextIds.get(this.context) ?? 0,
          duration: this.buffer?.duration ?? 0,
          rate: this.playbackRate.value,
          loop: this.loop,
        };
        events.push(event);
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
            publish();
          },
          { once: true }
        );
        publish();
      };
      AudioBufferSourceNode.prototype.stop = function (this: AudioBufferSourceNode, when = 0) {
        stop.call(this, when);
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

/** Match the native playback probe to a decoded authored sample.
 * One millisecond covers a single priming sample between Howler and a fresh decode.
 */
export function readSamplePlaybackRates(page: Page, name: string): Promise<number[]> {
  return page.evaluate(async (sampleName) => {
    const response = await fetch(`/sounds/${sampleName}.m4a`);
    if (!response.ok) {
      throw new Error(`Missing sound ${sampleName}`);
    }
    const context = new OfflineAudioContext(1, 1, 48000);
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    const events: Array<{ duration: number; rate: number }> = JSON.parse(
      document.documentElement.dataset['audioEvents'] ?? '[]'
    );
    return events
      .filter((event) => Math.abs(event.duration - buffer.duration) < 0.001)
      .map((event) => event.rate);
  }, name);
}
