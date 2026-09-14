import type { Howl } from 'howler';
import { LOCAL_STORAGE_KEYS } from '../constants/user-preferences';
import { logger } from '../utils/Logger';
import { setStoredItem } from '../utils/safeStorage';
import { activateAudio, canPlayAudio, muteAudio, registerAudioSound } from './audioRuntime';
import { randomPlaybackRate } from './pitch';

function boundedScale(scale: number): number {
  return Number.isFinite(scale) ? Math.min(1, Math.max(0, scale)) : 1;
}

export class Sound {
  private howl: Howl | undefined;
  private readonly voices = new Set<number>();
  private readonly maxVoices: number;
  private readonly loop: boolean;

  constructor(
    readonly src: string,
    maxStreams: number,
    private readonly baseVolume = 0.05,
    options?: { loop?: boolean }
  ) {
    this.maxVoices = Number.isFinite(maxStreams) ? Math.max(1, Math.floor(maxStreams)) : 1;
    this.loop = options?.loop === true;
    registerAudioSound(
      (audio) => {
        this.howl ??= new audio.Howl({
          src: [src],
          html5: false,
          preload: true,
          autoplay: false,
          loop: this.loop,
          pool: this.maxVoices,
          volume: baseVolume,
          onend: (id) => {
            if (!this.loop) {
              this.voices.delete(id);
            }
          },
          onstop: (id) => this.voices.delete(id),
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
            this.voices.delete(id);
            logger.error('SOUND', 'Failed to play sound', new Error(String(error)), { src });
          },
        });
      },
      () => this.stop()
    );
  }

  async play(volumeScale = 1): Promise<void> {
    const howl = this.howl;
    const scale = boundedScale(volumeScale);
    // Howler queues unloaded/suspended play calls. Never submit stale game cues.
    if (!howl || !canPlayAudio(howl) || scale <= 0) {
      return;
    }
    if (this.loop && this.isPlaying()) {
      this.setVolumeScale(scale);
      return;
    }
    // Howler's pool only bounds idle nodes, not simultaneous playback.
    if (this.voices.size >= this.maxVoices) {
      return;
    }
    const id = howl.play();
    this.voices.add(id);
    howl.volume(Math.min(1, this.baseVolume * scale), id);
    howl.rate(randomPlaybackRate(), id);
  }

  setVolumeScale(volumeScale: number): void {
    for (const id of this.voices) {
      this.howl?.volume(Math.min(1, this.baseVolume * boundedScale(volumeScale)), id);
    }
  }

  stop(): void {
    for (const id of this.voices) {
      this.howl?.stop(id);
    }
    this.voices.clear();
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
    muteAudio();
  }
}

/** volumeScale is 1 for local/full volume; 0 skips playback. */
export function playSound(sound: Sound, volumeScale = 1): void {
  sound.play(volumeScale).catch((error: unknown) => {
    logger.error(
      'SOUND',
      'Unexpected sound playback failure',
      error instanceof Error ? error : new Error(String(error))
    );
  });
}
