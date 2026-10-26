#!/usr/bin/env node
/**
 * Deterministic resolver for `docs/wiki-source-review.json`.
 *
 * Every branch appends to this one file, so concurrent branches collide in it
 * routinely. Resolving it by hand is the hazard: the obvious resolution — take
 * the union of both sides — is correct ONLY when the two sides re-recorded
 * disjoint digest sets. When both sides re-recorded the same source, the merged
 * bytes match neither recorded digest, so a union writes a digest for content
 * that does not exist and `npm run check:wiki` still passes, because the ledger
 * is self-consistent and the gate compares digests against files.
 *
 * The rule this resolver enforces: never emit a digest it cannot prove.
 *   - Untouched by both sides  -> the shared value, proven by all three agreeing.
 *   - Changed by exactly one   -> that side's value, proven because only it moved.
 *   - Changed by both          -> reset to the merge-base value, which is stale
 *                                relative to both sides and therefore cannot
 *                                match the merged file, so the source reports as
 *                                pending and has to be reviewed.
 *   - Added by both, differing -> omitted, for the same reason.
 *   - Deleted by either side   -> omitted, which is right whether or not the
 *                                merged tree still holds the file.
 * Omission and a stale value are both safe; a wrong digest is not.
 *
 * `reviews` is append-only by content, not by index: merging main interleaves
 * other branches' batches, so a prefix comparison is the wrong test. Entries are
 * unioned by canonical content, base order first, and dropping a base entry is
 * refused outright.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const LEDGER = 'docs/wiki-source-review.json';

/** Total order on names, so a resolution is byte-identical on every platform. */
function byName(a, b) {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Recursively key-sorted JSON, so two equal entries serialize identically. */
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort(byName)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function parse(text, label) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} is not a ledger object`);
  }
  if (typeof data.hashes !== 'object' || data.hashes === null || Array.isArray(data.hashes)) {
    throw new Error(`${label} has no hashes map`);
  }
  if (!Array.isArray(data.reviews)) {
    throw new Error(`${label} has no reviews array`);
  }
  return data;
}

/** Pick a scalar field three ways, refusing a genuine two-sided edit. */
function pickScalar(field, base, ours, theirs) {
  const b = canonical(base);
  const o = canonical(ours);
  const t = canonical(theirs);
  if (o === t) {
    return ours;
  }
  if (o === b) {
    return theirs;
  }
  if (t === b) {
    return ours;
  }
  throw new Error(`Both sides changed \`${field}\`; resolve that field by hand`);
}

