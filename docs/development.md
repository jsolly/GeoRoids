# Development and release

This repository owns its gate, setup, CI and deployment scripts. A separate
configuration repository, private package or global skill installation is not
required. Templates used during migration are examples, not an enforced upstream.

Prerequisites: Git, Bash >= 5 and Python >= 3.11. Install mise on non-Linux hosts;
fresh Linux setup provisions a pinned, checksum-verified public mise binary in
`/usr/local/bin`, using noninteractive sudo only when needed. The repository's `.mise.toml`
and `.nvmrc` own its tool pins. On a reviewed fresh `origin/main` checkout run:

```bash
bash scripts/setup-agent-environment.sh
```

On Linux, setup also provisions the public native canvas build libraries with
APT and noninteractive sudo when needed. Existing `.env` settings are preserved;
a missing file is created empty for the local server.

Setup installs repo-owned hooks outside the working tree, provisions the pinned
tools and lockfile dependencies, and leaves browser binaries to explicitly requested manual tools.
Claude Code's `startup|resume` hook passes `--session-hook`. A fresh checkout
without `node_modules` runs setup; an existing tree is checked without installing
tools or dependencies. Setup records the manifest, lockfile, repository tool and
npm settings, resolved Node/npm runtime, installed lock and package manifests after
a successful install and complete `npm ls --all` check. Warm hooks require that
receipt to match without starting Node, npm or the tree check, because a new cloud
session's first disk reads are slow.

Changed inputs, missing packages, failed installs and older trees without a receipt
fail the hook instead of replacing dependencies underneath a running service.
Stop this checkout's services with `npm run dev:kill`, then run
`bash scripts/setup-agent-environment.sh` explicitly to repair and record the tree.
Manual setup deliberately reinstalls dependencies; stop services before using it.
The receipt detects install drift, not arbitrary changes to every package file;
warm hooks also miss packages outside the installed lock or an invalid dependency
graph until the next explicit setup.

Automated code checks never launch or download browsers. Run the repo's documented quality gate with its pinned tools:

```bash
mise exec -- npm run gate
```

Use the repository's README and AGENTS.md for its build, test and deployment
commands. A missing prerequisite is a failed setup; report it rather than claiming
that the gate ran. No setup command deploys the application or infrastructure.

## Hook trust

The dispatcher lives in this clone's Git common directory, shared only by its
linked worktrees. It registers pre-commit only. The complete hook/library/setup
bundle must match current reviewed `origin/main`, or a deliberately approved exact
bundle digest. Missing files, symlinks, unreviewed modes and a foreign origin fail
closed. The dispatcher executes a verified snapshot, then runs quality scripts in
the committing checkout. Re-run reviewed setup after changing tool setup on main.
A warm session hook reinstalls hooks itself only when the installed bundle is
stale and the current one is trusted, as in a cached cloud environment built
before a reviewed bundle change. Those environments check out the session commit
without updating `origin/main`, so the repair first refreshes that trust anchor from
the remote; if it cannot, install compares against the local copy and fails closed
for a newer bundle. The repair applies no new provisioning steps,
such as native APT packages; explicit setup or the environment's next build does.

This is hook-registration integrity, not a sandbox. Never check out or execute
third-party/fork PR code in a trusted clone; review its diff through GitHub. Do not
run its npm lifecycle or setup scripts. Use a separate disposable environment when
execution of untrusted code has been explicitly authorized.

The sole current hook identity is `config/agents/repository.json`. Missing,
symlinked or duplicate current/retired identities fail before registration.
After merge, use ordinary reviewed main setup. Older feature branches must first
merge the configuration migration before repairing their setup.

After independent semantic/security review of your own gate change, get its exact
digest with `bash scripts/repo-python.sh scripts/repo-hooks.py digest`. Use the installed snapshot's
`approve --root <absolute-repo-root> --digest <reviewed-digest>` command, with actual
values, to approve only those bytes; never approve a fork's bundle. Approvals are
repo-local. For an installed legacy snapshot, use the reviewed current helper's
`approve-upgrade` operation with that exact digest. It authenticates the installed
legacy bundle against protected source or an existing exact approval before
authorizing the replacement; ordinary `approve` cannot bypass that check. The
legacy implementation remains solely a frozen test fixture. Revoke explicit approvals with `git config --local --unset-all
repo.trustedGateBundle`; current reviewed main remains trusted. Changing origin
invalidates the bundle identity. No environment variable selects another library.

## Review and integration

Work from fresh main on an isolated branch. Review the actual final diff for bugs,
secrets, security, tests and repository guidelines; use an independent reviewer
for substantial or sensitive changes. Run the required complete local gate before
pushing. Create a same-repository PR; use a draft while approval/work remains.
Merge only when the required CI validates the exact current head. Never push to
the default branch, weaken rulesets, bypass checks or use an admin merge. Optional
personal review skills may help, but they are not prerequisites for this flow.

Preserve existing code-only Deploy, production-main-only Vercel and opt-in Preview
rules. Never trigger a preview merely to validate this migration. Verify the
intended deployment and exact-release smoke when the repository requires them.

## Infrastructure and access

Setup, build and checks use public tools and need no AWS login. Separately
authorized AWS reads use exactly one native production `aws_mcp` connection for
`agent@jsolly.com`, authorized as `AgentMcp` in account `730335616323`. Do not
export its OAuth credentials, install an agent AWS profile or credential-process
helper, add a second MCP connection, or bridge it into local CLI calls. Preserve
AWS Core for skills and public knowledge, and preserve named human administrator,
application, Vercel and workload credentials.

Removing the repository bootstrap does not remove installed helpers, cached
sessions, saved provider settings or live IAM trust. Provider isolation and
legacy credential retirement require their separate acceptance evidence.
Agents do not recover credentials, broaden grants or run destructive
infrastructure/database operations. Review Railway's complete
redacted live configuration and plan before any production configuration apply;
preserve unrelated staged dashboard changes. Follow the repository's
[deployment operations](agent-operations.md#deploy) and
[Railway plan procedure](../.railway/README.md). Production configuration, data
changes and protection changes remain a concrete handoff to the human owner with
the exact reviewed repository commands. A successful code deploy does not prove
infrastructure adoption.

Repository instructions and access rules are maintained here. Personal home
configuration and optional global skills remain separate and are not installed,
removed or overwritten by repo setup.
