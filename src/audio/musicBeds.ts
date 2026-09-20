import type { Howl } from 'howler';
import { AUDIO } from '../constants';
import { LOCAL_STORAGE_KEYS, musicIsOn } from '../constants/user-preferences';
import { setStoredItem } from '../utils/safeStorage';
import {
  activateAudio,
  canPlayAudio,
  muteMusicKeepSession,
  registerMusicBedAvailability,
  registerMusicSound,
} from './audioRuntime';
import {
  getMusicBedCatalog,
  type MusicBedCatalog,
  type MusicBedId,
  musicBedsAreConfigured,
  setMusicBedCatalogForTests as setCatalog,
} from './musicCatalog';

type AudioLibrary = typeof import('howler');

const volumes: Record<MusicBedId, number> = {
  menu: AUDIO.MENU_BED_VOLUME,
  inGame: AUDIO.IN_GAME_BED_VOLUME,
};

const howls: Partial<Record<MusicBedId, Howl>> = {};
const fadingOut = new Set<string>();
let current: MusicBedId | null = null;
let currentId: number | undefined;

function fadeKey(kind: MusicBedId, id: number): string {
  return `${kind}:${id}`;
}

function desiredBed(): MusicBedId | null {
  if (!musicIsOn() || document.hidden || !musicBedsAreConfigured()) {
    return null;
  }
  const catalog = getMusicBedCatalog();
  const want: MusicBedId = document.body.classList.contains('in-play') ? 'inGame' : 'menu';
  return catalog[want].length > 0 ? want : null;
}

function stopImmediate(): void {
  fadingOut.clear();
  for (const howl of Object.values(howls)) {
    howl?.stop();
  }
  current = null;
  currentId = undefined;
}

function fadeOut(kind: MusicBedId, id: number): void {
  const howl = howls[kind];
  if (!howl) {
    return;
  }
  // Howler fade(id) does not cancel a live fade; volume() does, and _stopFade
  // emits `fade`. Clear that cancel before marking fade-out or onfade stops
  // the outgoing bed immediately.
  const currentVolume = howl.volume(id);
  const from = typeof currentVolume === 'number' ? currentVolume : volumes[kind];
  howl.volume(from, id);
  fadingOut.add(fadeKey(kind, id));
  howl.fade(from, 0, AUDIO.BED_CROSSFADE_MS, id);
}

function playBed(kind: MusicBedId): void {
  const howl = howls[kind];
  if (!howl || !canPlayAudio(howl)) {
    return;
  }
  if (current === kind && currentId !== undefined && howl.playing(currentId)) {
    return;
  }
  const previous = current;
  const previousId = currentId;
  const id = howl.play();
  current = kind;
  currentId = id;
  howl.volume(0, id);
  howl.fade(0, volumes[kind], AUDIO.BED_CROSSFADE_MS, id);
  if (previous !== null && previous !== kind && previousId !== undefined) {
    fadeOut(previous, previousId);
  }
}

function syncMusicBeds(): void {
  const want = desiredBed();
  if (want === null) {
    if (current !== null && currentId !== undefined) {
      fadeOut(current, currentId);
      current = null;
      currentId = undefined;
    }
    return;
  }
  // activateAudio runs the music initializer, which plays the desired bed
  // once Howler and the shared context are live.
  activateAudio();
}

function ensureHowls(audio: AudioLibrary): void {
  const catalog = getMusicBedCatalog();
  for (const kind of ['menu', 'inGame'] as const) {
    const src = catalog[kind];
    if (src.length === 0 || howls[kind]) {
      continue;
    }
    howls[kind] = new audio.Howl({
      src: [...src],
      html5: false,
      preload: true,
      autoplay: false,
      loop: true,
      pool: 1,
      volume: 0,
      onload: () => {
        syncMusicBeds();
      },
      onloaderror: () => {
        howls[kind]?.unload();
      },
      onplayerror: (id) => {
        howls[kind]?.stop(id);
      },
      onfade: (id) => {
        const howl = howls[kind];
        const faded = howl?.volume(id);
        if (!fadingOut.has(fadeKey(kind, id))) {
          return;
        }
        if (typeof faded === 'number' && faded > 0.0001) {
          return;
        }
        fadingOut.delete(fadeKey(kind, id));
        howl?.stop(id);
      },
    });
  }
}

function startMusic(audio: AudioLibrary): void {
  ensureHowls(audio);
  const want = desiredBed();
  if (want !== null) {
    playBed(want);
  }
}

function onGesture(): void {
  if (musicIsOn() && musicBedsAreConfigured()) {
    activateAudio();
    syncMusicBeds();
  }
}

export function setMusic(pref: boolean): void {
  setStoredItem(LOCAL_STORAGE_KEYS.musicOn, String(pref));
  const checkbox = document.querySelector<HTMLInputElement>('#musicPref');
  if (checkbox) {
    checkbox.checked = pref;
  }
  if (pref) {
    activateAudio();
    syncMusicBeds();
    return;
  }
  muteMusicKeepSession();
}

export function setMusicBedCatalogForTests(next: MusicBedCatalog): void {
  stopImmediate();
  for (const kind of Object.keys(howls) as MusicBedId[]) {
    howls[kind]?.unload();
    delete howls[kind];
  }
  setCatalog(next);
  registerMusicBedAvailability(musicBedsAreConfigured());
}

registerMusicBedAvailability(musicBedsAreConfigured());
registerMusicSound(startMusic, stopImmediate);
window.addEventListener('playViewOn', syncMusicBeds);
window.addEventListener('playViewOff', syncMusicBeds);
document.addEventListener('pointerdown', onGesture, true);
document.addEventListener('keydown', onGesture, true);
