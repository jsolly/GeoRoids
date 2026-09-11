#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DRAFT_BRANCH = 'codex/wiki-drafts';
export const MAIN_BRANCH = 'main';
export const ALLOWED_ROOTS = ['content/wiki', 'public/wiki/uploads'];
export const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const WIKI_SNAPSHOT_MARKER = 'GeoRoids wiki draft snapshot:';
const MAX_SYNC_ATTEMPTS = 3;
const CI_WORKFLOW = 'ci.yml';
const CI_POLL_INTERVAL_MS = 15_000;
const CI_TIMEOUT_MS = 35 * 60 * 1000;
const MERGE_POLL_INTERVAL_MS = 15_000;
const MERGE_TIMEOUT_MS = 15 * 60 * 1000;
const GIT_BOT_NAME = 'github-actions[bot]';
const GIT_BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const GIT_PATH_ENVIRONMENT = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
];

export class PublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
}

function isSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function gitEnvironment() {
  const environment = { ...process.env };
  for (const name of GIT_PATH_ENVIRONMENT) {
    delete environment[name];
  }
  return environment;
}

function normalizeRef(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(/^refs\/heads\//, '');
}

function pathHasUnsafeSegment(path) {
  return (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

export function isAllowedWikiPath(path) {
  if (typeof path !== 'string' || pathHasUnsafeSegment(path)) {
    return false;
  }
  if (path.startsWith('content/wiki/')) {
    return path.toLowerCase().endsWith('.md');
  }
  if (path.startsWith('public/wiki/uploads/')) {
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    return RASTER_EXTENSIONS.has(extension);
  }
  return false;
}

export function isAllowedWikiContextPath(path) {
  if (path === 'content/wiki' || path === 'public/wiki/uploads') {
    return true;
  }
  return isAllowedWikiPath(path);
}

export function parsePagesCmsPayload(rawPayload, { expectedAction = 'publish-wiki' } = {}) {
  if (typeof rawPayload !== 'string' || rawPayload.trim() === '') {
    throw new PublishError('Pages CMS payload is missing');
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (error) {
    throw new PublishError(`Pages CMS payload is not valid JSON: ${String(error)}`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PublishError('Pages CMS payload must be a JSON object');
  }
  if (payload.source !== 'pages-cms') {
    throw new PublishError('Workflow input source is not Pages CMS');
  }
  if (!payload.action || payload.action.name !== expectedAction) {
    throw new PublishError(`Pages CMS action must be ${expectedAction}`);
  }

  const repository = payload.repository;
  if (!repository || typeof repository !== 'object') {
    throw new PublishError('Pages CMS payload has no repository metadata');
  }
  const ref = normalizeRef(repository.ref);
  if (ref !== DRAFT_BRANCH) {
    throw new PublishError(`Pages CMS source ref must be ${DRAFT_BRANCH}; received ${String(ref)}`);
  }
  if (!isSha(repository.sha)) {
    throw new PublishError('Pages CMS repository.sha must be a full 40-character commit SHA');
  }
  if (repository.workflowRef && normalizeRef(repository.workflowRef) !== MAIN_BRANCH) {
    throw new PublishError('Pages CMS workflowRef must point to main');
  }

  const contextPath = payload.context?.path;
  if (contextPath && !isAllowedWikiContextPath(contextPath)) {
    throw new PublishError(
      `Pages CMS context path is outside the wiki publish scope: ${contextPath}`
    );
  }

  return {
    actionName: payload.action.name,
    payload,
    repository,
    sourceRef: ref,
    // Pages CMS resolves repository.sha from the action's workflowRef (main),
    // not from repository.ref (the CMS draft branch). The publisher captures
    // the actual draft head after this payload is validated.
    workflowSha: repository.sha.toLowerCase(),
    contextPath,
  };
}

export function parseGitNameStatus(output) {
  const tokens = output.split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const path = tokens[index + 1];
    if (!status || !path) {
      throw new PublishError('Git returned an incomplete name-status record');
    }
    changes.push({ status: status[0], path });
  }
  return changes;
}

export function parseGitTree(output) {
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf('\t');
      const metadata = separator === -1 ? record : record.slice(0, separator);
      const path = separator === -1 ? '' : record.slice(separator + 1);
      const [mode, type, sha] = metadata.split(' ');
      if (!mode || !type || !sha || !path) {
        throw new PublishError(`Git returned an invalid tree record: ${record}`);
      }
      return { mode, type, sha, path };
    });
}

export function validateChangedPaths(changes) {
  const invalid = changes.filter(({ path }) => !isAllowedWikiPath(path));
  if (invalid.length > 0) {
    const details = invalid.map(({ status, path }) => `${status} ${path}`).join(', ');
    throw new PublishError(`Draft changes outside the wiki publish scope: ${details}`);
  }
  return changes;
}

export function validateWikiTree(entries) {
  const invalid = entries.filter(
    ({ mode, type, path }) => type !== 'blob' || mode !== '100644' || !isAllowedWikiPath(path)
  );
  if (invalid.length > 0) {
    const details = invalid.map(({ mode, type, path }) => `${path} (${mode} ${type})`).join(', ');
    throw new PublishError(`Wiki tree contains an invalid file: ${details}`);
  }
  return entries;
}

export function snapshotBranchName(draftSha) {
  if (!isSha(draftSha)) {
    throw new PublishError('Cannot name a snapshot branch without a full draft SHA');
  }
  return `codex/wiki-publish/${draftSha.toLowerCase()}`;
}

export function buildPullRequestBody({ draftSha, mainSha, snapshotBranch }) {
  return [
    '## Automated wiki publication',
    '',
    'This PR was created by the Pages CMS publish action.',
    '',
    `- Draft branch: \`${DRAFT_BRANCH}\``,
    `- Draft snapshot: \`${draftSha}\``,
    `${WIKI_SNAPSHOT_MARKER} ${draftSha}`,
    `- Main base checked by the publisher: \`${mainSha}\``,
    `- Immutable snapshot branch: \`${snapshotBranch}\``,
    '- Allowed paths: `content/wiki/**/*.md` and `public/wiki/uploads/**/*.{png,jpg,jpeg,webp}`',
    '',
    'The publisher validates the source ref, captured draft SHA, file paths, regular-file modes, and the exact snapshot before it creates this PR.',
  ].join('\n');
}

function gitResult(args) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnvironment(),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function git(args) {
  const result = gitResult(args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new PublishError(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function gitQuiet(args) {
  return gitResult(args).status === 0;
}

function gh(args) {
  try {
    return execFileSync('gh', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new PublishError(`gh ${args.join(' ')} failed: ${detail}`);
  }
}

function ghJson(args) {
  const output = gh(args);
  try {
    return JSON.parse(output || 'null');
  } catch (error) {
    throw new PublishError(`gh returned invalid JSON: ${String(error)}`);
  }
}

function remoteBranchSha(branch) {
  const output = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  const match = output.match(/^([0-9a-f]{40})\s+refs\/heads\/[^\n]+$/m);
  return match ? match[1] : undefined;
}

function fetchBranch(branch) {
  git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

function captureDraftHead() {
  fetchBranch(DRAFT_BRANCH);
  return revParse(`refs/remotes/origin/${DRAFT_BRANCH}`);
}

function revParse(ref) {
  return git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

function isAncestor(ancestor, descendant) {
  return gitQuiet(['merge-base', '--is-ancestor', ancestor, descendant]);
}

function changedPaths(base, head) {
  return parseGitNameStatus(
    git(['diff', '--name-status', '-z', '--no-renames', `${base}...${head}`, '--'])
  );
}

function treeEntries(ref) {
  return parseGitTree(git(['ls-tree', '-r', '-z', '--full-tree', ref, '--', ...ALLOWED_ROOTS]));
}

function validateDraftAt(mainSha, draftSha) {
  validateChangedPaths(changedPaths(mainSha, draftSha));
  validateWikiTree(treeEntries(draftSha));
}

function switchToDetached(ref) {
  git(['switch', '--detach', ref]);
}

function commitTree(treeSha, parents, message) {
  try {
    return execFileSync(
      'git',
      ['commit-tree', treeSha, ...parents.flatMap((parent) => ['-p', parent])],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        input: `${message}\n`,
        env: {
          ...gitEnvironment(),
          GIT_AUTHOR_NAME: GIT_BOT_NAME,
          GIT_AUTHOR_EMAIL: GIT_BOT_EMAIL,
          GIT_COMMITTER_NAME: GIT_BOT_NAME,
          GIT_COMMITTER_EMAIL: GIT_BOT_EMAIL,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new PublishError(`git commit-tree failed: ${detail}`);
  }
}

function entryMap(ref) {
  return new Map(treeEntries(ref).map((entry) => [entry.path, entry]));
}

function normalizeWikiMarkdownText(source) {
  return `${source.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`;
}

function sameTreeEntry(left, right) {
  if (!left || !right) {
    return !left && !right;
  }
  if (left.mode !== right.mode || left.type !== right.type) {
    return false;
  }
  if (left.sha === right.sha) {
    return true;
  }
  return (
    left.type === 'blob' &&
    left.mode === '100644' &&
    isAllowedWikiPath(left.path) &&
    isAllowedWikiPath(right.path) &&
    left.path === right.path &&
    normalizeWikiMarkdownText(git(['cat-file', 'blob', left.sha])) ===
      normalizeWikiMarkdownText(git(['cat-file', 'blob', right.sha]))
  );
}

function publishedSnapshotTrees(mainSha, overlaySha) {
  const fields = git(['log', '--format=%H%x00%B%x00', mainSha]).split('\0');
  const snapshots = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const commitSha = fields[index].trim();
    const message = fields[index + 1];
    const marker = message.match(
      new RegExp(
        `^${WIKI_SNAPSHOT_MARKER.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} ([0-9a-f]{40})$`,
        'im'
      )
    );
    if (!commitSha || !marker) {
      continue;
    }
    const draftSha = marker[1].toLowerCase();
    if (!gitQuiet(['cat-file', '-e', `${draftSha}^{commit}`])) {
      continue;
    }
    if (!isAncestor(draftSha, overlaySha)) {
      continue;
    }
    const entries = entryMap(draftSha);
    validateWikiTree([...entries.values()]);
    snapshots.push({ commitSha, draftSha, entries });
  }
  return snapshots;
}

function pathChangedAfterPublication(publicationSha, mainSha, path) {
  return git(['log', '--format=%H', `${publicationSha}..${mainSha}`, '--', path]).trim() !== '';
}

function normalizeWikiMarkdownFiles(paths) {
  for (const path of paths) {
    if (!path.startsWith('content/wiki/') || !path.toLowerCase().endsWith('.md')) {
      continue;
    }
    const source = readFileSync(path, 'utf8');
    const normalized = normalizeWikiMarkdownText(source);
    if (normalized === source) {
      continue;
    }
    writeFileSync(path, normalized);
    git(['add', '--', path]);
  }
}

function stageCombinedWikiTree(mainSha, overlaySha, { normalizeMarkdown = false } = {}) {
  const mainEntries = validateWikiTree(treeEntries(mainSha));
  const overlayEntries = validateWikiTree(treeEntries(overlaySha));
  const baseSha = git(['merge-base', mainSha, overlaySha]).trim();
  const base = entryMap(baseSha);
  const main = new Map(mainEntries.map((entry) => [entry.path, entry]));
  const overlay = new Map(overlayEntries.map((entry) => [entry.path, entry]));
  const publishedSnapshots = publishedSnapshotTrees(mainSha, overlaySha);
  const paths = new Set([...base.keys(), ...main.keys(), ...overlay.keys()]);
  const useOverlay = new Set();
  const removeFromMain = new Set();

  for (const path of [...paths].sort()) {
    const baseEntry = base.get(path);
    const mainEntry = main.get(path);
    const overlayEntry = overlay.get(path);
    let chooseOverlay = false;

    // Once a path has changed after a publisher snapshot, the merge-base can
    // no longer tell us whether an old draft edit is stale. Preserve main when
    // the draft still has the recorded published value; identical trees are
    // safe; a newer draft edit must stop for an explicit resolution.
    const published = publishedSnapshots[0];
    if (published && pathChangedAfterPublication(published.commitSha, mainSha, path)) {
      if (sameTreeEntry(mainEntry, overlayEntry)) {
        continue;
      }
      if (sameTreeEntry(overlayEntry, published.entries.get(path))) {
        continue;
      }
      throw new PublishError(
        `Wiki path ${path} changed on main after its last published snapshot; resolve it in ${DRAFT_BRANCH}`
      );
    }

    if (sameTreeEntry(mainEntry, baseEntry) || sameTreeEntry(mainEntry, overlayEntry)) {
      if (overlayEntry && !sameTreeEntry(mainEntry, overlayEntry)) {
        chooseOverlay = true;
      } else if (!overlayEntry && mainEntry) {
        removeFromMain.add(path);
      }
      if (chooseOverlay) {
        useOverlay.add(path);
      }
      continue;
    }
    if (sameTreeEntry(overlayEntry, baseEntry)) {
      continue;
    }

    // Each marker describes a complete published wiki tree, so an absent entry
    // is meaningful too (it records that the path did not exist then).
    if (published) {
      const publishedEntry = published.entries.get(path);
      if (sameTreeEntry(mainEntry, publishedEntry)) {
        chooseOverlay = true;
      } else if (sameTreeEntry(overlayEntry, publishedEntry)) {
        continue;
      } else {
        throw new PublishError(
          `Wiki path ${path} changed independently after its last published snapshot; resolve it in ${DRAFT_BRANCH}`
        );
      }
    } else {
      throw new PublishError(
        `Wiki path ${path} changed independently on main and the requested draft; resolve it in ${DRAFT_BRANCH}`
      );
    }

    if (chooseOverlay) {
      if (overlayEntry) {
        useOverlay.add(path);
      } else if (mainEntry) {
        removeFromMain.add(path);
      }
    }
  }

  for (const path of removeFromMain) {
    git(['rm', '-f', '--', path]);
  }
  for (const path of useOverlay) {
    git(['checkout', overlaySha, '--', path]);
  }
  if (normalizeMarkdown) {
    normalizeWikiMarkdownFiles(useOverlay);
  }
  return git(['write-tree']).trim();
}

function combinedTreeCommit(parentSha, mainSha, overlaySha, message, options = {}) {
  switchToDetached(mainSha);
  try {
    const treeSha = stageCombinedWikiTree(mainSha, overlaySha, options);
    const commitSha = commitTree(treeSha, [parentSha, mainSha], message);
    // The workflow checkout is disposable. Clear the temporary overlay before
    // the next branch operation so Git never treats it as an editor change.
    git(['reset', '--hard', mainSha]);
    return commitSha;
  } catch (error) {
    gitResult(['reset', '--hard', mainSha]);
    throw error;
  }
}

export function materializeCombinedTree(parentSha, mainSha, overlaySha, options = {}) {
  return combinedTreeCommit(
    parentSha,
    mainSha,
    overlaySha,
    `chore(wiki): materialize ${overlaySha} on ${mainSha}`,
    options
  );
}

function pushDraftWithLease(expectedSha, commitSha) {
  const result = gitResult([
    'push',
    'origin',
    `--force-with-lease=refs/heads/${DRAFT_BRANCH}:${expectedSha}`,
    `${commitSha}:refs/heads/${DRAFT_BRANCH}`,
  ]);
  if (result.status !== 0) {
    return false;
  }
  return true;
}

function syncDraftBranch(draftSnapshotSha) {
  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    git(['fetch', '--no-tags', 'origin', MAIN_BRANCH]);
    fetchBranch(DRAFT_BRANCH);
    const mainSha = revParse(`refs/remotes/origin/${MAIN_BRANCH}`);
    const draftSha = revParse(`refs/remotes/origin/${DRAFT_BRANCH}`);

    if (!isAncestor(draftSnapshotSha, draftSha)) {
      throw new PublishError(
        `Draft snapshot ${draftSnapshotSha} is not an ancestor of the current ${DRAFT_BRANCH} head ${draftSha}; refuse to publish a rewritten draft branch`
      );
    }
    validateDraftAt(mainSha, draftSha);

    if (isAncestor(mainSha, draftSha)) {
      return { mainSha, draftSha };
    }

    let mergedSha;
    try {
      mergedSha = combinedTreeCommit(
        draftSha,
        mainSha,
        draftSha,
        `chore(wiki): refresh draft branch from ${mainSha}\n\nPreserve the editor tree while adding the current main tree.`
      );
    } catch (error) {
      switchToDetached(mainSha);
      throw error;
    }
    if (pushDraftWithLease(draftSha, mergedSha)) {
      fetchBranch(DRAFT_BRANCH);
      const pushedSha = revParse(`refs/remotes/origin/${DRAFT_BRANCH}`);
      if (pushedSha !== mergedSha) {
        if (isAncestor(mergedSha, pushedSha)) {
          console.warn(
            `An editor saved another commit while ${DRAFT_BRANCH} was syncing; publishing the earlier snapshot and preserving the newer commit`
          );
          return { mainSha, draftSha: mergedSha };
        }
        throw new PublishError(
          `The ${DRAFT_BRANCH} remote head changed unexpectedly while syncing; no snapshot was published`
        );
      }
      return { mainSha, draftSha: pushedSha };
    }

    switchToDetached(mainSha);
    console.warn(
      `The ${DRAFT_BRANCH} branch changed during sync attempt ${attempt}; refetching without overwriting the editor's commit`
    );
  }
  throw new PublishError(
    `${DRAFT_BRANCH} changed during three sync attempts; no editor commit was overwritten. Run Publish wiki again.`
  );
}

function prepareSourceTree(mainSha, sourceSha) {
  if (isAncestor(mainSha, sourceSha)) {
    return sourceSha;
  }
  return combinedTreeCommit(
    sourceSha,
    mainSha,
    sourceSha,
    `chore(wiki): materialize draft snapshot ${sourceSha}\n\nPreserve the exact Pages CMS source tree on current main.`
  );
}

function wikiTreesEquivalent(leftRef, rightRef) {
  const left = entryMap(leftRef);
  const right = entryMap(rightRef);
  const paths = new Set([...left.keys(), ...right.keys()]);
  return [...paths].every((path) => sameTreeEntry(left.get(path), right.get(path)));
}

export function existingSnapshotMatches(snapshotSha, mainSha, sourceTreeSha) {
  validateChangedPaths(changedPaths(mainSha, snapshotSha));
  validateWikiTree(treeEntries(snapshotSha));
  validateWikiTree(treeEntries(sourceTreeSha));
  return wikiTreesEquivalent(sourceTreeSha, snapshotSha);
}

function createSnapshotBranch(mainSha, sourceTreeSha, sourceSha) {
  const branch = snapshotBranchName(sourceSha);
  const existingSha = remoteBranchSha(branch);
  if (existingSha) {
    fetchBranch(branch);
    const remoteSha = revParse(`refs/remotes/origin/${branch}`);
    if (!existingSnapshotMatches(remoteSha, mainSha, sourceTreeSha)) {
      throw new PublishError(
        `Immutable snapshot branch ${branch} exists but does not match source SHA ${sourceSha}; refusing to rewrite it`
      );
    }
    return { branch, sha: remoteSha, changed: true };
  }

  switchToDetached(mainSha);
  const localBranch =
    gitResult(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  if (localBranch) {
    git(['branch', '--delete', '--force', branch]);
  }
  git(['switch', '--create', branch, mainSha]);
  stageCombinedWikiTree(mainSha, sourceTreeSha, { normalizeMarkdown: true });
  if (gitQuiet(['diff', '--cached', '--quiet', '--', ...ALLOWED_ROOTS])) {
    switchToDetached(mainSha);
    return { branch, sha: mainSha, changed: false };
  }
  validateChangedPaths(
    parseGitNameStatus(git(['diff', '--cached', '--name-status', '-z', '--no-renames', '--']))
  );
  git([
    '-c',
    `user.name=${GIT_BOT_NAME}`,
    '-c',
    `user.email=${GIT_BOT_EMAIL}`,
    'commit',
    '--no-verify',
    '-m',
    `docs(wiki): publish draft ${sourceSha}`,
    '-m',
    `Pages CMS source branch: ${DRAFT_BRANCH}\nImmutable source snapshot: ${sourceSha}\n${WIKI_SNAPSHOT_MARKER} ${sourceSha}`,
  ]);
  const snapshotSha = revParse('HEAD');
  validateChangedPaths(changedPaths(mainSha, snapshotSha));
  validateWikiTree(treeEntries(snapshotSha));

  const push = gitResult(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  if (push.status !== 0) {
    const racedSha = remoteBranchSha(branch);
    if (!racedSha) {
      throw new PublishError(
        `Could not create immutable snapshot branch ${branch}: ${push.stderr}`
      );
    }
    fetchBranch(branch);
    const remoteSha = revParse(`refs/remotes/origin/${branch}`);
    if (!existingSnapshotMatches(remoteSha, mainSha, sourceTreeSha)) {
      throw new PublishError(
        `Another run created ${branch} with a different snapshot; refusing to overwrite it`
      );
    }
    switchToDetached(mainSha);
    return { branch, sha: remoteSha, changed: true };
  }
  fetchBranch(branch);
  const pushedSha = revParse(`refs/remotes/origin/${branch}`);
  if (pushedSha !== snapshotSha) {
    throw new PublishError(`Immutable snapshot branch ${branch} changed after it was pushed`);
  }
  return { branch, sha: pushedSha, changed: true };
}

function pullRequestFor(branch) {
  const pullRequests = ghJson([
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--limit',
    '20',
    '--json',
    'number,url,state,baseRefName,headRefName,headRefOid,mergedAt',
  ]);
  return Array.isArray(pullRequests) ? pullRequests[0] : undefined;
}

function ensurePullRequest({ branch, snapshotSha, draftSha, mainSha }) {
  const existing = pullRequestFor(branch);
  if (existing) {
    if (existing.baseRefName !== MAIN_BRANCH || existing.headRefName !== branch) {
      throw new PublishError(
        `Snapshot PR #${existing.number} does not target ${MAIN_BRANCH} from immutable branch ${branch}`
      );
    }
    if (existing.state === 'MERGED' && existing.mergedAt) {
      if (existing.headRefOid !== snapshotSha) {
        throw new PublishError(
          `Merged snapshot PR #${existing.number} no longer points at immutable ${snapshotSha}`
        );
      }
      return { ...existing, alreadyMerged: true };
    }
    if (existing.state === 'MERGED' || existing.mergedAt) {
      throw new PublishError(`Snapshot PR #${existing.number} has an invalid merged state`);
    }
    if (existing.state !== 'OPEN') {
      throw new PublishError(
        `Snapshot PR #${existing.number} is ${existing.state}; refusing to reopen it`
      );
    }
    if (existing.headRefOid !== snapshotSha) {
      throw new PublishError(
        `Snapshot PR #${existing.number} no longer points at immutable ${snapshotSha}`
      );
    }
    return existing;
  }

  const title = `docs(wiki): publish draft ${draftSha}`;
  const body = buildPullRequestBody({ draftSha, mainSha, snapshotBranch: branch });
  const url = gh([
    'pr',
    'create',
    '--base',
    MAIN_BRANCH,
    '--head',
    branch,
    '--title',
    title,
    '--body',
    body,
  ]);
  const created = ghJson([
    'pr',
    'view',
    url,
    '--json',
    'number,url,state,baseRefName,headRefName,headRefOid,mergedAt',
  ]);
  if (!created || created.headRefOid !== snapshotSha) {
    throw new PublishError(`Created PR does not point at immutable snapshot ${snapshotSha}`);
  }
  if (created.baseRefName !== MAIN_BRANCH || created.headRefName !== branch) {
    throw new PublishError(`Created PR does not target ${MAIN_BRANCH} from ${branch}`);
  }
  return created;
}

function latestCiRun(branch, headSha) {
  const runs = ghJson([
    'run',
    'list',
    '--workflow',
    CI_WORKFLOW,
    '--branch',
    branch,
    '--event',
    'workflow_dispatch',
    '--limit',
    '20',
    '--json',
    'databaseId,headSha,status,conclusion,createdAt,updatedAt',
  ]);
  if (!Array.isArray(runs)) {
    return undefined;
  }
  return runs
    .filter((run) => run.headSha === headSha)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
}

function dispatchCi(branch) {
  gh(['workflow', 'run', CI_WORKFLOW, '--ref', branch]);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCi(branch, headSha) {
  let run = latestCiRun(branch, headSha);
  const previousRunId = run?.databaseId;
  let dispatched = false;
  if (!run || (run.status === 'completed' && run.conclusion !== 'success')) {
    dispatchCi(branch);
    dispatched = true;
  }

  const deadline = Date.now() + CI_TIMEOUT_MS;
  while (Date.now() < deadline) {
    run = latestCiRun(branch, headSha);
    if (dispatched && run?.databaseId === previousRunId) {
      await wait(CI_POLL_INTERVAL_MS);
      continue;
    }
    if (run?.status === 'completed') {
      if (run.conclusion === 'success') {
        console.info(`CI / ci passed for ${headSha} (run ${run.databaseId})`);
        return run;
      }
      throw new PublishError(
        `CI / ci failed for immutable snapshot ${headSha} (run ${run.databaseId}, conclusion ${run.conclusion})`
      );
    }
    await wait(CI_POLL_INTERVAL_MS);
  }
  throw new PublishError(`Timed out waiting for CI / ci on immutable snapshot ${headSha}`);
}

function pullRequestView(url) {
  return ghJson([
    'pr',
    'view',
    url,
    '--json',
    'number,url,state,baseRefName,headRefName,headRefOid,mergedAt,mergeStateStatus,autoMergeRequest',
  ]);
}

async function enableAutoMergeAndWait(pullRequest, draftSha, snapshotSha) {
  if (pullRequest.alreadyMerged) {
    console.info(`Wiki snapshot PR #${pullRequest.number} is already merged`);
    return;
  }
  let current = pullRequestView(pullRequest.url);
  if (
    current.baseRefName !== MAIN_BRANCH ||
    current.headRefName !== pullRequest.headRefName ||
    current.headRefOid !== snapshotSha
  ) {
    throw new PublishError(`Snapshot PR #${pullRequest.number} changed before auto-merge`);
  }
  if (current.state === 'MERGED' && current.mergedAt) {
    console.info(`Wiki snapshot PR #${current.number} is already merged`);
    return;
  }
  if (current.state === 'MERGED' || current.mergedAt || current.state !== 'OPEN') {
    throw new PublishError(`Snapshot PR #${current.number} is not open for auto-merge`);
  }
  if (!current.autoMergeRequest) {
    gh([
      'pr',
      'merge',
      pullRequest.url,
      '--auto',
      '--squash',
      '--delete-branch=false',
      '--match-head-commit',
      snapshotSha,
      '--subject',
      `docs(wiki): publish draft ${draftSha}`,
      '--body',
      `${WIKI_SNAPSHOT_MARKER} ${draftSha}`,
    ]);
  }

  const deadline = Date.now() + MERGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    current = pullRequestView(pullRequest.url);
    if (
      current.baseRefName !== MAIN_BRANCH ||
      current.headRefName !== pullRequest.headRefName ||
      current.headRefOid !== snapshotSha
    ) {
      throw new PublishError(`Snapshot PR #${current.number} changed while waiting to merge`);
    }
    if (current.state === 'MERGED' && current.mergedAt) {
      console.info(`Wiki snapshot PR #${current.number} merged with squash auto-merge`);
      return;
    }
    if (current.state === 'MERGED' || current.mergedAt) {
      throw new PublishError(`Snapshot PR #${current.number} has an invalid merged state`);
    }
    if (current.state === 'CLOSED') {
      throw new PublishError(`Wiki snapshot PR #${current.number} closed without merging`);
    }
    if (current.mergeStateStatus === 'DIRTY' || current.mergeStateStatus === 'BEHIND') {
      throw new PublishError(
        `Wiki snapshot PR #${current.number} cannot auto-merge because its immutable branch is ${current.mergeStateStatus}; run Publish wiki again`
      );
    }
    await wait(MERGE_POLL_INTERVAL_MS);
  }
  throw new PublishError(`Timed out waiting for squash auto-merge of PR #${pullRequest.number}`);
}

export function assertWorkflowContext(
  parsed,
  {
    eventRef = process.env.GITHUB_REF || process.env.GITHUB_REF_NAME,
    repositoryName = process.env.GITHUB_REPOSITORY,
  } = {}
) {
  const normalizedEventRef = normalizeRef(eventRef);
  if (normalizedEventRef !== MAIN_BRANCH) {
    throw new PublishError(
      `wiki-publish.yml must run on ${MAIN_BRANCH}; received ${String(normalizedEventRef)}`
    );
  }
  const payloadName = `${parsed.repository.owner}/${parsed.repository.repo}`;
  if (repositoryName && payloadName.toLowerCase() !== repositoryName.toLowerCase()) {
    throw new PublishError(
      `Pages CMS repository ${payloadName} does not match this workflow repository ${repositoryName}`
    );
  }
}

export async function publish() {
  const parsed = parsePagesCmsPayload(process.env.PAGES_CMS_PAYLOAD);
  assertWorkflowContext(parsed);
  const draftSnapshotSha = captureDraftHead();
  const sync = syncDraftBranch(draftSnapshotSha);
  if (!isAncestor(parsed.workflowSha, sync.mainSha)) {
    throw new PublishError(
      `Pages CMS workflow SHA ${parsed.workflowSha} is not an ancestor of current main ${sync.mainSha}`
    );
  }
  const sourceTreeSha = prepareSourceTree(sync.mainSha, draftSnapshotSha);
  const snapshot = createSnapshotBranch(sync.mainSha, sourceTreeSha, draftSnapshotSha);
  if (!snapshot.changed) {
    console.info(`No unpublished wiki changes found on ${DRAFT_BRANCH}; publish is complete`);
    return { status: 'no-changes', ...snapshot };
  }
  const pullRequest = ensurePullRequest({
    branch: snapshot.branch,
    snapshotSha: snapshot.sha,
    draftSha: draftSnapshotSha,
    mainSha: sync.mainSha,
  });
  if (pullRequest.alreadyMerged) {
    return { status: 'merged', ...snapshot, pullRequest };
  }
  await waitForCi(snapshot.branch, snapshot.sha);
  await enableAutoMergeAndWait(pullRequest, draftSnapshotSha, snapshot.sha);
  return { status: 'merged', ...snapshot, pullRequest };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  publish().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`wiki publish failed: ${message}`);
    process.exitCode = 1;
  });
}
