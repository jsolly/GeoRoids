export const PLAYER_NAME_MAX_LENGTH = 20;

/** Title-screen nicknames keep letters, numbers, and spaces. */
export function sanitizePlayerName(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLAYER_NAME_MAX_LENGTH);
}
