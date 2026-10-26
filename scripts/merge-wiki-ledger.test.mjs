import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'vitest';
import { mergeLedger } from './merge-wiki-ledger.mjs';

const BASE_DIGEST = 'a'.repeat(64);
const OUR_DIGEST = 'b'.repeat(64);
const THEIR_DIGEST = 'c'.repeat(64);
const batch = (note) => ({ note, sources: [], topics: ['terrain'], media: [], owners: {} });
const ledger = (hashes, reviews) => JSON.stringify({ note: 'n', hashes, reviews });

test('a source only one side re-recorded keeps that side’s digest', () => {
  // Independent pins: the three digests differ from each other, so an assertion
  // cannot pass by both sides happening to agree.
  assert.notEqual(BASE_DIGEST, OUR_DIGEST);
  assert.notEqual(BASE_DIGEST, THEIR_DIGEST);
  assert.notEqual(OUR_DIGEST, THEIR_DIGEST);

  const { ledger: merged, report } = mergeLedger(
    ledger({ 'a.ts': BASE_DIGEST, 'b.ts': BASE_DIGEST }, [batch('r1')]),
    ledger({ 'a.ts': OUR_DIGEST, 'b.ts': BASE_DIGEST }, [batch('r1'), batch('ours')]),
    ledger({ 'a.ts': BASE_DIGEST, 'b.ts': THEIR_DIGEST }, [batch('r1'), batch('theirs')])
  );
  assert.equal(merged.hashes['a.ts'], OUR_DIGEST);
  assert.equal(merged.hashes['b.ts'], THEIR_DIGEST);
  assert.deepEqual(report.pending, []);
  assert.equal(report.fromOurs, 1);
  assert.equal(report.fromTheirs, 1);
});

test('a source both sides re-recorded is left pending at the stale base digest', () => {
  // The whole reason this resolver exists. The merged file matches neither
  // side's digest, so emitting either one asserts a digest for content that
  // does not exist — and the wiki gate would still pass, because it compares
  // digests against files and a union is self-consistent.
  const { ledger: merged, report } = mergeLedger(
    ledger({ 'both.ts': BASE_DIGEST }, [batch('r1')]),
    ledger({ 'both.ts': OUR_DIGEST }, [batch('r1')]),
    ledger({ 'both.ts': THEIR_DIGEST }, [batch('r1')])
  );
  assert.equal(merged.hashes['both.ts'], BASE_DIGEST);
  assert.notEqual(merged.hashes['both.ts'], OUR_DIGEST);
  assert.notEqual(merged.hashes['both.ts'], THEIR_DIGEST);
  assert.deepEqual(report.pending, ['both.ts']);
});

test('a key both sides added with differing digests is omitted, not guessed', () => {
  const { ledger: merged, report } = mergeLedger(
    ledger({}, [batch('r1')]),
    ledger({ 'new.ts': OUR_DIGEST }, [batch('r1')]),
    ledger({ 'new.ts': THEIR_DIGEST }, [batch('r1')])
  );
  assert.equal(Object.hasOwn(merged.hashes, 'new.ts'), false);
  assert.deepEqual(report.pending, ['new.ts']);
});

test('a key both sides added with the same digest needs no review', () => {
  const { ledger: merged, report } = mergeLedger(
    ledger({}, [batch('r1')]),
    ledger({ 'new.ts': OUR_DIGEST }, [batch('r1')]),
    ledger({ 'new.ts': OUR_DIGEST }, [batch('r1')])
  );
  assert.equal(merged.hashes['new.ts'], OUR_DIGEST);
  assert.deepEqual(report.pending, []);
});

test('a source one side removed is dropped even when the other re-recorded it', () => {
  const { ledger: merged, report } = mergeLedger(
    ledger({ 'gone.ts': BASE_DIGEST }, [batch('r1')]),
    ledger({}, [batch('r1')]),
    ledger({ 'gone.ts': THEIR_DIGEST }, [batch('r1')])
  );
  assert.equal(Object.hasOwn(merged.hashes, 'gone.ts'), false);
  assert.deepEqual(report.deleted, ['gone.ts']);
});

