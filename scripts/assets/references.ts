import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getMusicBedCatalog } from '../../src/audio/musicCatalog';
import { AUDIO } from '../../src/constants/index';
import { readWikiArticles } from '../wiki-content';

const UPLOAD_IMAGE =
  /<img\b[^>]*\bsrc="(?<path>\/wiki\/uploads\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp))"/gu;
const HTML_UPLOAD =
  /https:\/\/www\.georoids\.com(?<path>\/wiki\/uploads\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp))/gu;

/** Follow production catalogs and published editorial records, never arbitrary public files. */
export async function publishedReferences(root: string): Promise<Set<string>> {
  const paths = new Set<string>(['/favicon.ico']);
  for (const bed of Object.values(getMusicBedCatalog())) {
    for (const path of bed) {
      paths.add(path);
    }
  }
  for (const tuple of Object.values(AUDIO)) {
    if (Array.isArray(tuple) && typeof tuple[0] === 'string') {
      paths.add(tuple[0]);
    }
  }
  for (const article of readWikiArticles(root)) {
    for (const id of article.media) {
      paths.add(`/wiki/media/${id}.gif`);
      paths.add(`/wiki/media/${id}.png`);
    }
    for (const match of article.html.matchAll(UPLOAD_IMAGE)) {
      const path = match.groups?.['path'];
      if (path) {
        paths.add(path);
      }
    }
  }
  for (const page of await readdir(join(root, 'src/pages'))) {
    if (!page.endsWith('.astro')) {
      continue;
    }
    for (const match of (await readFile(join(root, 'src/pages', page), 'utf8')).matchAll(
      HTML_UPLOAD
    )) {
      const path = match.groups?.['path'];
      if (path) {
        paths.add(path);
      }
    }
  }
  return paths;
}
