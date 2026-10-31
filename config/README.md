# Configuration

Move optional top-level tracked settings into `config/<domain>/` or their owner;
keep existing nested configuration with its component. Test configuration may live
under `tests/`. Give each setting one repository-owned home.

- `app/astro.ts` and `app/svelte.js` own framework/build settings. Package,
  development, integration and benchmark commands select the owners explicitly.
  Astro and Vitest select the same Svelte configuration by an absolute module-relative
  path. Astro's watch registration reloads its full container when the config changes
  or the Wiki refresh watcher signals that owner.
- `app/.env.example` is the non-secret development/benchmark template. Runners
  create native `.env.local` only when missing. Existing local environment settings,
  databases and platform secrets stay with their owners.
- `server/debug-reports.json` owns debug-report routing. Server imports, release
  classification and benchmark product fingerprints follow that owner.
- `typescript/tsconfig.json` owns compiler policy, with empty `files` and `include`
  so it does not independently select inputs during native discovery. Root
  `tsconfig.json` owns the original explicit project membership; Vite, TSX and
  the server release graph discover it natively. Keep generic config siblings,
  compiler-policy descendants, benchmarks and `dist/` outside that root scope.
  Removing the ineffective root `.railway` include preserves the existing selected
  TypeScript inputs; Railway definitions keep their native owner.
  Nested build, frontend, benchmark and unused-code owners retain their own input
  lists and inherit this policy. Package commands select them explicitly.
  Root `tsconfig.frontend.json` remains a minimal adapter: its directory preserves
  the pinned Svelte checker's workspace and explicit Svelte-owner scope. Moving
  it into `config/typescript/` would omit preprocessing for `src/`; moving it into
  `src/` narrows the existing repository-wide scope. `--workspace .` does not
  override that selected-config directory. No duplicate compiler settings remain.
- `testing/vitest.ts` owns the existing projects, roots, conditions, per-session
  caches, coverage and worker isolation. Package and integration runners select it.
  `config/testing/tooling.ts` owns isolated Node tooling projects;
  `config/testing/pytest.ini` owns Python hook-test discovery and strict options.
- `quality/biome.settings.jsonc` owns the full root-scoped Biome policy. CLI checks,
  the severity inventory and atomic Wiki review formatting select that same file.
- `quality/prettier.json` owns Astro/Svelte plugins and basename formatting
  overrides. The formatting command selects it explicitly. `quality/knip.js`
  selects the actual framework/testing/quality owners and retains Svelte's Vite globs.
- `quality/yamllint.yaml` and `quality/.markdownlint-cli2.jsonc` are selected by
  the existing YAML command and root-anchored Markdown helper.
- `agents/repository.json` owns hook identity and the trusted file inventory.
  The authenticated upgrade procedure is in [development](../docs/development.md#hook-trust).

Required native exceptions remain: package manifests and lockfiles, `.npmrc`,
`.nvmrc`, `.mise.toml`, Git files, `.worktreeinclude`, `.github/`, native agent
registrations, the two TypeScript adapters above, `components.json`, `.pages.yml`,
`src/content.config.ts` and `vercel.json`. Each has an active native consumer.
Railway infrastructure definitions stay in `.railway/`. Application/setup code,
executable helpers, gameplay data, Wiki provenance/media, fixtures and public
assets retain their owners. No VS Code setup or editor extension is required.

The unused-export helper creates actual default-export consumers in its existing
disposable frontend entry. Canonical Astro/Vitest modules remain analyzed;
arbitrary named exports are never exempted by listing entire modules in `files`.
Generic inherited tool entries keep their existing contract.

Validation sessions own both Vite's cache and Vitest's enabled module cache.
`test.fsModuleCachePath` follows the issued session so a cold test run cannot
change the installed dependency inventory. The existing gate cache contract runs
all three real Vitest projects in a cold fixture and preserves native defaults
when no session was issued.

Historical root paths remain in the server release classifier when old commit
diffs require them. Current benchmark and Wiki inventories use the actual owners;
older review batches and benchmark measurements remain historical evidence.
Configuration moves cannot bypass source review, the server/client import boundary,
the complete local gate or any of the five required CI lanes. The Wiki media lane
must pass on linux-x64; a macOS run cannot replace it.

Compare effective roots, inputs, formatting, plugins, test scopes and actual build
artifacts before merging. Use both the TypeScript 6 API and selected TypeScript 7
CLI, plus actual Vite/Rolldown per-file resolution and output. The existing
`scripts/typescript-toolchain.test.mjs` checks native policy, scoped inputs and
nearer overrides in an isolated fixture. It covers cold discovery; acceptance
also changes and restores the physical compiler-policy and Astro owners while
serving the same module with native caches. Initial startup alone proves no reload. Verify the intended Vercel release, classify server inputs
from the actual base/merge SHAs, verify any required Railway Git release, then follow
the exact-release production smoke. This authorizes no Preview, unrelated staged
Railway patch or infrastructure apply. No private checkout, home link, shared runtime,
generator or automatic synchronization is required.
