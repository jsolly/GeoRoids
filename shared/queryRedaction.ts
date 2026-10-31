/**
 * Query and fragment stripping for diagnostic text, as single forward scans.
 *
 * Each function reproduces one global regex replacement exactly, but the
 * regexes backtracked: every `/` in a long run of path characters restarted a
 * greedy scan to the end of that run, so a string of slashes cost quadratic
 * time and one 150,000-character upload held the report worker for over thirty
 * seconds. Here each run is read once and only its end decides the outcome.
 *
 * Both rest on one property of the old patterns: the `[?#]` that starts the
 * removed text can only follow the end of a maximal run, because neither marker
 * belongs to the run's own character class. So the scan finds a run, checks
 * the character after it, and asks whether the run held a valid match start;
 * the kept text is the same whichever start the regex would have chosen.
 */

/** URL path characters, matched case-insensitively with Unicode folding as before. */
const PATH_RUN = /[a-z0-9._~!$&'()*+,;=:@%/-]+/giu;
const PATH_CHARACTER = /^[a-z0-9._~!$&'()*+,;=:@%/-]$/iu;
const PATH_QUERY = /[^\s"'<>]*/uy;
const LINK_WORD = /[^\s?#]+/gu;
const LINK_QUERY = /\S*/uy;
const LINK_WITH_HOST = /https?:\/\/[^\s?#]/iu;

function isQueryMarker(character: string | undefined): boolean {
  return character === '?' || character === '#';
}

/**
 * Same output as replacing global, case-insensitive Unicode matches of
 * `(\/[a-z0-9._~!$&'()*+,;=:@%/-]+)[?#][^\s"'<>]*` with `$1`.
 *
 * A run matches when it is followed by `?` or `#` and holds a `/` with at least
 * one run character after it; the query, up to whitespace, a quote or an angle
 * bracket, is dropped.
 */
export function dropPathQueries(text: string): string {
  let result = '';
  let copied = 0;
  PATH_RUN.lastIndex = 0;
  for (let run = PATH_RUN.exec(text); run; run = PATH_RUN.exec(text)) {
    const end = PATH_RUN.lastIndex;
    const slash = run[0].indexOf('/');
    if (slash === -1 || slash === run[0].length - 1 || !isQueryMarker(text[end])) {
      continue;
    }
    PATH_QUERY.lastIndex = end + 1;
    PATH_QUERY.exec(text);
    result += text.slice(copied, end);
    copied = PATH_QUERY.lastIndex;
    // A quote ends the query yet is a path character, so a new run may start there.
    PATH_RUN.lastIndex = copied;
  }
  return result + text.slice(copied);
}

/**
 * Same output as replacing global, case-insensitive Unicode matches of
 * `((?:https?:\/\/[^\s?#]+|\/[a-z0-9._~!$&'()*+,;=:@%/-]+))[?#][^\s]*` with `$1`.
 *
 * Both alternatives end where a run of characters other than whitespace, `?`
 * and `#` ends, so a run followed by `?` or `#` matches when it holds an
 * `http://` or `https://` with something after it, or ends in a path-character
 * suffix holding a `/` that is not its last character. The query, up to
 * whitespace, is dropped.
 */
export function dropLinkQueries(text: string): string {
  let result = '';
  let copied = 0;
  LINK_WORD.lastIndex = 0;
  for (let word = LINK_WORD.exec(text); word; word = LINK_WORD.exec(text)) {
    const end = LINK_WORD.lastIndex;
    if (!isQueryMarker(text[end]) || !ownsQuery(word[0])) {
      continue;
    }
    LINK_QUERY.lastIndex = end;
    LINK_QUERY.exec(text);
    result += text.slice(copied, end);
    copied = LINK_QUERY.lastIndex;
    LINK_WORD.lastIndex = copied;
  }
  return result + text.slice(copied);
}

function ownsQuery(word: string): boolean {
  if (LINK_WITH_HOST.test(word)) {
    return true;
  }
  let suffix = word.length;
  while (suffix > 0 && PATH_CHARACTER.test(word.charAt(suffix - 1))) {
    suffix--;
  }
  const slash = word.indexOf('/', suffix);
  return slash !== -1 && slash < word.length - 1;
}
