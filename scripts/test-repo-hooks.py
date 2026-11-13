#!/usr/bin/env python3
"""Exercise this repository's hook trust with real Git and an isolated home."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent
BUNDLE = ('config/agents/repository.json', 'gate/gate-lib.sh', 'gate/hooks/pre-commit',
          'gate/hooks/pre-push', '.git-hooks/pre-push',
          'scripts/repo-hooks.py', 'scripts/repo-python.sh', 'scripts/setup-agent-environment.sh')


def gate_pin(name):
    lib = (SOURCE / 'gate/gate-lib.sh').read_text()
    return next(line.split('=', 1)[1].strip('"') for line in lib.splitlines() if line.startswith(name + '='))


def pinned_versions():
    """What each scanner prints for its version at the gate library's pins."""
    return {'gitleaks': gate_pin('GATE_GITLEAKS_VERSION'),
            'zizmor': 'zizmor ' + gate_pin('GATE_ZIZMOR_VERSION'),
            'osv-scanner': 'osv-scanner version: ' + gate_pin('GATE_OSV_SCANNER_VERSION'),
            'semgrep': gate_pin('GATE_SEMGREP_VERSION')}


def write_executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


class HookTrust(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.scratch = Path(scratch.name).resolve()
        self.root = self.scratch / 'repo'
        self.home = self.scratch / 'home'
        self.root.mkdir()
        self.home.mkdir()
        config = self.home / 'fixture.gitconfig'
        config.write_text('[maintenance]\n    auto = false\n')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_', 'PYTHON'))}
        self.env.update(HOME=str(self.home), GIT_CONFIG_GLOBAL=str(config), GIT_CONFIG_NOSYSTEM='1',
                        GIT_AUTHOR_NAME='fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                        GIT_COMMITTER_NAME='fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid')
        self.git('init', '-q', '-b', 'main')
        for name in BUNDLE:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SOURCE / name, target)
        slug = json.loads((self.root / 'config/agents/repository.json').read_text())['repo']
        self.git('remote', 'add', 'origin', 'https://github.com/' + slug + '.git')
        (self.root / '.git-hooks').mkdir(exist_ok=True)
        floor = (SOURCE / '.git-hooks/pre-commit').read_text().splitlines()[1]
        hook = self.root / '.git-hooks/pre-commit'
        hook.write_text('#!/usr/bin/env bash\n' + floor + '''
set -euo pipefail
owner="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$owner/gate/gate-lib.sh"
gate_enter_committing_tree "${BASH_SOURCE[0]}"
printf 'fixture-root=%s\\n' "$ROOT"
gate_gitleaks_bin() { printf '%s\\n' "$ROOT/tools/fixture-gitleaks"; }
gate_secrets_scan_staged
''')
        hook.chmod(0o755)
        tools = self.root / 'tools'
        tools.mkdir()
        scanner = tools / 'fixture-gitleaks'
        scanner.write_text('''#!/usr/bin/env bash
if git diff --cached --text | grep -q REPO_FIXTURE_SECRET; then
  echo fixture-secret-found >&2
  exit 1
fi
''')
        scanner.chmod(0o755)
        (self.root / 'content.txt').write_text('safe baseline\n')
        self.git('add', '-A')
        self.git('commit', '-qm', 'fixture baseline')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.tool('install', check=True)
        self.hooks = Path(self.git('config', '--get', 'core.hooksPath').stdout.strip())
        self.installed = self.hooks.parent / 'scripts/repo-hooks.py'

    def test_dispatcher_registers_only_pre_commit_and_pre_push(self):
        self.assertEqual(sorted(path.name for path in self.hooks.iterdir()), ['pre-commit', 'pre-push'])
        self.assertEqual((self.hooks / 'pre-push').read_bytes(), (self.root / 'gate/hooks/pre-push').read_bytes())
        self.assertNotEqual((self.hooks / 'pre-push').read_bytes(), (self.root / '.git-hooks/pre-push').read_bytes())

    def test_cursor_wrapper_forwards_only_to_the_installed_dispatcher(self):
        wrapper = self.scratch / 'cursor-wrapper'
        wrapper.mkdir()
        (wrapper / '.cursor-original-hooks-path').write_text(str(self.hooks) + '\n')
        self.git('config', '--local', 'core.hooksPath', str(wrapper))
        result = self.dispatch()
        self.assertEqual(result.returncode, 0, result.stderr)
        (wrapper / '.cursor-original-hooks-path').write_text(str(self.scratch / 'missing-hooks') + '\n')
        result = self.dispatch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('hooksPath', result.stderr)

    def git(self, *args, root=None, check=True):
        return subprocess.run(['git', '-C', str(root or self.root), *args], env=self.env,
                              text=True, capture_output=True, check=check)

    def tool(self, command, *args, installed=False, check=False):
        path = self.installed if installed else self.root / 'scripts/repo-hooks.py'
        return subprocess.run([sys.executable, '-I', str(path), command, '--root', str(self.root), *args],
                              cwd=self.root, env=self.env, text=True, capture_output=True, check=check)

    def dispatch(self, root=None):
        return subprocess.run([str(self.hooks / 'pre-commit')], cwd=root or self.root,
                              env=self.env, text=True, capture_output=True)

    def test_fresh_home_and_linked_worktree_run_the_committing_tree(self):
        self.assertFalse((self.home / 'code/dotagents').exists())
        result = self.dispatch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('fixture-root=' + str(self.root), result.stdout)
        linked = self.scratch / 'linked'
        self.git('worktree', 'add', '-qb', 'linked', str(linked))
        result = self.dispatch(linked)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('fixture-root=' + str(linked), result.stdout)

    def test_unreviewed_library_is_not_executed_or_installed(self):
        lib = self.root / 'gate/gate-lib.sh'
        marker = self.scratch / 'untrusted-executed'
        lib.write_text('touch "' + str(marker) + '"\n' + lib.read_text())
        before = self.git('config', '--get', 'core.hooksPath').stdout
        self.assertNotEqual(self.dispatch().returncode, 0)
        self.assertNotEqual(self.tool('install', installed=True).returncode, 0)
        self.assertFalse(marker.exists())
        self.assertEqual(before, self.git('config', '--get', 'core.hooksPath').stdout)

    def test_exact_bundle_approval_can_be_revoked(self):
        hook = self.root / '.git-hooks/pre-commit'
        hook.write_text(hook.read_text() + '\necho reviewed-change\n')
        digest = self.tool('digest', installed=True, check=True).stdout.strip()
        self.tool('approve', '--digest', digest, installed=True, check=True)
        self.assertEqual(self.dispatch().returncode, 0)
        self.git('config', '--local', '--unset-all', 'repo.trustedGateBundle')
        self.assertNotEqual(self.dispatch().returncode, 0)

    def test_origin_and_symlink_changes_refuse_valid_bundle(self):
        self.assertEqual(self.dispatch().returncode, 0)
        self.git('remote', 'set-url', 'origin', 'https://github.com/foreign/fixture.git')
        self.assertNotEqual(self.dispatch().returncode, 0)
        slug = json.loads((self.root / 'config/agents/repository.json').read_text())['repo']
        self.git('remote', 'set-url', 'origin', 'https://github.com/' + slug + '.git')
        self.assertEqual(self.dispatch().returncode, 0)
        hook = self.root / '.git-hooks/pre-commit'
        outside = self.scratch / 'outside-hook'
        outside.write_bytes(hook.read_bytes())
        outside.chmod(0o755)
        hook.unlink()
        hook.symlink_to(outside)
        self.assertNotEqual(self.dispatch().returncode, 0)

    def test_actual_commits_scan_both_temporary_index_forms(self):
        for options in [('-a',), ('--', 'content.txt')]:
            with self.subTest(options=options):
                (self.root / 'content.txt').write_text('REPO_FIXTURE_SECRET\n')
                result = self.git('commit', '-m', 'must refuse', *options, check=False)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('fixture-secret-found', result.stderr)
                (self.root / 'content.txt').write_text('safe updated ' + str(options) + '\n')
                result = self.git('commit', '-m', 'safe commit', *options, check=False)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


    def legacy_upgrade_fixture(self):
        """Install the frozen real pre-migration helper, then prepare a new candidate."""
        candidate = (self.root / 'scripts/repo-hooks.py').read_bytes()
        marker = self.root / 'config/agents/repository.json'
        original_marker = marker.read_bytes()
        slug = json.loads(original_marker)['repo']
        legacy = self.root / '.repo-independent.json'
        # The frozen helper's allowlist has no pre-push entry. Write that manifest
        # explicitly; renaming today's manifest would fail its equality check.
        legacy_files = {
            '.git-hooks/pre-commit': 493,
            'gate/gate-lib.sh': 420,
            'gate/hooks/pre-commit': 493,
            'scripts/repo-hooks.py': 493,
            'scripts/repo-python.sh': 493,
            'scripts/setup-agent-environment.sh': 493,
        }
        marker.unlink()
        legacy.write_text(json.dumps({'version': 1, 'repo': slug, 'files': legacy_files}) + '\n')
        (self.root / 'scripts/repo-hooks.py').write_bytes((SOURCE / 'scripts/fixtures/repo-hooks-legacy.py').read_bytes())
        self.git('add', '-A')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'reviewed old format')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.tool('install', check=True)
        self.hooks = Path(self.git('config', '--get', 'core.hooksPath').stdout.strip())
        self.installed = self.hooks.parent / 'scripts/repo-hooks.py'
        legacy.unlink()
        marker.write_bytes(original_marker)
        (self.root / 'scripts/repo-hooks.py').write_bytes(candidate)
        return self.tool('digest', check=True).stdout.strip()

    def test_actual_legacy_installation_upgrades_by_exact_reviewed_approval(self):
        digest = self.legacy_upgrade_fixture()
        self.assertNotEqual(self.tool('approve', '--digest', digest).returncode, 0)
        self.assertNotEqual(self.tool('install').returncode, 0)
        self.assertNotEqual(self.tool('approve-upgrade', '--digest', '0' * 64).returncode, 0)
        self.tool('approve-upgrade', '--digest', digest, check=True)
        self.tool('approve-upgrade', '--digest', digest, check=True)
        values = self.git('config', '--get-all', 'repo.trustedGateBundle').stdout.splitlines()
        self.assertEqual(values.count(digest), 1)
        self.tool('install', check=True)
        self.tool('verify', check=True)
        self.tool('approve-upgrade', '--digest', digest, check=True)
        self.hooks = Path(self.git('config', '--get', 'core.hooksPath').stdout.strip())
        self.assertEqual(self.dispatch().returncode, 0)

    def test_upgrade_reauthorizes_old_snapshot_and_preserves_failed_approval(self):
        digest = self.legacy_upgrade_fixture()
        self.git('update-ref', '-d', 'refs/remotes/origin/main')
        result = self.tool('approve-upgrade', '--digest', digest)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Legacy installed bundle is not', result.stderr)
        self.assertNotEqual(self.git('config', '--get-all', 'repo.trustedGateBundle', check=False).returncode, 0)
        old_digest = self.hooks.parent.name
        self.git('config', '--local', '--add', 'repo.trustedGateBundle', old_digest)
        self.tool('approve-upgrade', '--digest', digest, check=True)
        self.tool('install', check=True)

    def test_upgrade_refuses_snapshot_metadata_dispatcher_and_bundle_tamper(self):
        digest = self.legacy_upgrade_fixture()
        version = self.hooks.parent
        for rel in ('installation.json', 'hooks/pre-commit', 'gate/gate-lib.sh'):
            with self.subTest(path=rel):
                path = version / rel
                original = path.read_bytes()
                path.write_bytes(original + b'\n# tamper\n')
                self.assertNotEqual(self.tool('approve-upgrade', '--digest', digest).returncode, 0)
                path.write_bytes(original)
        self.git('remote', 'set-url', 'origin', 'https://github.com/other/fixture.git')
        self.assertNotEqual(self.tool('approve-upgrade', '--digest', digest).returncode, 0)

    def test_legacy_upgrade_refuses_unsafe_modes_without_changing_trust(self):
        digest = self.legacy_upgrade_fixture()
        version = self.hooks.parent
        self.git('config', '--local', '--add', 'repo.trustedGateBundle', version.name)
        config = self.root / '.git/config'
        before_config = config.read_bytes()
        before_approvals = self.git('config', '--get-all', 'repo.trustedGateBundle').stdout
        before_hooks = self.git('config', '--get', 'core.hooksPath').stdout
        cases = (('.repo-independent.json', 0o755),
                 ('installation.json', 0o666),
                 ('hooks/pre-commit', 0o744))
        for rel, unsafe_mode in cases:
            with self.subTest(path=rel, mode=oct(unsafe_mode)):
                path = version / rel
                original_mode = stat.S_IMODE(path.stat().st_mode)
                original_bytes = path.read_bytes()
                try:
                    path.chmod(unsafe_mode)
                    result = self.tool('approve-upgrade', '--digest', digest)
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(config.read_bytes(), before_config)
                    self.assertEqual(self.git('config', '--get-all', 'repo.trustedGateBundle').stdout,
                                     before_approvals)
                    self.assertEqual(self.git('config', '--get', 'core.hooksPath').stdout, before_hooks)
                    self.assertEqual(path.read_bytes(), original_bytes)
                finally:
                    path.chmod(original_mode)
        # Each independent mode mutation is restored; the valid snapshot still upgrades.
        self.tool('approve-upgrade', '--digest', digest, check=True)
        self.tool('install', check=True)
        self.tool('verify', check=True)

    def test_existing_destination_with_extra_hook_is_refused_before_reconfiguration(self):
        digest = self.legacy_upgrade_fixture()
        self.tool('approve-upgrade', '--digest', digest, check=True)
        before = self.git('config', '--get', 'core.hooksPath').stdout
        spec = importlib.util.spec_from_file_location('candidate_hooks', self.root / 'scripts/repo-hooks.py')
        candidate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(candidate)
        _, common, slug = candidate.context(self.root)
        actual_digest, payload = candidate.bundle(self.root, slug)
        self.assertEqual(actual_digest, digest)
        destination = candidate.snapshot(common / 'repo-hooks/versions', digest, payload, slug)
        extra = destination / 'hooks/post-checkout'
        extra.write_text('#!/bin/sh\ntouch "' + str(self.root / 'unreviewed-hook-ran') + '"\n')
        extra.chmod(0o755)
        result = self.tool('install')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unexpected hook', result.stderr)
        self.assertEqual(self.git('config', '--get', 'core.hooksPath').stdout, before)
        self.git('checkout', '-q', '--detach', 'HEAD')
        self.assertFalse((self.root / 'unreviewed-hook-ran').exists())

    def test_current_layout_refuses_old_missing_and_symlinked_manifest_owners(self):
        marker = self.root / 'config/agents/repository.json'
        original = marker.read_bytes()
        marker.unlink()
        result = self.tool('digest')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing config/agents/repository.json', result.stderr)
        marker.write_bytes(original)
        retired = self.root / '.repo-independent.json'
        retired.symlink_to('missing')
        self.assertNotEqual(self.tool('digest').returncode, 0)
        retired.unlink()
        marker.unlink(); marker.symlink_to(self.root / 'outside-manifest')
        self.assertNotEqual(self.tool('digest').returncode, 0)

    def test_protected_new_source_installs_over_old_snapshot_without_approval(self):
        self.legacy_upgrade_fixture()
        self.git('add', '-A')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'reviewed new format')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.tool('install', check=True)
        self.tool('verify', check=True)
        self.assertNotEqual(self.git('config', '--get-all', 'repo.trustedGateBundle', check=False).returncode, 0)

    def test_install_metadata_is_private_under_each_supported_umask(self):
        hook = self.root / '.git-hooks/pre-commit'
        for mask in (0o000, 0o022, 0o077):
            with self.subTest(umask=oct(mask)):
                hook.write_text(hook.read_text() + '\n# fresh snapshot for umask ' + oct(mask) + '\n')
                digest = self.tool('digest', check=True).stdout.strip()
                self.git('config', '--local', '--add', 'repo.trustedGateBundle', digest)
                for _ in range(2):
                    result = subprocess.run([sys.executable, '-I', str(self.root / 'scripts/repo-hooks.py'),
                                             'install', '--root', str(self.root)], cwd=self.root,
                                            env=self.env, capture_output=True, text=True, umask=mask)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.tool('verify', check=True)
                configured = subprocess.check_output(['git', '-C', str(self.root), 'config', '--local',
                                                      '--get', 'core.hooksPath'], env=self.env, text=True).strip()
                metadata = Path(configured).parent / 'installation.json'
                self.assertEqual(stat.S_IMODE(metadata.stat().st_mode), 0o600)

    def test_install_rejects_invalid_fresh_snapshot_before_registration(self):
        spec = importlib.util.spec_from_file_location('fixture_current_hooks', self.root / 'scripts/repo-hooks.py')
        current = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(current)
        root, common, slug = current.context(self.root)
        original_snapshot = current.snapshot
        hook = self.root / '.git-hooks/pre-commit'
        for failure in ('unsafe-mode', 'malformed-json'):
            with self.subTest(failure=failure):
                hook.write_text(hook.read_text() + '\n# new snapshot failure ' + failure + '\n')
                digest, payload = current.bundle(root, slug)
                self.git('config', '--local', '--add', 'repo.trustedGateBundle', digest)
                config = common / 'config'
                before = config.read_bytes()

                def corrupt_publication(parent, selected_digest, selected_payload, selected_slug):
                    version = original_snapshot(parent, selected_digest, selected_payload, selected_slug)
                    metadata = version / 'installation.json'
                    if failure == 'unsafe-mode':
                        metadata.chmod(0o666)
                    else:
                        metadata.write_text('{invalid-json')
                    return version

                with patch.object(current, 'snapshot', side_effect=corrupt_publication):
                    with self.assertRaises(ValueError):
                        current.install(root, common, slug, digest, payload)
                self.assertEqual(config.read_bytes(), before)

    def test_pre_push_forwards_the_remote_and_the_ref_list(self):
        hook = self.root / '.git-hooks/pre-push'
        hook.write_text('#!/usr/bin/env bash\nprintf "push-args=%s\\n" "$*"\ncat\n')
        hook.chmod(0o755)
        digest = self.tool('digest', check=True).stdout.strip()
        self.tool('approve', '--digest', digest, check=True)
        self.tool('install', check=True)
        self.hooks = Path(self.git('config', '--get', 'core.hooksPath').stdout.strip())
        result = subprocess.run(
            [str(self.hooks / 'pre-push'), 'origin', 'https://example.invalid/geo.git'],
            input='refs/heads/topic aaaa refs/heads/topic bbbb\n',
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('push-args=origin https://example.invalid/geo.git', result.stdout)
        self.assertIn('refs/heads/topic aaaa refs/heads/topic bbbb', result.stdout)




class PublicMiseBootstrap(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.root / 'scripts').mkdir()
        shutil.copy2(SOURCE / 'scripts/repo-python.sh', self.root / 'scripts/repo-python.sh')
        for name in ('bash', 'chmod', 'cp', 'dirname', 'install', 'mktemp', 'rm'):
            (self.bin / name).symlink_to(shutil.which(name))
        (self.bin / 'python3').symlink_to(sys.executable)
        self.executions = self.root / 'executed'
        self.downloads = self.root / 'downloads'
        self.payload = self.root / 'downloaded-payload'
        self.payload.write_text('#!/usr/bin/env bash\nprintf "verified-run\\n" >> "$BOOTSTRAP_EXECUTIONS"\nprintf "mise fixture\\n"\n')
        self.script(self.bin / 'uname', '#!/usr/bin/env bash\nif [[ "$1" == -s ]]; then echo "${FIXTURE_SYSTEM:-Linux}"; else echo "${FIXTURE_ARCH:-x86_64}"; fi\n')
        self.script(self.bin / 'curl', '''#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$BOOTSTRAP_DOWNLOADS"
[[ "${FIXTURE_DOWNLOAD_FAIL:-0}" != 1 ]] || exit 7
while [[ "$1" != -o ]]; do shift; done
cp "$BOOTSTRAP_PAYLOAD" "$2"
''')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_', 'PYTHON'))}
        self.env.update(HOME=str(self.root), PATH=str(self.bin),
                        BOOTSTRAP_EXECUTIONS=str(self.executions), BOOTSTRAP_DOWNLOADS=str(self.downloads),
                        BOOTSTRAP_PAYLOAD=str(self.payload))

    @staticmethod
    def script(path, text):
        path.write_text(text)
        path.chmod(0o755)

    def provision(self, *, checksum=None, extra=None):
        import hashlib
        text = (SOURCE / 'scripts/setup-agent-environment.sh').read_text()
        start = text.index('install_public_mise() (')
        body = text[start:text.index('\n)\n', start) + 3]
        self.assertEqual(body.count("destination='/usr/local/bin/mise'"), 1)
        body = body.replace("destination='/usr/local/bin/mise'", "destination='" + str(self.bin / 'mise') + "'")
        digest = checksum or hashlib.sha256(self.payload.read_bytes()).hexdigest()
        for pinned in ('e79ae57945034903aee8aa2ea66b4c7ca9cd4f4edd5a8a78a589cbae6d0f428a',
                       'f344c6961190ed2f68e595ed7cb4f03c36c17812bd608886bec799a3082180ff'):
            self.assertEqual(body.count(pinned), 1)
            body = body.replace(pinned, digest)
        command = 'set -euo pipefail\nroot="$1"\n' + body + '\ninstall_public_mise\n'
        return subprocess.run([str(self.bin / 'bash'), '-c', command, 'fixture', str(self.root)],
                              cwd=self.root, env={**self.env, **(extra or {})},
                              text=True, capture_output=True)

    def test_verified_download_installs_once_without_global_config(self):
        result = self.provision()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.bin / 'mise').read_bytes(), self.payload.read_bytes())
        self.assertEqual(stat.S_IMODE((self.bin / 'mise').stat().st_mode), 0o755)
        self.assertTrue(self.executions.exists())
        result = self.provision()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.downloads.read_text().splitlines()), 1)
        self.assertFalse((self.root / '.config/mise/config.toml').exists())

    def test_bad_checksum_never_executes_or_installs_download(self):
        result = self.provision(checksum='0' * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum', result.stderr)
        self.assertFalse(self.executions.exists())
        self.assertFalse((self.bin / 'mise').exists())

    def test_failed_download_does_not_install(self):
        result = self.provision(extra={'FIXTURE_DOWNLOAD_FAIL': '1'})
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.executions.exists())
        self.assertFalse((self.bin / 'mise').exists())

    def test_unrunnable_verified_binary_is_not_installed(self):
        self.payload.write_text('#!/usr/bin/env bash\nexit 19\n')
        result = self.provision()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.bin / 'mise').exists())

    def test_arm64_uses_its_pinned_release_asset(self):
        result = self.provision(extra={'FIXTURE_ARCH': 'aarch64'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('mise-v2026.9.12-linux-arm64', self.downloads.read_text())

    def test_unsupported_host_refuses_without_downloading(self):
        result = self.provision(extra={'FIXTURE_SYSTEM': 'Darwin'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Install mise', result.stderr)
        self.assertFalse(self.downloads.exists())
        self.assertFalse((self.bin / 'mise').exists())

    def test_existing_nonexecutable_destination_is_preserved(self):
        destination = self.bin / 'mise'
        destination.write_text('existing useful content\n')
        destination.chmod(0o600)
        result = self.provision()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(destination.read_text(), 'existing useful content\n')
        self.assertFalse(self.downloads.exists())


class SessionBootstrap(unittest.TestCase):
    """Run the complete setup script with isolated install/provisioning boundaries."""
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        scripts = self.root / 'scripts'
        scripts.mkdir()
        for name in ('setup-agent-environment.sh', 'repo-python.sh'):
            shutil.copy2(SOURCE / 'scripts' / name, scripts / name)
        (self.root / 'gate').mkdir()
        shutil.copy2(SOURCE / 'gate/gate-lib.sh', self.root / 'gate/gate-lib.sh')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ('bash', 'dirname', 'touch', 'rm', 'mkdir', 'mktemp', 'mv', 'cat', 'env'):
            (self.bin / name).symlink_to(shutil.which(name))
        (self.bin / 'python3').symlink_to(sys.executable)
        self.log = self.root / 'commands.jsonl'
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('GIT_', 'PYTHON', 'MISE_', 'npm_', 'NPM_', 'CLAUDE_'))}
        self.env.update(HOME=str(self.root), PATH=str(self.bin), SETUP_LOG=str(self.log))
        for name, value in {'.mise.toml': '[tools]\nnode = "24"\n', '.nvmrc': '24\n',
                            '.npmrc': 'yes=false\n', 'package.json': '{"name":"fixture","version":"1.0.0"}\n',
                            'package-lock.json': '{"lockfileVersion":3}\n'}.items():
            (self.root / name).write_text(value)
        self.write_script(scripts / 'repo-hooks.py', '''import os, sys
with open(os.environ['SETUP_LOG'], 'a') as log:
    log.write(__import__('json').dumps(['hooks', *sys.argv[1:]]) + '\\n')
if sys.argv[1] == 'verify' and os.environ.get('HOOK_VERIFY_ERROR'):
    sys.exit('repo-hooks: ' + os.environ['HOOK_VERIFY_ERROR'])
sys.exit(int(os.environ.get('HOOK_FAILURE', '0')))
''')
        self.write_script(self.bin / 'uname', '#!/usr/bin/env bash\nif [[ "$1" == -m ]]; then echo x86_64; else echo Linux; fi\n')
        self.write_script(self.bin / 'pkg-config', '#!/usr/bin/env bash\nexit 0\n')
        self.write_script(self.bin / 'mise', '''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['SETUP_LOG'], 'a') as log:
    log.write(json.dumps(['mise', *sys.argv[1:]]) + '\\n')
marker = os.path.join(os.path.dirname(os.environ['SETUP_LOG']), 'mise-has-uv')
if sys.argv[1] == 'exec':
    assert os.environ.get('MISE_EXEC_AUTO_INSTALL') == 'false', 'mise exec would auto-install tools'
    os.execvp(sys.argv[3], sys.argv[3:])
if sys.argv[1:3] == ['install', 'uv']:
    open(marker, 'w').close()
if sys.argv[1:3] == ['which', 'uv']:
    if not os.path.exists(marker):
        sys.exit('uv is not installed')
    print(os.environ['FIXTURE_UV_PATH'])
elif sys.argv[1] == 'which':
    print(os.environ.get(f'FIXTURE_{sys.argv[2].upper()}_PATH',
                         os.path.join(os.environ['FIXTURE_NODE'], 'bin', sys.argv[2])))
sys.exit(0)
''')
        self.write_script(self.bin / 'git', '''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['SETUP_LOG'], 'a') as log:
    log.write(json.dumps(['git', *sys.argv[1:]]) + '\\n')
    if sys.argv[1:3] != ['config', '--get']:
        log.write(json.dumps(['git-env', os.environ.get('GIT_TERMINAL_PROMPT'), os.environ.get('GIT_SSH_COMMAND')]) + '\\n')
if sys.argv[1:3] == ['config', '--get']:
    configured = os.environ.get('FIXTURE_SSH_CONFIG')
    print(configured or '', end='')
    sys.exit(0 if configured else 1)
sys.exit(int(os.environ.get('GIT_FAILURE', '0')))
''')
        self.write_script(self.bin / 'node', '#!/usr/bin/env bash\nexit 0\n')
        # The host already has the gate's pinned scanners and uv, so setup installs none of them.
        for name, answer in pinned_versions().items():
            self.write_script(self.bin / name, '#!/usr/bin/env bash\necho "' + answer + '"\n')
        for name in ('uv', 'uvx'):
            self.write_script(self.bin / name, '#!/usr/bin/env bash\nexit 0\n')
        # mise resolves node and its npm wrapper inside one installation prefix.
        self.node = self.root / 'node-install'
        (self.node / 'include/node').mkdir(parents=True)
        (self.node / 'lib/node_modules/npm').mkdir(parents=True)
        (self.node / 'bin').mkdir()
        self.write_script(self.node / 'bin/node', '#!/usr/bin/env bash\nexit 0\n')
        self.write_node_version(24, 16, 0)
        (self.node / 'lib/node_modules/npm/package.json').write_text('{"version":"11.12.0"}\n')
        self.env['FIXTURE_NODE'] = str(self.node)
        self.write_script(self.bin / 'npm', '''#!/usr/bin/env python3
import json, os, pathlib, sys
with open(os.environ['SETUP_LOG'], 'a') as log:
    log.write(json.dumps(['npm', *sys.argv[1:]]) + '\\n')
if sys.argv[1] == '--version':
    print('11.12.0')
elif sys.argv[1] == 'ci':
    if os.environ.get('INSTALL_FAILURE'):
        sys.exit(23)
    packages = {}
    for name in ('node_modules/fixture', 'node_modules/fixture/node_modules/transitive'):
        path = pathlib.Path(name)
        path.mkdir(parents=True, exist_ok=True)
        (path / 'package.json').write_text('{"version":"1.0.0"}\\n')
        packages[name] = {'version': '1.0.0'}
    pathlib.Path('node_modules/.package-lock.json').write_text(json.dumps({'packages': packages}))
elif sys.argv[1] == 'ls':
    sys.exit(int(os.environ.get('TREE_FAILURE', '0')))
else:
    sys.exit('Unexpected npm operation')
''')
        # Setup puts the resolved Node's bin first on PATH, so its npm is the one npm ci runs.
        shutil.copy2(self.bin / 'npm', self.node / 'bin/npm')

    @staticmethod
    def write_script(path, text):
        path.write_text(text)
        path.chmod(0o755)

    def write_node_version(self, major, minor, patch):
        (self.node / 'include/node/node_version.h').write_text(
            f'#define NODE_MAJOR_VERSION {major}\n#define NODE_MINOR_VERSION {minor}\n'
            f'#define NODE_PATCH_VERSION {patch}\n#define NODE_MODULE_VERSION NODE_EMBEDDER_MODULE_VERSION\n'
            '#define NODE_MODULE_VERSION 137\n')

    def setup(self, *args, extra=None):
        return subprocess.run([str(self.bin / 'bash'), 'scripts/setup-agent-environment.sh', *args],
                              cwd=self.root, env={**self.env, **(extra or {})}, text=True, capture_output=True)

    def assert_ready(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def commands(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def tree(self):
        return {str(p.relative_to(self.root)): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in (self.root / 'node_modules').rglob('*') if p.is_file()}

    def test_fresh_hook_installs_and_unchanged_resume_preserves_dependencies(self):
        (self.root / '.env').write_text('fixture setting\n')
        self.assert_ready(self.setup('--session-hook'))
        receipt = self.root / 'node_modules/.georoids-setup.json'
        self.assertTrue(receipt.is_file())
        tree_check = ['npm', 'ls', '--all', '--include=dev', '--include=optional', '--include=peer']
        self.assertIn(tree_check, self.commands())
        self.assertEqual(json.loads(receipt.read_text())['runtime'], json.dumps(
            ['v24.16.0', '137', platform.system().lower(),
             {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}[platform.machine()]], separators=(',', ':')))
        self.assertEqual(json.loads(receipt.read_text())['npm'], '11.12.0')
        before = self.tree()
        self.log.write_text('')
        self.assert_ready(self.setup('--session-hook'))
        self.assertEqual(self.tree(), before)
        self.assertEqual((self.root / '.env').read_text(), 'fixture setting\n')
        # A warm resume compares the receipt without starting Node, npm or the tree check.
        self.assertEqual([c for c in self.commands() if c[0] == 'npm' or c[1] == 'exec'], [])
        # A current installed bundle never touches the network.
        self.assertNotIn('git', [c[0] for c in self.commands()])
        self.assertNotIn(tree_check, self.commands())
        self.assertNotIn(['npm', 'ci'], self.commands())
        self.assertNotIn(['mise', 'install'], self.commands())
        self.assertNotIn(['mise', 'trust', str(self.root / '.mise.toml')], self.commands())
        self.assertEqual(self.commands()[0][0:2], ['hooks', 'verify'])

    def test_fresh_setup_asks_mise_only_for_node_and_writes_the_env_file(self):
        self.assert_ready(self.setup())
        self.assertEqual([c for c in self.commands() if c[:2] == ['mise', 'install']], [['mise', 'install', 'node']])
        self.assertIn(['mise', 'exec', '--', 'npm', 'ci'], self.commands())
        env_file = self.root / '.local/share/georoids-toolchain/env.sh'
        self.assertIn('export PATH="' + str(self.node / 'bin') + ':$PATH"', env_file.read_text())

    def env_file(self):
        return self.root / '.local/share/georoids-toolchain/env.sh'

    def env_path(self):
        """PATH as a shell that sourced env.sh would see it."""
        line = self.env_file().read_text().strip()
        self.assertTrue(line.startswith('export PATH="') and line.endswith(':$PATH"'), line)
        return line[len('export PATH="'):-len(':$PATH"')] + ':' + self.env['PATH']

    def test_missing_uv_comes_from_mise_and_a_rerun_keeps_it(self):
        for name in ('uv', 'uvx'):
            (self.bin / name).unlink()
        uv = self.root / 'uv-install'
        uv.mkdir()
        for name in ('uv', 'uvx'):
            self.write_script(uv / name, '#!/usr/bin/env bash\nexit 0\n')
        extra = {'FIXTURE_UV_PATH': str(uv / 'uv')}
        self.assert_ready(self.setup(extra=extra))
        self.assertIn(['mise', 'install', 'uv'], self.commands())
        written = self.env_file().read_text()
        self.assertIn(str(uv), written)
        # Rerun from a shell that sourced env.sh: uv is now on PATH, and env.sh still names it.
        self.log.write_text('')
        self.assert_ready(self.setup(extra={**extra, 'PATH': self.env_path()}))
        self.assertNotIn(['mise', 'install', 'uv'], self.commands())
        self.assertEqual(self.env_file().read_text(), written)

    def serve_releases(self):
        """Serve stand-in gitleaks, zizmor and osv-scanner releases that the fixture gate pins."""
        served = self.root / 'served'
        staging = self.root / 'staging'
        for name in ('tar', 'gzip', 'install', 'sha256sum', 'cp', 'grep', 'chmod'):
            if not (self.bin / name).exists():
                (self.bin / name).symlink_to(shutil.which(name))
        answers = pinned_versions()
        digests = {}
        for tool in ('gitleaks', 'zizmor', 'osv-scanner'):
            text = '#!/usr/bin/env bash\necho "' + answers[tool] + '"\n'
            digests[tool] = hashlib.sha256(text.encode()).hexdigest()
            write_executable(staging / tool, text)
        served.mkdir()
        gitleaks = gate_pin('GATE_GITLEAKS_VERSION')
        subprocess.run(['tar', '-czf', str(served / f'gitleaks_{gitleaks}_linux_x64.tar.gz'), '-C', str(staging), 'gitleaks'], check=True)
        subprocess.run(['tar', '-czf', str(served / 'zizmor-x86_64-unknown-linux-gnu.tar.gz'), '-C', str(staging), 'zizmor'], check=True)
        shutil.copy2(staging / 'osv-scanner', served / 'osv-scanner_linux_amd64')
        lib = self.root / 'gate/gate-lib.sh'
        text = lib.read_text()
        for tool, variable in (('gitleaks', 'GATE_GITLEAKS_BIN_SHA256'), ('zizmor', 'GATE_ZIZMOR_BIN_SHA256'),
                               ('osv-scanner', 'GATE_OSV_BIN_SHA256')):
            for suffix in ('DARWIN_ARM64', 'LINUX_X64', 'LINUX_ARM64'):
                key = f'{variable}_{suffix}='
                start = text.index(key)
                text = text[:start + len(key)] + digests[tool] + text[text.index('\n', start):]
        lib.write_text(text)
        # Fake curl logs each URL and copies the served file with its basename to -o.
        self.write_script(self.bin / 'curl', '''#!/usr/bin/env python3
import json, os, shutil, sys
url = next(a for a in sys.argv[1:] if a.startswith('https://'))
with open(os.environ['SETUP_LOG'], 'a') as log:
    log.write(json.dumps(['curl', url]) + '\\n')
source = os.path.join(os.environ['FIXTURE_SERVED'], url.rsplit('/', 1)[1])
if not os.path.exists(source):
    sys.exit(22)
shutil.copy(source, sys.argv[sys.argv.index('-o') + 1])
''')
        self.env['FIXTURE_SERVED'] = str(served)
        for tool in ('gitleaks', 'zizmor', 'osv-scanner'):
            (self.bin / tool).unlink()

    def test_missing_scanners_come_from_releases_and_hooks_find_them_without_env_file(self):
        self.serve_releases()
        self.assert_ready(self.setup())
        downloads = [c[1] for c in self.commands() if c[0] == 'curl']
        self.assertEqual(len(downloads), 3, downloads)
        self.assertTrue(all(url.startswith('https://github.com/') and '/releases/download/v' in url for url in downloads))
        toolchain = self.root / '.local/share/georoids-toolchain/bin'
        self.assertEqual(sorted(p.name for p in toolchain.iterdir()), ['gitleaks', 'osv-scanner', 'zizmor'])
        # env.sh is only for Node: a plain shell's gate lookups find the verified release copies.
        self.assertNotIn(str(toolchain), self.env_file().read_text())
        lookup = subprocess.run(
            [str(self.bin / 'bash'), '-c', 'source gate/gate-lib.sh && gate_gitleaks_bin && echo && gate_zizmor_bin && echo && gate_osv_scanner_bin'],
            cwd=self.root, env=self.env, text=True, capture_output=True)
        self.assertEqual(lookup.returncode, 0, lookup.stderr)
        self.assertEqual(lookup.stdout.split(), [str(toolchain / t) for t in ('gitleaks', 'zizmor', 'osv-scanner')])
        # A rerun, from env.sh's PATH too, downloads nothing and writes the same env.sh.
        written = self.env_file().read_text()
        for path in (self.env['PATH'], self.env_path()):
            with self.subTest(path=path):
                self.log.write_text('')
                self.assert_ready(self.setup(extra={'PATH': path}))
                self.assertEqual([c for c in self.commands() if c[0] == 'curl'], [])
                self.assertEqual(self.env_file().read_text(), written)
        # Other bytes at a release copy's path are refused, and the next setup replaces them.
        (toolchain / 'zizmor').write_text('#!/usr/bin/env bash\necho "' + pinned_versions()['zizmor'] + ' other"\n')
        refused = subprocess.run([str(self.bin / 'bash'), '-c', 'source gate/gate-lib.sh && gate_zizmor_bin'],
                                 cwd=self.root, env=self.env, text=True, capture_output=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('is not the pinned release', refused.stderr)
        self.log.write_text('')
        self.assert_ready(self.setup())
        self.assertEqual(len([c for c in self.commands() if c[0] == 'curl']), 1)

    def test_session_hook_adds_env_file_to_the_claude_session_once(self):
        (self.bin / 'grep').symlink_to(shutil.which('grep'))
        session_env = self.root / 'claude-session-env'
        session_env.write_text('export EXISTING=1\n')
        extra = {'CLAUDE_ENV_FILE': str(session_env)}
        self.assert_ready(self.setup('--session-hook', extra=extra))
        self.assert_ready(self.setup('--session-hook', extra=extra))
        self.assertEqual(session_env.read_text(), f'export EXISTING=1\n. "{self.env_file()}"\n')
        # A later session resumes warm with its own empty env file, which gets the line once too.
        warm_env = self.root / 'claude-warm-session-env'
        warm_env.write_text('')
        result = self.setup('--session-hook', extra={'CLAUDE_ENV_FILE': str(warm_env)})
        self.assert_ready(result)
        self.assertIn('verified without reinstalling', result.stdout)
        self.assertEqual(warm_env.read_text(), f'. "{self.env_file()}"\n')

    def test_changed_inputs_refuse_then_explicit_setup_repairs(self):
        self.assert_ready(self.setup('--session-hook'))
        for name in ('package-lock.json', 'package.json', '.mise.toml', '.npmrc', '.nvmrc'):
            with self.subTest(name=name):
                path = self.root / name
                path.write_text(path.read_text() + '\n')
                before = self.tree()
                self.log.write_text('')
                result = self.setup('--session-hook')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('npm run dev:kill', result.stderr)
                self.assertEqual(self.tree(), before)
                self.assertNotIn(['npm', 'ci'], self.commands())
                self.assert_ready(self.setup())
                self.assertIn(['npm', 'ci'], self.commands())
                self.assert_ready(self.setup('--session-hook'))

    def test_incomplete_or_changed_installed_tree_refuses_without_reinstall(self):
        self.assert_ready(self.setup())
        changes = [
            ('node_modules/.georoids-setup.json', None),
            ('node_modules/.georoids-setup.json', '{'),
            ('node_modules/.package-lock.json', None),
            ('node_modules/fixture/node_modules/transitive/package.json', None),
            ('node_modules/fixture/node_modules/transitive/package.json', '{"version":"1.0.1"}'),
        ]
        for name, replacement in changes:
            with self.subTest(name=name, replacement=replacement):
                path = self.root / name
                if replacement is None:
                    path.unlink()
                else:
                    path.write_text(replacement)
                before = self.tree()
                self.log.write_text('')
                result = self.setup('--session-hook')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.tree(), before)
                self.assertNotIn(['npm', 'ci'], self.commands())
                self.assert_ready(self.setup())

    def test_changed_runtime_or_foreign_npm_refuses_warm_resume(self):
        self.assert_ready(self.setup())
        before = self.tree()
        npm_manifest = self.node / 'lib/node_modules/npm/package.json'
        changes = {
            'node version': lambda: self.write_node_version(24, 17, 0),
            'npm version': lambda: npm_manifest.write_text('{"version":"11.13.0"}\n'),
            'missing runtime header': lambda: (self.node / 'include/node/node_version.h').unlink(),
        }
        for name, change in changes.items():
            with self.subTest(change=name):
                change()
                self.log.write_text('')
                result = self.setup('--session-hook')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('npm run dev:kill', result.stderr)
                self.assertEqual(self.tree(), before)
                self.assertNotIn(['npm', 'ci'], self.commands())
                self.write_node_version(24, 16, 0)
                npm_manifest.write_text('{"version":"11.12.0"}\n')
                self.assert_ready(self.setup('--session-hook'))
        foreign = self.root / 'other-npm/bin/npm'
        foreign.parent.mkdir(parents=True)
        self.write_script(foreign, '#!/usr/bin/env bash\nexit 0\n')
        result = self.setup('--session-hook', extra={'FIXTURE_NPM_PATH': str(foreign)})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('npm does not belong to the resolved Node installation', result.stderr)
        self.assertEqual(self.tree(), before)
        for unexpected in ('', 'relative/bin/node', str(self.node / 'node'), str(self.node / 'bin/nodejs')):
            with self.subTest(node_path=unexpected):
                result = self.setup('--session-hook', extra={'FIXTURE_NODE_PATH': unexpected})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('mise resolved node to an unexpected path', result.stderr)
                self.assertEqual(self.tree(), before)

    def test_failed_explicit_repair_invalidates_receipt_and_failure_propagates(self):
        self.assert_ready(self.setup())
        result = self.setup(extra={'INSTALL_FAILURE': '1'})
        self.assertEqual(result.returncode, 23)
        self.assertFalse((self.root / 'node_modules/.georoids-setup.json').exists())
        self.log.write_text('')
        self.assertNotEqual(self.setup('--session-hook').returncode, 0)
        self.assertNotIn(['npm', 'ci'], self.commands())
        self.assert_ready(self.setup())
        self.assert_ready(self.setup('--session-hook'))

    def test_failed_fresh_install_or_postinstall_validation_never_gets_receipt(self):
        for extra in ({'INSTALL_FAILURE': '1'}, {'TREE_FAILURE': '1'}):
            with self.subTest(extra=extra):
                result = self.setup('--session-hook', extra=extra)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / 'node_modules/.georoids-setup.json').exists())

    def test_invalid_arguments_fail_before_hooks_or_provisioning(self):
        for args in (('--unknown',), ('--session-hook', '--session-hook'), ('--session-hook=1',)):
            with self.subTest(args=args):
                result = self.setup(*args)
                self.assertEqual(result.returncode, 2)
                self.assertIn('Usage:', result.stderr)
                self.assertFalse(self.log.exists())
                self.assertFalse((self.root / 'node_modules').exists())

    def test_missing_lockfile_or_shared_dependency_tree_fails_before_provisioning(self):
        lock = self.root / 'package-lock.json'
        lock.unlink()
        self.assertNotEqual(self.setup('--session-hook').returncode, 0)
        self.assertFalse(self.log.exists())
        lock.write_text('{"lockfileVersion":3}\n')
        shared = self.root / 'shared-dependencies'
        shared.mkdir()
        sentinel = shared / '.georoids-setup.json'
        sentinel.write_text('another checkout receipt\n')
        (self.root / 'node_modules').symlink_to(shared)
        for args in ((), ('--session-hook',)):
            self.assertNotEqual(self.setup(*args).returncode, 0)
            self.assertFalse(self.log.exists())
            self.assertEqual(sentinel.read_text(), 'another checkout receipt\n')

    def test_untrusted_hook_bundle_fails_before_provisioning(self):
        result = self.setup('--session-hook', extra={'HOOK_FAILURE': '17'})
        self.assertEqual(result.returncode, 17)
        self.assertEqual(len(self.commands()), 1)
        self.assertFalse((self.root / 'node_modules').exists())

    def test_warm_resume_reinstalls_only_a_stale_trusted_bundle(self):
        self.assert_ready(self.setup())
        before = self.tree()
        message = 'Installed bundle is stale; run reviewed repository setup'
        # Setup matches this exact verify message; rewording it must update both.
        self.assertIn(f"raise ValueError('{message}')", (SOURCE / 'scripts/repo-hooks.py').read_text())
        stale = {'HOOK_VERIFY_ERROR': message}
        self.log.write_text('')
        self.assert_ready(self.setup('--session-hook', extra=stale))
        # The trust anchor is refreshed from origin before the trust-gated install.
        refresh = ['git', '-c', 'credential.interactive=false', '-c', 'http.lowSpeedLimit=1000',
                   '-c', 'http.lowSpeedTime=20', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head',
                   '--no-auto-maintenance', 'origin', '+refs/heads/main:refs/remotes/origin/main']
        batch_ssh = 'ssh -o BatchMode=yes -o ConnectTimeout=20'

        def sequence():
            return [c if c[0] in ('git', 'git-env') else c[:2] for c in self.commands()
                    if c[0] in ('hooks', 'git', 'git-env') and c[1:3] != ['config', '--get']]

        self.assertEqual(sequence(), [['hooks', 'verify'], refresh, ['git-env', '0', batch_ssh], ['hooks', 'install']])
        self.assertNotIn(['npm', 'ci'], self.commands())
        self.assertEqual(self.tree(), before)
        # A user's own SSH command still wins over the non-interactive default.
        for extra, expected in (({'FIXTURE_SSH_CONFIG': 'ssh -i key'}, 'ssh -i key'),
                                ({'GIT_SSH_COMMAND': 'ssh -F cfg'}, 'ssh -F cfg')):
            with self.subTest(ssh=expected):
                self.log.write_text('')
                self.assert_ready(self.setup('--session-hook', extra={**stale, **extra}))
                self.assertIn(['git-env', '0', expected], self.commands())
        # An unreachable origin still reaches install, which compares against the local copy.
        self.log.write_text('')
        result = self.setup('--session-hook', extra={**stale, 'GIT_FAILURE': '128'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Could not refresh origin/main', result.stderr)
        self.assertEqual(sequence(), [['hooks', 'verify'], refresh, ['git-env', '0', batch_ssh], ['hooks', 'install']])
        # Install still enforces trust: an untrusted current bundle fails the hook.
        result = self.setup('--session-hook', extra={**stale, 'HOOK_FAILURE': '17'})
        self.assertEqual(result.returncode, 17)
        self.assertEqual(self.tree(), before)
        # Any other verify failure, including a path that merely contains the
        # stale phrase, keeps failing without an install attempt.
        for error in ('Current source bundle is not trusted',
                      "[Errno 2] No such file or directory: '/x/versions/Installed bundle is stale/installation.json'"):
            with self.subTest(error=error):
                self.log.write_text('')
                result = self.setup('--session-hook', extra={'HOOK_VERIFY_ERROR': error})
                self.assertEqual(result.returncode, 1)
                self.assertIn(error, result.stderr)
                self.assertNotIn('install', [c[1] for c in self.commands() if c[0] == 'hooks'])
                self.assertNotIn('git', [c[0] for c in self.commands()])
                self.assertEqual(self.tree(), before)


class SemgrepLookup(unittest.TestCase):
    """Semgrep comes from PATH at the pin, else from the install mise names when asked from /."""

    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.scratch = Path(scratch.name).resolve()
        self.bin = self.scratch / 'bin'
        self.checkout = self.scratch / 'checkout'
        self.checkout.mkdir()
        lib = (SOURCE / 'gate/gate-lib.sh').read_text()
        self.version = next(line.split('=', 1)[1] for line in lib.splitlines()
                            if line.startswith('GATE_SEMGREP_VERSION='))
        self.calls = self.scratch / 'mise-calls'
        # The library needs coreutils, so the stand-ins go first on a plain system PATH.
        self.system_path = '/usr/bin:/bin'
        if shutil.which('semgrep', path=self.system_path):
            self.skipTest('a Semgrep on ' + self.system_path + ' would answer before the stand-ins')
        self.environment = {'PATH': str(self.bin) + ':' + self.system_path,
                            'HOME': str(self.scratch / 'home')}

    def executable(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/sh\n' + body + '\n')
        path.chmod(0o755)

    def install(self, name, version=None):
        directory = self.scratch / name
        self.executable(directory / 'bin/semgrep',
                        'echo ran-' + name + ' "$@" >>"' + str(self.scratch / 'semgrep-runs') + '"\n'
                        'echo ' + (version or self.version))
        return directory

    def mise(self, installs):
        """A stand-in mise that names one install per working directory, for the pinned tool only."""
        cases = ''.join('  "' + str(origin) + '") echo "' + str(directory) + '"; exit 0 ;;\n'
                        for origin, directory in installs.items())
        self.executable(self.bin / 'mise',
                        'echo "$(pwd -P) $*" >>"' + str(self.calls) + '"\n'
                        '[ "$*" = "where semgrep@' + self.version + '" ] || exit 1\n'
                        'case "$(pwd -P)" in\n' + cases + 'esac\nexit 1')

    def lookup(self, cwd=None):
        return subprocess.run(
            [shutil.which('bash'), '-c',
             'source "$1"; set -euo pipefail; gate_semgrep_bin', '_',
             str(SOURCE / 'gate/gate-lib.sh')],
            cwd=cwd or self.scratch, env=self.environment,
            text=True, capture_output=True, check=False)

    def assertFound(self, result, directory):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, str(directory / 'bin/semgrep'))

    def asked_from(self):
        return {line.split(' ', 1)[0] for line in self.calls.read_text().splitlines()}

    def test_install_mise_names_from_the_filesystem_root_is_found(self):
        from_root = self.install('from-root')
        self.mise({'/': from_root})
        self.assertFound(self.lookup(), from_root)

    def test_mise_is_asked_only_from_the_filesystem_root_whatever_the_working_directory(self):
        # The checkout's mise config would name another install; the lookup must not see it.
        decoy = self.install('from-checkout')
        from_root = self.install('from-root')
        self.mise({'/': from_root, self.checkout: decoy})
        self.assertFound(self.lookup(cwd=self.checkout), from_root)
        self.mise({self.checkout: decoy})
        result = self.lookup(cwd=self.checkout)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('mise names no install', result.stderr)
        self.assertEqual(self.asked_from(), {'/'})

    def test_install_at_another_version_is_refused(self):
        self.mise({'/': self.install('from-root', '0.0.1')})
        result = self.lookup()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('mise names no install', result.stderr)

    def test_semgrep_on_path_at_the_pin_is_used_without_asking_mise(self):
        self.mise({'/': self.install('from-root')})
        self.executable(self.bin / 'semgrep', 'echo ' + self.version)
        result = self.lookup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, str(self.bin / 'semgrep'))
        self.assertFalse(self.calls.exists())

    def test_semgrep_on_path_at_another_version_falls_through_to_mise(self):
        from_root = self.install('from-root')
        self.mise({'/': from_root})
        self.executable(self.bin / 'semgrep', 'echo 0.0.1')
        self.assertFound(self.lookup(), from_root)
        self.mise({})
        result = self.lookup()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('semgrep on PATH is not ' + self.version, result.stderr)

    def test_security_scan_runs_the_install_mise_names_from_the_filesystem_root(self):
        for relative in ('gate/gate-lib.sh', 'scripts/security-scan.sh'):
            target = self.checkout / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SOURCE / relative, target)
        environment = {**self.environment,
                       'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
                       'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                       'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}

        def git(*arguments):
            return subprocess.run(['git', *arguments], cwd=self.checkout, env=environment,
                                  text=True, capture_output=True, check=True).stdout.strip()
        git('init', '-q')
        git('add', '.')
        git('commit', '-qm', 'fixture')
        environment['SECURITY_BASE_SHA'] = git('rev-parse', 'HEAD')
        self.mise({'/': self.install('from-root'), self.checkout: self.install('from-checkout')})
        result = subprocess.run([shutil.which('bash'), 'scripts/security-scan.sh', 'semgrep'],
                                cwd=self.checkout, env=environment, text=True, capture_output=True,
                                check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        runs = (self.scratch / 'semgrep-runs').read_text().splitlines()
        scan = [line for line in runs if line.startswith('ran-from-root scan ')]
        self.assertEqual(len(scan), 1, result.stdout + result.stderr)
        self.assertIn('--baseline-commit ' + environment['SECURITY_BASE_SHA'], scan[0])
        self.assertEqual([line for line in runs if line.startswith('ran-from-checkout ')], [])
        self.assertEqual(self.asked_from(), {'/'})


class PinnedReleaseInstall(unittest.TestCase):
    """Setup installs gitleaks, zizmor and osv-scanner from release URLs, hash-checked by the gate."""

    PINNED = '#!/bin/sh\necho the release\n'

    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        self.bin = self.root / 'bin'
        self.downloads = self.root / 'downloads'
        self.served = self.root / 'served'
        self.served.mkdir()
        self.home = self.root / 'home'
        self.toolchain = self.home / '.local/share/georoids-toolchain/bin'
        write_executable(self.bin / 'uname', '#!/usr/bin/env bash\n'
                         'if [[ "$1" == -s ]]; then echo "${FIXTURE_SYSTEM:-Linux}"; else echo "${FIXTURE_ARCH:-x86_64}"; fi\n')
        # Fake curl logs each request, then copies $SERVE to -o, or fails like curl --fail when unset.
        write_executable(self.bin / 'curl', '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$DOWNLOADS"\n'
                         '[[ -n "${SERVE:-}" ]] || exit 22\nwhile [[ "$1" != -o ]]; do shift; done\ncp "$SERVE" "$2"\n')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_', 'PYTHON', 'MISE_'))}
        self.env.update(HOME=str(self.home), PATH=str(self.bin) + ':/usr/bin:/bin', DOWNLOADS=str(self.downloads))

    def release(self, name, member, text):
        """A served release: a .tar.gz holding <member>, or the bare binary when member is None."""
        staging = self.root / ('staging-' + name)
        write_executable(staging / (member or 'bare'), text)
        if member is None:
            return staging / 'bare'
        archive = self.served / name
        subprocess.run(['tar', '-czf', str(archive), '-C', str(staging), member], check=True)
        return archive

    def install(self, tool, serve=None, extra=None):
        text = (SOURCE / 'scripts/setup-agent-environment.sh').read_text()
        start = text.index('install_pinned_release() (')
        body = text[start:text.index('\n)\n', start) + 3]
        variable = {'gitleaks': 'GATE_GITLEAKS_BIN_SHA256', 'zizmor': 'GATE_ZIZMOR_BIN_SHA256',
                    'osv-scanner': 'GATE_OSV_BIN_SHA256'}[tool]
        digest = hashlib.sha256(self.PINNED.encode()).hexdigest()
        # The fixture pins the stand-in release's hash on every platform.
        command = ('set -euo pipefail\nsource "$1"\n'
                   + ''.join(f'{variable}_{suffix}={digest}\n' for suffix in ('DARWIN_ARM64', 'LINUX_X64', 'LINUX_ARM64'))
                   + body + '\ninstall_pinned_release "$2"\n')
        environment = {**self.env, **(extra or {})}
        if serve is not None:
            environment['SERVE'] = str(serve)
        return subprocess.run([shutil.which('bash'), '-c', command, 'fixture', str(SOURCE / 'gate/gate-lib.sh'), tool],
                              cwd=SOURCE, env=environment, text=True, capture_output=True)

    def test_verified_archive_installs_from_the_release_url_without_the_api(self):
        result = self.install('gitleaks', serve=self.release('gitleaks.tar.gz', 'gitleaks', self.PINNED))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.toolchain / 'gitleaks').read_text(), self.PINNED)
        requested = self.downloads.read_text()
        version = gate_pin('GATE_GITLEAKS_VERSION')
        self.assertIn(f'https://github.com/gitleaks/gitleaks/releases/download/v{version}/gitleaks_{version}_linux_x64.tar.gz', requested)
        self.assertNotIn('api.github.com', requested)
        # The gate's lookup finds the verified copy from a shell that never changed PATH.
        lookup = subprocess.run([shutil.which('bash'), '-c', 'source "$1" && GATE_GITLEAKS_BIN_SHA256_LINUX_X64=$2 && '
                                 'GATE_GITLEAKS_BIN_SHA256_LINUX_ARM64=$2 && GATE_GITLEAKS_BIN_SHA256_DARWIN_ARM64=$2 && gate_gitleaks_bin',
                                 'fixture', str(SOURCE / 'gate/gate-lib.sh'), hashlib.sha256(self.PINNED.encode()).hexdigest()],
                                cwd=SOURCE, env=self.env, text=True, capture_output=True)
        self.assertEqual(lookup.returncode, 0, lookup.stderr)
        self.assertEqual(lookup.stdout, str(self.toolchain / 'gitleaks'))

    def test_each_platform_requests_its_own_release_asset(self):
        zizmor = gate_pin('GATE_ZIZMOR_VERSION')
        osv = gate_pin('GATE_OSV_SCANNER_VERSION')
        cases = [('zizmor', 'Linux', 'aarch64', 'zizmor', f'zizmor/releases/download/v{zizmor}/zizmor-aarch64-unknown-linux-gnu.tar.gz'),
                 ('zizmor', 'Darwin', 'arm64', 'zizmor', f'zizmor/releases/download/v{zizmor}/zizmor-aarch64-apple-darwin.tar.gz'),
                 ('osv-scanner', 'Linux', 'x86_64', None, f'osv-scanner/releases/download/v{osv}/osv-scanner_linux_amd64'),
                 ('osv-scanner', 'Darwin', 'arm64', None, f'osv-scanner/releases/download/v{osv}/osv-scanner_darwin_arm64')]
        for tool, system, arch, member, asset in cases:
            with self.subTest(tool=tool, system=system, arch=arch):
                shutil.rmtree(self.home, ignore_errors=True)
                self.downloads.unlink(missing_ok=True)
                served = self.release(f'{tool}-{system}-{arch}', member, self.PINNED)
                result = self.install(tool, serve=served, extra={'FIXTURE_SYSTEM': system, 'FIXTURE_ARCH': arch})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(asset, self.downloads.read_text())
                self.assertEqual((self.toolchain / tool).read_text(), self.PINNED)

    def test_other_bytes_or_an_archive_without_the_binary_install_nothing(self):
        for name, served, message in (
                ('other bytes', self.release('other.tar.gz', 'gitleaks', '#!/bin/sh\necho other\n'), 'checksum mismatch'),
                ('no binary', self.release('empty.tar.gz', 'LICENSE', 'license\n'), 'holds no gitleaks binary')):
            with self.subTest(case=name):
                result = self.install('gitleaks', serve=served)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertIn('Nothing was installed', result.stderr)
                self.assertFalse((self.toolchain / 'gitleaks').exists())

    def test_failed_download_or_unsupported_host_installs_nothing(self):
        result = self.install('zizmor')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.toolchain / 'zizmor').exists())
        self.downloads.unlink()
        result = self.install('zizmor', extra={'FIXTURE_SYSTEM': 'Darwin', 'FIXTURE_ARCH': 'x86_64'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Darwin x86_64', result.stderr)
        self.assertFalse(self.downloads.exists())


class PytestSubtestReporting(unittest.TestCase):
    def test_two_failing_subcases_both_execute_report_and_clean_up(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'pytest.ini').write_text('[pytest]\n')
            fixture = root / 'test_subtest_contract.py'
            fixture.write_text(r'''import unittest
from pathlib import Path

class SubtestFailures(unittest.TestCase):
    def test_both_failures(self):
        events = Path(__file__).with_name('events.txt')
        def record(event):
            with events.open('a') as stream:
                stream.write(event + '\n')
        self.addCleanup(record, 'cleanup')
        for label in ('first', 'second'):
            with self.subTest(label=label):
                record(label)
                self.fail('failure-' + label)
        record('continued')
''')
            environment = {key: value for key, value in os.environ.items()
                           if not key.startswith('PYTEST_')}
            environment['PYTEST_DISABLE_PLUGIN_AUTOLOAD'] = '1'
            result = subprocess.run([
                sys.executable, '-I', '-m', 'pytest', '-q', '--noconftest',
                '-c', str(root / 'pytest.ini'), '--rootdir', str(root), str(fixture),
            ], cwd=root, env=environment, text=True, capture_output=True, check=False)
            output = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1, output)
            self.assertEqual((root / 'events.txt').read_text().splitlines(),
                             ['first', 'second', 'continued', 'cleanup'])
            self.assertIn('failure-first', output)
            self.assertIn('failure-second', output)
            failures = [line for line in output.splitlines() if line.startswith('SUBFAILED')]
            self.assertEqual(len(failures), 2, output)
            self.assertIn("label='first'", failures[0])
            self.assertIn("label='second'", failures[1])
