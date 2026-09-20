export type MusicBedId = 'menu' | 'inGame' | 'danger';

export const MUSIC_BED_IDS = ['menu', 'inGame', 'danger'] as const;

export type MusicBedCatalog = {
  menu: readonly string[];
  inGame: readonly string[];
  danger: readonly string[];
};

const PRODUCTION_BEDS: MusicBedCatalog = {
  menu: ['/music/menu-bed.ogg', '/music/menu-bed.mp3'],
  inGame: ['/music/in-game-bed.ogg', '/music/in-game-bed.mp3'],
  danger: ['/music/danger-bed.ogg', '/music/danger-bed.mp3'],
};

let catalog: MusicBedCatalog = PRODUCTION_BEDS;

export function getMusicBedCatalog(): MusicBedCatalog {
  return catalog;
}

export function musicBedsAreConfigured(): boolean {
  return catalog.menu.length > 0 || catalog.inGame.length > 0;
}

export function setMusicBedCatalogForTests(next: MusicBedCatalog): void {
  catalog = next;
}
