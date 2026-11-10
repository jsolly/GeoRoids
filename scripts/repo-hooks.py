#!/usr/bin/env python3
"""Repository-owned hook trust, installation and dispatch. Python 3.11+, stdlib only."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

FILES = {
    '.git-hooks/pre-commit': 0o755,
    '.git-hooks/pre-push': 0o755,
    'gate/gate-lib.sh': 0o644,
    'gate/hooks/pre-commit': 0o755,
    'gate/hooks/pre-push': 0o755,
    'scripts/repo-hooks.py': 0o755,
    'scripts/repo-python.sh': 0o755,
    'scripts/setup-agent-environment.sh': 0o755,
}
MANIFEST = 'config/agents/repository.json'
LEGACY_MANIFEST = '.repo-independent.json'
# Frozen pre-push allowlist. Upgrade proof still reads that manifest; current bundles use FILES.
LEGACY_FILES = {
    '.git-hooks/pre-commit': 0o755,
    'gate/gate-lib.sh': 0o644,
    'gate/hooks/pre-commit': 0o755,
    'scripts/repo-hooks.py': 0o755,
    'scripts/repo-python.sh': 0o755,
    'scripts/setup-agent-environment.sh': 0o755,
}
CONTEXT = {'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
           'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
           'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE'}


def git(root: Path, *args: str, binary: bool = False) -> str | bytes:
    # Trust reads never use injected Git config, replacement objects or another tree.
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env['GIT_NO_REPLACE_OBJECTS'] = '1'
    p = subprocess.run(['git', '--no-replace-objects', '-C', str(root), *args],
                       env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode:
        raise ValueError('Git trust read failed: ' + ' '.join(args[:2]))
    return p.stdout if binary else p.stdout.decode().strip()


def origin(root: Path) -> str:
    url = str(git(root, 'config', '--local', '--no-includes', '--get', 'remote.origin.url'))
    if url.startswith('git@github.com:'):
        slug = url.removeprefix('git@github.com:')
    else:
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname != 'github.com' or parsed.username or parsed.password:
            raise ValueError('Origin must be credential-free GitHub HTTPS or Git SSH')
        slug = parsed.path.lstrip('/')
    slug = slug.removesuffix('.git').rstrip('/')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', slug):
        raise ValueError('Invalid origin repository identity')
    return slug.lower()


def context(root: Path) -> tuple[Path, Path, str]:
    root = root.resolve(strict=True)
    top = Path(str(git(root, 'rev-parse', '--show-toplevel'))).resolve(strict=True)
    if top != root:
        raise ValueError('Expected the exact repository root')
    common = Path(str(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')))
    if common.is_symlink():
        raise ValueError('Symlinked Git common directory refused')
    return root, common.resolve(strict=True), origin(root)


def regular(root: Path, rel: str, mode: int) -> bytes:
    path = root
    for part in Path(rel).parts:
        path /= part
        if path.is_symlink():
            raise ValueError('Symlink in trusted bundle: ' + rel)
    st = path.stat()
    if not stat.S_ISREG(st.st_mode) or bool(st.st_mode & 0o111) != bool(mode & 0o111) or st.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX | stat.S_IWOTH):
        raise ValueError('Trusted file missing or has wrong mode: ' + rel)
    return path.read_bytes()


def unique_pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('Duplicate manifest key')
        result[key] = value
    return result


def allowlist(manifest_path: str) -> dict[str, int]:
    if manifest_path == MANIFEST:
        return FILES
    if manifest_path == LEGACY_MANIFEST:
        return LEGACY_FILES
    raise ValueError('Unknown manifest path')


def manifest(data: bytes, slug: str, files: dict[str, int]) -> dict:
    value = json.loads(data, object_pairs_hook=unique_pairs)
    if value != {'version': 1, 'repo': slug, 'files': files}:
        raise ValueError('Unknown manifest, repository identity or file allowlist')
    return value


def _bundle(root: Path, slug: str, manifest_path: str, ref: str | None = None) -> tuple[str, dict[str, bytes]]:
    """Read one fixed format; historical reads are limited to installed snapshots/ref proof."""
    files = allowlist(manifest_path)
    if ref is None:
        raw = regular(root, manifest_path, 0o644)
        manifest(raw, slug, files)
        payload = {rel: regular(root, rel, mode) for rel, mode in files.items()}
    else:
        raw = git(root, 'show', f'{ref}:{manifest_path}', binary=True)
        manifest(raw, slug, files)
        payload = {}
        for rel, mode in files.items():
            tree = str(git(root, 'ls-tree', ref, '--', rel))
            if not tree.startswith(f'{0o100000 | mode:o} blob '):
                raise ValueError('Reviewed bundle file missing or has wrong mode: ' + rel)
            payload[rel] = git(root, 'show', f'{ref}:{rel}', binary=True)
        tree = str(git(root, 'ls-tree', ref, '--', manifest_path))
        if not tree.startswith('100644 blob '):
            raise ValueError('Reviewed manifest missing or has wrong mode')
    payload[manifest_path] = raw
    rows = [{'path': rel, 'mode': files.get(rel, 0o644),
             'sha256': hashlib.sha256(data).hexdigest()} for rel, data in sorted(payload.items())]
    digest = hashlib.sha256(json.dumps({'repo': slug, 'files': rows},
                                      sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return digest, payload


def bundle(root: Path, slug: str, ref: str | None = None) -> tuple[str, dict[str, bytes]]:
    retired = root / LEGACY_MANIFEST
    if (ref is None and (retired.exists() or retired.is_symlink())) or (ref is not None and git(root, 'ls-tree', ref, '--', LEGACY_MANIFEST)):
        raise ValueError('Retired root manifest; migrate to config/agents/repository.json in a reviewed change')
    try:
        return _bundle(root, slug, MANIFEST, ref)
    except FileNotFoundError as error:
        raise ValueError('Missing config/agents/repository.json; run reviewed repository setup/upgrade') from error


def approved(root: Path, digest: str) -> bool:
    try:
        values = str(git(root, 'config', '--local', '--no-includes', '--get-all', 'repo.trustedGateBundle'))
    except ValueError:
        return False
    return digest in values.splitlines()


def trusted(root: Path, slug: str, digest: str) -> bool:
    try:
        ref = str(git(root, 'show-ref', '--verify', '--hash', 'refs/remotes/origin/main'))
        if bundle(root, slug, ref)[0] == digest:
            return True
    except (ValueError, FileNotFoundError):
        pass
    return approved(root, digest)


@contextlib.contextmanager
def locked(common: Path):
    fd = os.open(common / 'repo-hooks.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def directory(path: Path):
    if path.is_symlink():
        raise ValueError('Symlinked hook storage refused')
    path.mkdir(mode=0o700, exist_ok=True)
    if not path.is_dir():
        raise ValueError('Hook storage is not a directory')


def snapshot(parent: Path, digest: str, payload: dict[str, bytes], slug: str) -> Path:
    directory(parent)
    dest = parent / digest
    if dest.exists() or dest.is_symlink():
        if dest.is_symlink() or not dest.is_dir():
            raise ValueError('Unsafe existing snapshot')
        if snapshot_bundle(dest, slug) != (digest, MANIFEST):
            raise ValueError('Installed snapshot is corrupt')
        return dest
    staging = Path(tempfile.mkdtemp(prefix='.install-', dir=parent))
    try:
        for rel, data in payload.items():
            target = staging / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            target.chmod(FILES.get(rel, 0o644))
        if bundle(staging, slug)[0] != digest:
            raise ValueError('Snapshot verification failed')
        (staging / 'installation.json').write_text(json.dumps({'version': 2, 'manifest': MANIFEST, 'repo': slug, 'digest': digest}))
        (staging / 'installation.json').chmod(0o600)
        (staging / 'hooks').mkdir(mode=0o700)
        for name in ('pre-commit', 'pre-push'):
            target = staging / 'hooks' / name
            target.write_bytes(payload['gate/hooks/' + name])
            target.chmod(0o755)
        # Rename publishes all bytes at once. Old configured versions remain usable.
        staging.rename(dest)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return dest


def snapshot_bundle(version: Path, slug: str, *, allow_legacy: bool = False) -> tuple[str, str]:
    info = json.loads(regular(version, 'installation.json', 0o644), object_pairs_hook=unique_pairs)
    digest = version.name
    if not re.fullmatch('[0-9a-f]{64}', digest):
        raise ValueError('Installed hook digest is invalid')
    if info == {'repo': slug, 'digest': digest}:
        if not allow_legacy:
            raise ValueError('Legacy installed snapshot; review the new bundle and run approve-upgrade --digest <exact digest>, then install')
        manifest_path = LEGACY_MANIFEST
        if (version / MANIFEST).exists() or (version / MANIFEST).is_symlink():
            raise ValueError('Legacy snapshot contains a second manifest')
    elif info == {'version': 2, 'manifest': MANIFEST, 'repo': slug, 'digest': digest}:
        manifest_path = MANIFEST
        if (version / LEGACY_MANIFEST).exists() or (version / LEGACY_MANIFEST).is_symlink():
            raise ValueError('Snapshot contains a retired manifest')
    else:
        raise ValueError('Installed hook identity/format mismatch')
    if _bundle(version, slug, manifest_path)[0] != digest:
        raise ValueError('Installed hook snapshot is corrupt')
    return digest, manifest_path


def installed_hookdir(common: Path) -> Path:
    """Resolve the repository hook directory selected by core.hooksPath.

    Cursor's agent wrapper may own core.hooksPath and record the repository
    directory in `.cursor-original-hooks-path`. Only that exact forward is accepted.
    """
    configured = Path(str(git(common, 'config', '--local', '--no-includes', '--get', 'core.hooksPath')))
    base = common / 'repo-hooks' / 'versions'

    def selected(path: Path) -> Path | None:
        if not path.is_absolute() or path.is_symlink():
            return None
        try:
            resolved = path.resolve(strict=True)
        except OSError:
            return None
        if resolved.parent.parent != base or resolved.name != 'hooks':
            return None
        return resolved

    direct = selected(configured)
    if direct is not None:
        return direct
    pointer = configured / '.cursor-original-hooks-path'
    if pointer.is_file() and not pointer.is_symlink():
        forwarded = selected(Path(pointer.read_text().strip()))
        if forwarded is not None:
            return forwarded
    raise ValueError('hooksPath does not select this repository common directory')


def verify_installed(common: Path, slug: str, *, allow_legacy: bool = False) -> Path:
    hookdir = installed_hookdir(common)
    version = hookdir.parent
    base = common / 'repo-hooks' / 'versions'
    if any(p.is_symlink() for p in (common / 'repo-hooks', base, version, hookdir)):
        raise ValueError('Symlinked installed hooks refused')
    snapshot_bundle(version, slug, allow_legacy=allow_legacy)
    verify_dispatcher(version)
    return version


def verify_dispatcher(version: Path):
    hookdir = version / 'hooks'
    if hookdir.is_symlink() or not hookdir.is_dir():
        raise ValueError('Unsafe installed dispatcher directory')
    # A snapshot records the dispatchers it contains. Current bundles have pre-commit and
    # pre-push; a previously installed pre-commit-only snapshot stays verifiable.
    expected = {}
    for name in ('pre-commit', 'pre-push'):
        rel = 'gate/hooks/' + name
        candidate = version / rel
        if candidate.exists() or candidate.is_symlink():
            expected[name] = rel
    if 'pre-commit' not in expected:
        raise ValueError('Installed dispatcher is missing pre-commit')
    seen = set()
    for path in hookdir.iterdir():
        rel = expected.get(path.name)
        if rel is None or path.is_symlink() or not path.is_file():
            raise ValueError('Unexpected hook in installed dispatcher directory')
        dispatcher = regular(version, 'hooks/' + path.name, 0o755)
        if stat.S_IMODE(path.stat().st_mode) != 0o755 or dispatcher != regular(version, rel, 0o755):
            raise ValueError('Installed dispatcher differs from its verified snapshot')
        seen.add(path.name)
    if seen != set(expected):
        raise ValueError('Installed dispatcher is missing a repository hook')


def approve_upgrade(root: Path, common: Path, slug: str, digest: str):
    installed = verify_installed(common, slug, allow_legacy=True)
    old_digest, format_path = snapshot_bundle(installed, slug, allow_legacy=True)
    if format_path == MANIFEST:
        if old_digest == digest and trusted(root, slug, digest):
            print('Current repository bundle already installed and trusted')
            return
        raise ValueError('Installed format is current; use ordinary exact-digest approve')
    authorized = approved(root, old_digest)
    if not authorized:
        try:
            ref = str(git(root, 'show-ref', '--verify', '--hash', 'refs/remotes/origin/main'))
            if git(root, 'ls-tree', ref, '--', MANIFEST):
                raise ValueError('Protected source no longer has the historical format')
            authorized = _bundle(root, slug, LEGACY_MANIFEST, ref)[0] == old_digest
        except (ValueError, OSError):
            pass
    if not authorized:
        raise ValueError('Legacy installed bundle is not refreshed reviewed origin/main or an existing exact approval; no approval changed')
    if not approved(root, digest):
        git(root, 'config', '--local', '--add', 'repo.trustedGateBundle', digest)
    print('Approved exact repository upgrade bundle: ' + digest)


def install(root: Path, common: Path, slug: str, digest: str, payload: dict[str, bytes]):
    if not trusted(root, slug, digest):
        raise ValueError('Setup bundle is not reviewed origin/main or an approved exact digest; no installation changed')
    storage = common / 'repo-hooks'
    directory(storage)
    versions = storage / 'versions'
    version = snapshot(versions, digest, payload, slug)
    hooks = version / 'hooks'
    # Validate the entire destination before making it live, including an existing
    # digest directory left by a partial or interrupted installation.
    snapshot_bundle(version, slug)
    verify_dispatcher(version)
    git(root, 'config', '--local', 'core.hooksPath', str(hooks))
    for row in str(git(root, 'worktree', 'list', '--porcelain')).splitlines():
        if not row.startswith('worktree '):
            continue
        wt = Path(row.removeprefix('worktree '))
        try:
            scoped = str(git(wt, 'config', '--show-scope', '--get', 'core.hooksPath'))
        except ValueError:
            continue
        if scoped.startswith('worktree\t'):
            git(wt, 'config', '--worktree', 'core.hooksPath', str(hooks))
    verify_installed(common, slug)
    print('Repository-owned hooks installed: ' + str(hooks))


def dispatch(root: Path, common: Path, slug: str, digest: str, payload: dict[str, bytes], entry: str = '.git-hooks/pre-commit', hook_args: tuple[str, ...] = ()):
    installed = verify_installed(common, slug)
    for rel in ['scripts/repo-hooks.py', 'scripts/repo-python.sh', 'gate/hooks/pre-commit', 'gate/hooks/pre-push']:
        installed_copy = installed / rel
        if not installed_copy.is_file() or installed_copy.is_symlink() or installed_copy.read_bytes() != payload[rel]:
            raise ValueError('Trust implementation changed; run reviewed repository setup before dispatch')
    # Do not let a worktree override select another dispatcher. The Cursor agent
    # wrapper may own hooksPath when its pointer names this installed directory.
    effective = Path(str(git(root, 'config', '--type=path', '--get', 'core.hooksPath')))
    installed_hooks = (installed / 'hooks').resolve()
    forwarded = None
    pointer = effective / '.cursor-original-hooks-path'
    if pointer.is_file() and not pointer.is_symlink():
        forwarded = Path(pointer.read_text().strip())
    if effective.resolve() != installed_hooks and (forwarded is None or forwarded.resolve() != installed_hooks):
        raise ValueError('Worktree hooksPath override is stale; run reviewed repository setup')
    if not trusted(root, slug, digest):
        raise ValueError('Unreviewed hook/setup/library bundle; review and approve exact digest ' + digest)
    snap = snapshot(common / 'repo-hooks' / 'bundles', digest, payload, slug)
    env = {k: v for k, v in os.environ.items() if k not in CONTEXT}
    # Git supplies a temporary committing index for -a and path-limited commits.
    # Trust reads ignore it, but staged scanning must use that exact index.
    committing_index = os.environ.get('GIT_INDEX_FILE')
    if committing_index:
        index = Path(committing_index)
        if not index.is_absolute():
            index = root / index
        if index.is_symlink():
            raise ValueError('Symlinked committing index refused')
        index = index.resolve(strict=True)
        gitdir = Path(str(git(root, 'rev-parse', '--absolute-git-dir'))).resolve(strict=True)
        if index.parent != gitdir or not (index.name in {'index', 'index.lock'} or re.fullmatch(r'next-index-[0-9]+\.lock', index.name)):
            raise ValueError('Committing index is outside this worktree Git directory')
        env['GIT_INDEX_FILE'] = str(index)
    # Snapshot shim sources snapshot library; quality scripts run in the committing root.
    os.chdir(root)
    target = snap / entry
    os.execve(str(target), [str(target), *hook_args], env)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['install', 'dispatch', 'dispatch-push', 'verify', 'digest', 'approve', 'approve-upgrade'])
    parser.add_argument('hook_args', nargs='*')
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--digest')
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise ValueError('Python >= 3.11 is required before installing repository hooks')
    root, common, slug = context(args.root)
    with locked(common):
        digest, payload = bundle(root, slug)
        if args.command == 'digest':
            print(digest)
        elif args.command in {'approve', 'approve-upgrade'}:
            if args.digest != digest or not re.fullmatch('[0-9a-f]{64}', args.digest or ''):
                raise ValueError('Approval requires the exact reviewed current bundle digest')
            if args.command == 'approve-upgrade':
                approve_upgrade(root, common, slug, digest)
            else:
                verify_installed(common, slug)
                if not approved(root, digest):
                    git(root, 'config', '--local', '--add', 'repo.trustedGateBundle', digest)
                print('Approved exact repository bundle: ' + digest)
        elif args.command == 'install':
            install(root, common, slug, digest, payload)
        elif args.command == 'verify':
            installed = verify_installed(common, slug)
            if installed.name != digest:
                raise ValueError('Installed bundle is stale; run reviewed repository setup')
            if not trusted(root, slug, digest):
                raise ValueError('Current source bundle is not trusted')
            print('Repository-owned hooks verified')
        elif args.command == 'dispatch-push':
            dispatch(root, common, slug, digest, payload, entry='.git-hooks/pre-push', hook_args=tuple(args.hook_args))
        else:
            dispatch(root, common, slug, digest, payload)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print('repo-hooks: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
