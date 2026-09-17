import type { Page } from 'playwright';

/** Observe native Web Audio calls without replacing playback or decoding. */
export async function installAudioProbe(page: Page, enabled = true): Promise<void> {
  await page.addInitScript((soundEnabled) => {
    localStorage.setItem('soundOn', String(soundEnabled));
    const events: Array<{ duration: number; rate: number; loop: boolean; bufferId: number }> = [];
    const active = new Set<AudioBufferSourceNode>();
    const rates = new WeakMap<AudioParam, (typeof events)[number]>();
    const buffers = new WeakMap<AudioBuffer, number>();
    let nextBufferId = 0;
    let contexts = 0;
    let media = 0;
    let decoded = 0;
    const publish = () => {
      document.documentElement.dataset['audioEvents'] = JSON.stringify(events);
      document.documentElement.dataset['activeAudio'] = String(active.size);
      document.documentElement.dataset['audioContexts'] = String(contexts);
      document.documentElement.dataset['audioMedia'] = String(media);
      document.documentElement.dataset['decodedAudio'] = String(decoded);
    };
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts++;
        const publishState = () => {
          document.documentElement.dataset['audioContextState'] = this.state;
        };
        this.addEventListener('statechange', publishState);
        publishState();
        publish();
      }
      override decodeAudioData(
        data: ArrayBuffer,
        ...callbacks: [success?: DecodeSuccessCallback | null, failure?: DecodeErrorCallback | null]
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
      const event = rates.get(this);
      if (event) {
        event.rate = value;
        publish();
      }
      return result;
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
      const event = {
        bufferId: this.buffer ? (buffers.get(this.buffer) ?? 0) : 0,
        duration: this.buffer?.duration ?? 0,
        rate: this.playbackRate.value,
        loop: this.loop,
      };
      events.push(event);
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
  }, enabled);
}
