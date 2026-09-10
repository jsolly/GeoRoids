import { LOCAL_STORAGE_KEYS, soundIsOn } from '../constants/user-preferences';
import { logger } from '../utils/Logger';
import { setStoredItem } from '../utils/safeStorage';

const registeredSounds = new Set<Sound>();

export class Sound {
  streamNum = 0;
  streams: HTMLAudioElement[] = [];
  playing = false;
  private readonly baseVolume: number;

  constructor(src: string, maxStreams: number, vol = 0.05, options?: { loop?: boolean }) {
    // Enforce at least one stream to prevent NaN indexing
    maxStreams = Math.max(1, maxStreams);
    this.baseVolume = vol;
    const loop = options?.loop === true;

    for (let i = 0; i < maxStreams; i++) {
      const audio = new Audio(src);
      audio.volume = vol;
      audio.loop = loop;

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

      try {
        await audio.play();
        this.playing = true;
      } catch (error) {
        logger.error(
          'SOUND',
          'Failed to play audio',
          error instanceof Error ? error : new Error(String(error))
        );
        this.playing = false;
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
