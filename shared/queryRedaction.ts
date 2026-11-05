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

/** Whether `run` holds a `/` at or after `from` with at least one character after it. */
function slashBeforeEnd(run: string, from: number): boolean {
  const slash = run.indexOf('/', from);
  return slash !== -1 && slash < run.length - 1;
}

/**
 * The scan both exports share. `runs` finds maximal runs; a run followed by `?`
 * or `#` that `ownsQuery` accepts keeps its text and loses the query, which
 * `query` measures from the marker. The next run starts where the query ended:
 * a quote ends a path query yet is a path character, so a run may start there.
 */
function dropQueries(
  text: string,
  runs: RegExp,
  ownsQuery: (run: string) => boolean,
  query: RegExp
): string {
  let result = '';
  let copied = 0;
  runs.lastIndex = 0;
  for (let run = runs.exec(text); run; run = runs.exec(text)) {
    const end = runs.lastIndex;
    if (!isQueryMarker(text[end]) || !ownsQuery(run[0])) {
      continue;
    }
    query.lastIndex = end;
    query.exec(text);
    result += text.slice(copied, end);
    copied = query.lastIndex;
    runs.lastIndex = copied;
  }
  return result + text.slice(copied);
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
  return dropQueries(text, PATH_RUN, (run) => slashBeforeEnd(run, 0), PATH_QUERY);
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
  return dropQueries(text, LINK_WORD, linkOwnsQuery, LINK_QUERY);
}

function linkOwnsQuery(word: string): boolean {
  if (LINK_WITH_HOST.test(word)) {
    return true;
  }
  let suffix = word.length;
  while (suffix > 0 && PATH_CHARACTER.test(word.charAt(suffix - 1))) {
    suffix--;
  }
  return slashBeforeEnd(word, suffix);
}