test('review batches union by content, so interleaved entries are not lost', () => {
  // Merging main interleaves other branches' batches, so the arrays agree on no
  // index beyond the base: ours holds x1 at index 1 while theirs holds m1 there.
  // A prefix comparison calls that a rewrite; the union keeps all four.
  const { ledger: merged, report } = mergeLedger(
    ledger({}, [batch('r1')]),
    ledger({}, [batch('r1'), batch('x1')]),
    ledger({}, [batch('r1'), batch('m1'), batch('m2')])
  );
  assert.deepEqual(
    merged.reviews.map((entry) => entry.note),
    ['r1', 'm1', 'm2', 'x1']
  );
  assert.equal(report.baseReviews, 1);
  assert.equal(report.addedTheirs, 2);
  assert.equal(report.addedOurs, 1);
});

test('dropping a base review batch is refused rather than resolved', () => {
  assert.throws(
    () =>
      mergeLedger(
        ledger({}, [batch('r1'), batch('r2')]),
        ledger({}, [batch('r1')]),
        ledger({}, [batch('r1'), batch('r2'), batch('m1')])
      ),
    /ours dropped 1 review batch\(es\) present in the merge base/u
  );
});

test('a two-sided note edit is refused rather than picked', () => {
  const side = (note) => JSON.stringify({ note, hashes: {}, reviews: [] });
  assert.throws(() => mergeLedger(side('base'), side('ours'), side('theirs')), /note/u);
  // One-sided edits still resolve.
  assert.equal(mergeLedger(side('base'), side('ours'), side('base')).ledger.note, 'ours');
  assert.equal(mergeLedger(side('base'), side('base'), side('theirs')).ledger.note, 'theirs');
});

test('malformed input is refused with the side named', () => {
  assert.throws(
    () => mergeLedger('{', ledger({}, []), ledger({}, [])),
    /merge base is not valid JSON/u
  );
  assert.throws(
    () => mergeLedger(ledger({}, []), '[]', ledger({}, [])),
    /ours is not a ledger object/u
  );
  assert.throws(
    () => mergeLedger(ledger({}, []), JSON.stringify({ hashes: {} }), ledger({}, [])),
    /ours has no reviews array/u
  );
});

test('the resolver reads a real conflict out of the index and resolves the worktree file', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-wiki-ledger-merge-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  const ledgerPath = join(root, 'docs/wiki-source-review.json');
  const write = (hashes, reviews) =>
    writeFileSync(ledgerPath, `${JSON.stringify({ note: 'n', hashes, reviews }, null, 2)}\n`);
  try {
    git('init', '-q');
    git('config', 'user.name', 'Ledger merge contract');
    git('config', 'user.email', 'ledger@example.invalid');
    execFileSync('mkdir', ['-p', join(root, 'docs')]);

    write({ 'both.ts': BASE_DIGEST, 'ours.ts': BASE_DIGEST }, [batch('r1')]);
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    git('checkout', '-q', '-b', 'theirs');
    write({ 'both.ts': THEIR_DIGEST, 'ours.ts': BASE_DIGEST }, [batch('r1'), batch('theirs')]);
    git('commit', '-aqm', 'theirs');

    git('checkout', '-q', base);
    git('checkout', '-q', '-b', 'ours');
    write({ 'both.ts': OUR_DIGEST, 'ours.ts': OUR_DIGEST }, [batch('r1'), batch('ours')]);
    git('commit', '-aqm', 'ours');

    // Prove the premise: this really is a conflict git will not resolve itself.
    let conflicted = false;
    try {
      git('merge', 'theirs');
    } catch {
      conflicted = true;
    }
    assert.equal(
      conflicted,
      true,
      'the ledger must actually conflict for this case to mean anything'
    );
    assert.match(readFileSync(ledgerPath, 'utf8'), /^<{7}/mu);

    const output = execFileSync(
      process.execPath,
      [join(process.cwd(), 'scripts/merge-wiki-ledger.mjs'), '--merge'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      }
    );

    const resolved = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.equal(resolved.hashes['both.ts'], BASE_DIGEST);
    assert.equal(resolved.hashes['ours.ts'], OUR_DIGEST);
    assert.deepEqual(
      resolved.reviews.map((entry) => entry.note),
      ['r1', 'theirs', 'ours']
    );
    assert.match(output, /left pending for review \(both sides re-recorded these\): both\.ts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
