import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const digest = (value) => createHash('sha256').update(value).digest('hex');
export function reviewSourceIdentity(root) {
  const inventory = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
      ),
    }
  );
  assert.equal(inventory.status, 0, 'Cannot inventory review source');
  const files = [
    ...new Set(
      inventory.stdout
        .split('\0')
        .filter((file) => file && !/^(?:\.performance|logs|node_modules)\//u.test(file))
    ),
  ].sort();
  const rows = files.map((file) => {
    const path = join(root, file);
    if (!existsSync(path) && !lstatExists(path)) {
      return { file, deleted: true };
    }
    const info = lstatSync(path);
    assert(info.isFile() || info.isSymbolicLink(), `Unsupported review source: ${file}`);
    return {
      file,
      mode: info.mode & 0o777,
      kind: info.isSymbolicLink() ? 'symlink' : 'file',
      sha256: digest(info.isSymbolicLink() ? readlinkSync(path) : readFileSync(path)),
    };
  });
  return { sha256: digest(JSON.stringify(rows)), files: rows };
}
function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
