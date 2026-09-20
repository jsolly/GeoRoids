export type MusicBedId = 'menu' | 'inGame';

export type MusicBedCatalog = {
  menu: readonly string[];
  inGame: readonly string[];
};

const PRODUCTION_BEDS: MusicBedCatalog = {
  menu: ['/music/menu-bed.ogg', '/music/menu-bed.mp3'],
  inGame: ['/music/in-game-bed.ogg', '/music/in-game-bed.mp3'],
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
