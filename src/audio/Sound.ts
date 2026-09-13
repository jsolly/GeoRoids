import { LOCAL_STORAGE_KEYS, soundIsOn } from '../constants/user-preferences';
import { logger } from '../utils/Logger';
import { setStoredItem } from '../utils/safeStorage';
import { randomPlaybackRate } from './pitch';

const registeredSounds = new Set<Sound>();
const stopHooks = new Set<() => void>();

export function registerSoundStopHook(stop: () => void): void {
  stopHooks.add(stop);
}

export class Sound {
  streamNum = 0;
  streams: HTMLAudioElement[] = [];
  playing = false;
  private readonly baseVolume: number;
  private loopPlayPending = false;
  private playGeneration = 0;

  constructor(src: string, maxStreams: number, vol = 0.05, options?: { loop?: boolean }) {
    // Enforce at least one stream to prevent NaN indexing
    maxStreams = Math.max(1, maxStreams);
    this.baseVolume = vol;
    const loop = options?.loop === true;

    for (let i = 0; i < maxStreams; i++) {
      const audio = new Audio(src);
      audio.volume = vol;
      audio.loop = loop;
      // Playback speed must change pitch too, rather than time-stretching the sample.
      audio.preservesPitch = false;

      // Keep playing flag in sync with actual playback state
      audio.addEventListener('ended', () => {
        this.playing = false;
      });
      audio.addEventListener('pause', () => {
        this.playing = false;
      });

      this.streams.push(audio);
    }

    registeredSounds.add(this);
  }

  async play(volumeScale = 1): Promise<void> {
    if (soundIsOn()) {
      if (this.loopPlayPending) {
        this.setVolumeScale(volumeScale);
        return;
      }
      const scale = Number.isFinite(volumeScale) ? Math.min(1, Math.max(0, volumeScale)) : 1;
      if (scale <= 0) {
        return;
      }

      // Defensive guard against empty streams array
      if (this.streams.length === 0) {
        logger.error('SOUND', 'Sound.play() called but no audio streams available');
        return;
      }

      this.streamNum = (this.streamNum + 1) % this.streams.length;
      const audio = this.streams[this.streamNum];
      if (audio === undefined) {
        logger.error('SOUND', 'Sound.play() called but stream index is out of range');
        return;
      }

      audio.volume = Math.min(1, this.baseVolume * scale);
      audio.playbackRate = randomPlaybackRate();
      audio.currentTime = 0;

      const generation = ++this.playGeneration;
      this.loopPlayPending = audio.loop;
      try {
        await audio.play();
        if (generation === this.playGeneration) {
          this.playing = true;
        }
      } catch (error) {
        // pause() rejects an unfinished browser play with AbortError.
        if (
          generation !== this.playGeneration &&
          error instanceof Error &&
          error.name === 'AbortError'
        ) {
          return;
        }
        logger.error(
          'SOUND',
          'Failed to play audio',
          error instanceof Error ? error : new Error(String(error))
        );
        if (generation === this.playGeneration) {
          this.playing = false;
        }
      } finally {
        if (generation === this.playGeneration) {
          this.loopPlayPending = false;
        }
      }
    }
  }

  setVolumeScale(volumeScale: number): void {
    const scale = Number.isFinite(volumeScale) ? Math.min(1, Math.max(0, volumeScale)) : 1;
    const audio = this.streams[this.streamNum];
    if (audio === undefined) {
      return;
    }
    audio.volume = Math.min(1, this.baseVolume * scale);
  }

  stop(): void {
    this.playGeneration++;
    this.loopPlayPending = false;
    // Defensive guard against empty streams array
    if (this.streams.length === 0) {
      logger.error('SOUND', 'Sound.stop() called but no audio streams available');
      return;
    }

    for (const audio of this.streams) {
      audio.pause();
      audio.currentTime = 0;
    }
    this.playing = false;
  }

  isPlaying(): boolean {
    // Check actual media state when stream exists and is accessible
    if (this.streamNum >= 0 && this.streamNum < this.streams.length) {
      const currentStream = this.streams[this.streamNum];
      if (currentStream) {
        return !currentStream.paused;
      }
    }
    // Fall back to internal flag when no valid stream
    return this.playing;
  }
}

function stopAllSounds(): void {
  for (const stop of stopHooks) {
    stop();
  }
  for (const sound of registeredSounds) {
    sound.stop();
  }
}

export function setSound(pref: boolean): void {
  setStoredItem(LOCAL_STORAGE_KEYS.soundOn, String(pref));
  if (!pref) {
    stopAllSounds();
  }
}

/**
 * Fire-and-forget sound playback with reporting for unexpected failures.
 * volumeScale is 1 for local/full volume; 0 skips playback.
 */
export function playSound(sound: Sound, volumeScale = 1): void {
  sound.play(volumeScale).catch((error: unknown) => {
    logger.error(
      'SOUND',
      'Unexpected sound playback failure',
      error instanceof Error ? error : new Error(String(error))
    );
  });
}
