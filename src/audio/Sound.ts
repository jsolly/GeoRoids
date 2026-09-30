import type { Howl, HowlOptions } from 'howler';
import type { Position } from '../../shared-types';
import { LOCAL_STORAGE_KEYS, soundIsOn } from '../constants/user-preferences';
import { logger } from '../utils/Logger';
import { setStoredItem } from '../utils/safeStorage';
import {
  activateAudio,
  canPlayAudio,
  disposeAudioSound,
  muteSfxKeepSession,
  registerAudioSound,
} from './audioRuntime';

function boundedScale(scale: number): number {
  return Number.isFinite(scale) ? Math.min(1, Math.max(0, scale)) : 1;
}

/** Howler's wall-clock end can discard this handle before native playback ends. */
function nativeVoiceSource(
  howl: Howl,
  id: number
): Pick<OwnedVoice, 'source' | 'reserve'> | undefined {
  if (!('_soundById' in howl) || typeof howl._soundById !== 'function') {
    return undefined;
  }
  const voice: unknown = howl._soundById(id);
  if (
    !voice ||
    typeof voice !== 'object' ||
    !('_node' in voice) ||
    !('_ended' in voice) ||
    typeof voice._ended !== 'boolean' ||
    !('_paused' in voice) ||
    typeof voice._paused !== 'boolean'
  ) {
    return undefined;
  }
  const node = voice._node;
  if (!node || typeof node !== 'object' || !('bufferSource' in node)) {
    return undefined;
  }
  if (!(node.bufferSource instanceof AudioBufferSourceNode)) {
    return undefined;
  }
  return {
    source: node.bufferSource,
    reserve: () => {
      // Native playback still owns this gain/panner even if Howler's timer fired.
      // Both inactive-row reuse and pool drain use _ended; play also uses _paused.
      voice._ended = false;
      voice._paused = false;
    },
  };
}

type OwnedVoice = { source: AudioBufferSourceNode; ended: () => void; reserve: () => void };

export class Sound {
  private howl: Howl | undefined;
  private readonly voices = new Map<number, OwnedVoice>();
  private readonly maxVoices: number;

  constructor(
    readonly src: string,
    maxStreams: number,
    private readonly baseVolume = 0.05
  ) {
    this.maxVoices = Number.isFinite(maxStreams) ? Math.max(1, Math.floor(maxStreams)) : 1;
    registerAudioSound(
      (audio) => {
        // Howler accepts pos at construction; its published typings omit it.
        const options: HowlOptions & { pos: [number, number, number] } = {
          src: [src],
          html5: false,
          preload: true,
          autoplay: false,
          loop: false,
          pool: this.maxVoices,
          volume: baseVolume,
          // Allocate each pooled panner before play: adding one afterwards makes
          // Howler restart the source. Distance gain is handled by spatialAudio.
          pos: [0, 0, -1],
          panningModel: 'HRTF',
          rolloffFactor: 0,
          // Howler's end is a wall timer, not native source completion.
          onstop: (id) => this.releaseVoice(id, true),
          onload: () => {
            const howl = this.howl;
            if (howl && '_webAudio' in howl && howl._webAudio !== true) {
              logger.error(
                'SOUND',
                'Sound transport fell back to unsupported HTML media',
                undefined,
                { src }
              );
            }
          },
          onloaderror: (_id, error) =>
            logger.error('SOUND', 'Failed to load sound', new Error(String(error)), { src }),
          onplayerror: (id, error) => {
            this.releaseVoice(id, true);
            logger.error('SOUND', 'Failed to play sound', new Error(String(error)), { src });
          },
        };
        this.howl ??= new audio.Howl(options);
      },
      () => this.stop(),
      () => {
        this.stop();
        if (this.howl) {
          disposeAudioSound(this.howl);
        }
        this.howl = undefined;
      }
    );
  }

  play(volumeScale = 1, offset?: Position): void {
    this.start(volumeScale, 1, offset);
  }

  /** Tuned phrases must keep exact intervals and advance only when a note sounds. */
  playNote(volumeScale: number, semitones: number, offset?: Position): boolean {
    return this.start(volumeScale, 2 ** (semitones / 12), offset);
  }

  private start(volumeScale: number, rate: number, offset?: Position): boolean {
    const howl = this.howl;
    const scale = boundedScale(volumeScale);
    // Howler queues unloaded/suspended play calls. Never submit stale game cues.
    if (!soundIsOn() || !howl || !canPlayAudio(howl) || scale <= 0) {
      return false;
    }
    // Howler's pool only bounds idle nodes, not simultaneous playback.
    if (this.voices.size >= this.maxVoices) {
      return false;
    }
    for (const voice of this.voices.values()) {
      voice.reserve();
    }
    const id = howl.play();
    const nativeVoice = nativeVoiceSource(howl, id);
    if (!nativeVoice) {
      try {
        howl.stop(id);
      } catch (error: unknown) {
        this.reportCleanupError(error);
      }
      logger.error('SOUND', 'Native sound source ownership unavailable', undefined, {
        src: this.src,
      });
      return false;
    }
    const { source, reserve } = nativeVoice;
    const ended = () => {
      this.releaseVoice(id, false);
      // Native completion can precede the wall timer; retire Howler's pool row too.
      try {
        howl.stop(id);
      } catch (error: unknown) {
        this.reportCleanupError(error);
      }
    };
    this.voices.set(id, { source, ended, reserve });
    source.addEventListener('ended', ended, { once: true });
    howl.volume(Math.min(1, this.baseVolume * scale), id);
    howl.rate(rate, id);
    // Screen right = right; screen up = front. Reset local cues on reused voices.
    howl.pos(offset ? offset.x / 100 : 0, 0, offset ? offset.y / 100 : -1, id);
    return true;
  }

  stop(): void {
    for (const id of [...this.voices.keys()]) {
      this.releaseVoice(id, true);
      try {
        this.howl?.stop(id);
      } catch (error: unknown) {
        this.reportCleanupError(error);
      }
    }
  }

  private releaseVoice(id: number, stop: boolean): void {
    const voice = this.voices.get(id);
    if (!voice) {
      return;
    }
    this.voices.delete(id);
    voice.source.removeEventListener('ended', voice.ended);
    if (stop) {
      try {
        voice.source.stop();
      } catch (error: unknown) {
        this.reportCleanupError(error);
      }
    }
    try {
      voice.source.disconnect();
    } catch (error: unknown) {
      this.reportCleanupError(error);
    }
  }

  private reportCleanupError(error: unknown): void {
    logger.error(
      'SOUND',
      'Native sound source cleanup failed',
      error instanceof Error ? error : new Error(String(error)),
      { src: this.src }
    );
  }

  isPlaying(): boolean {
    return this.voices.size > 0;
  }
}

export function setSound(pref: boolean): void {
  setStoredItem(LOCAL_STORAGE_KEYS.soundOn, String(pref));
  if (pref) {
    activateAudio();
  } else {
    muteSfxKeepSession();
  }
}

/** volumeScale is 1 for local/full volume; 0 skips playback. */
export function playSound(sound: Sound, volumeScale = 1, offset?: Position): void {
  try {
    sound.play(volumeScale, offset);
  } catch (error: unknown) {
    logger.error(
      'SOUND',
      'Unexpected sound playback failure',
      error instanceof Error ? error : new Error(String(error))
    );
  }
}