export function mergeLedger(baseText, oursText, theirsText) {
  const base = parse(baseText, 'merge base');
  const ours = parse(oursText, 'ours');
  const theirs = parse(theirsText, 'theirs');

  // reviews: union by content, base order first, then each side's additions.
  const baseKeys = base.reviews.map(canonical);
  const baseSet = new Set(baseKeys);
  for (const [label, side] of [
    ['ours', ours],
    ['theirs', theirs],
  ]) {
    const present = new Set(side.reviews.map(canonical));
    const dropped = baseKeys.filter((key) => !present.has(key));
    if (dropped.length > 0) {
      throw new Error(
        `${label} dropped ${dropped.length} review batch(es) present in the merge base; ` +
          'this ledger is append-only, so resolve it by hand'
      );
    }
  }
  const reviews = [...base.reviews];
  const seen = new Set(baseSet);
  let addedTheirs = 0;
  let addedOurs = 0;
  for (const [label, side] of [
    ['theirs', theirs],
    ['ours', ours],
  ]) {
    for (const entry of side.reviews) {
      const key = canonical(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      reviews.push(entry);
      if (label === 'theirs') {
        addedTheirs += 1;
      } else {
        addedOurs += 1;
      }
    }
  }

  // hashes: proven values only.
  const paths = [
    ...new Set([
      ...Object.keys(base.hashes),
      ...Object.keys(ours.hashes),
      ...Object.keys(theirs.hashes),
    ]),
  ].sort(byName);
  const hashes = {};
  const pending = [];
  const deleted = [];
  let fromOurs = 0;
  let fromTheirs = 0;
  for (const path of paths) {
    const inBase = Object.hasOwn(base.hashes, path);
    const inOurs = Object.hasOwn(ours.hashes, path);
    const inTheirs = Object.hasOwn(theirs.hashes, path);
    if (inBase && (!inOurs || !inTheirs)) {
      // One side removed the source from the inventory; omitting the digest is
      // safe whether or not the merged tree still holds the file.
      deleted.push(path);
      continue;
    }
    const b = inBase ? base.hashes[path] : undefined;
    const o = inOurs ? ours.hashes[path] : undefined;
    const t = inTheirs ? theirs.hashes[path] : undefined;
    const ourChange = inOurs && o !== b;
    const theirChange = inTheirs && t !== b;
    if (ourChange && theirChange) {
      if (o === t) {
        hashes[path] = o;
        continue;
      }
      // Both re-recorded it: the merged bytes match neither. Reset to the base
      // value so the source reports as pending; omit it when there is no base.
      pending.push(path);
      if (inBase) {
        hashes[path] = b;
      }
      continue;
    }
    if (ourChange) {
      hashes[path] = o;
      fromOurs += 1;
      continue;
    }
    if (theirChange) {
      hashes[path] = t;
      fromTheirs += 1;
      continue;
    }
    if (inOurs) {
      hashes[path] = o;
    }
  }

  const ledger = {
    ...('note' in base || 'note' in ours || 'note' in theirs
      ? { note: pickScalar('note', base.note, ours.note, theirs.note) }
      : {}),
    hashes,
    reviews,
  };
  return {
    ledger,
    report: {
      baseReviews: base.reviews.length,
      addedTheirs,
      addedOurs,
      reviews: reviews.length,
      digests: Object.keys(hashes).length,
      fromOurs,
      fromTheirs,
      pending,
      deleted,
    },
  };
}

function format(root, text) {
  try {
    return execFileSync(
      process.execPath,
      [
        resolve(root, 'node_modules/@biomejs/biome/bin/biome'),
        'format',
        `--config-path=${resolve(root, 'config/quality/biome.settings.jsonc')}`,
        '--vcs-enabled=false',
        `--stdin-file-path=${LEDGER}`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        input: text,
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
        // Capture the formatter's own diagnostics instead of letting them print:
        // a missing or failing formatter is a fallback here, not an error.
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
  } catch {
    // The formatter is a convenience here, not the contract; the gate's own
    // format check still fails if this output is not canonical.
    return text;
  }
}

function writeAtomically(target, text) {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function summarize(report) {
  const lines = [
    `reviews: ${report.baseReviews} base + ${report.addedTheirs} theirs + ${report.addedOurs} ours = ${report.reviews}`,
    `digests: ${report.digests} (${report.fromTheirs} from theirs, ${report.fromOurs} from ours)`,
  ];
  if (report.deleted.length > 0) {
    lines.push(`dropped from the inventory: ${report.deleted.join(', ')}`);
  }
  if (report.pending.length > 0) {
    lines.push(
      `left pending for review (both sides re-recorded these): ${report.pending.join(', ')}`,
      'Review those sources and record them with npm run wiki:review before committing.'
    );
  } else {
    lines.push('No source was re-recorded by both sides, so nothing needs re-review.');
  }
  return lines.join('\n');
}

function main(argv) {
  const root = process.cwd();
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  let basePath;
  let oursPath;
  let theirsPath;
  let out;

  if (flags.includes('--merge') || positional.length === 0) {
    // Read the conflict stages git already holds for the ledger.
    const stage = (n) => {
      try {
        return execFileSync('git', ['show', `:${n}:${LEDGER}`], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        return null;
      }
    };
    const [b, o, t] = [stage(1), stage(2), stage(3)];
    if (b === null || o === null || t === null) {
      throw new Error(
        `No three-way conflict is staged for ${LEDGER}. Run this during a conflicted merge, ` +
          'or pass --base/--ours/--theirs explicitly.'
      );
    }
    const { ledger, report } = mergeLedger(b, o, t);
    writeAtomically(resolve(root, LEDGER), format(root, `${JSON.stringify(ledger, null, 2)}\n`));
    process.stdout.write(`Resolved ${LEDGER}\n${summarize(report)}\n`);
    process.stdout.write('Inspect the result, then stage it with git add.\n');
    return;
  }

  if (positional.length >= 3) {
    // Merge-driver positional form: %O %A %B, resolution written back to %A.
    [basePath, oursPath, theirsPath] = positional;
    out = oursPath;
  } else {
    const value = (name) => {
      const hit = argv.find((a) => a.startsWith(`--${name}=`));
      if (hit !== undefined) {
        return hit.slice(name.length + 3);
      }
      const index = argv.indexOf(`--${name}`);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    basePath = value('base');
    oursPath = value('ours');
    theirsPath = value('theirs');
    out = value('out') ?? oursPath;
    if (!basePath || !oursPath || !theirsPath) {
      throw new Error(
        'Usage: merge-wiki-ledger.mjs [--merge] | <base> <ours> <theirs> | ' +
          '--base F --ours F --theirs F [--out F]'
      );
    }
  }

  const { ledger, report } = mergeLedger(
    readFileSync(basePath, 'utf8'),
    readFileSync(oursPath, 'utf8'),
    readFileSync(theirsPath, 'utf8')
  );
  writeAtomically(resolve(root, out), format(root, `${JSON.stringify(ledger, null, 2)}\n`));
  process.stderr.write(`${summarize(report)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`merge-wiki-ledger: ${error.message}\n`);
    process.exit(1);
  }
}
