# Test runner inventory

The migration starts at `93f5d2033dbc9cbaec8a46d7be162ed664e256a8`.
Tracked executable sources include TypeScript, JavaScript, Svelte, Astro, Bash and
Python. There is no separate Python application or Python packaging lockfile.

## Existing Vitest suites

`config/testing/vitest.ts` owns unit, Svelte/jsdom component and server integration
projects. Their tests, assertions, discovery globs, coverage configuration and
single-fork isolation remain unchanged. `@vitest/coverage-v8` and Vitest are
already matching official 5.0.4 packages in the npm lockfile; no npm dependency
or lockfile change is needed.

`scripts/code-integration-runner.mjs` discovers literal server files, lists Vitest
cases, runs Vitest, compares file/case identities and outcomes, and records
source/runtime identity, deadlines and cleanup evidence. `test-runner.sh` selects
that supervisor or the manual benchmark supervisor. Neither implements another
assertion runner. Validation admission, review receipts and the gate remain
mandatory orchestration and evidence checks.

## Retired runners and migrated checks

The 11 `scripts/*.test.mjs` Node test files originally discovered 148 cases with
`node --import tsx --test scripts/*.test.mjs`, all passing with no skips. They now
use Vitest's native test API. `t.after` cleanup becomes `t.onTestFinished`, and
file cleanup uses `afterAll`. Node strict assertions remain unchanged.

The `runner` project owns benchmark build receipts, benchmark runner, built
client checks, unused TypeScript checks, unused public class members, code
integration runner, port selection, TypeScript toolchain and validation
admission. The `smoke` project owns server
release inputs and production smoke scenario tests against owned fixtures. It
never contacts production.

The `actions` project owns the gate contracts plus the former standalone
`ci-contract.mjs` and `review-receipt-contract.mjs` assertion programs, now named
`*.test.mjs`. Their assertions execute inside reported Vitest cases. The gate's
hostile-Git child launches Vitest and excludes only its own recursive invocation;
the parent executes that case. Fixture runtime comparisons remove the test
runner's injected worker variables before launching their controlled processes.
Production environment handling remains unchanged. Tooling caches use each
issued session directory. The existing cache contract executes every tooling
project and proves that validation leaves installed dependency bytes unchanged.

The dev-server, lint-policy and preview-comment shell fixtures retain every
assertion and shell cleanup trap. Vitest orchestrates their complete scripts,
checking launch errors, signals and exit codes. `check-actions.sh` runs the real
pinned actionlint and ShellCheck tools after the contract tests; those are lint
checks, not test runners.

The 30 Python hook/bootstrap cases previously ran through `unittest.main()`.
Pinned official pytest 9.0.2 discovers and runs all 30 original cases plus a
runner compatibility regression. Native subtest support preserves the existing
10 `self.subTest` contexts. The regression runs two deliberately failing subcases
and verifies both execute, report separately, continue and clean up. It rejects
pytest 8.4.2 without its subtest plugin. The TestCase assertion,
mock and cleanup APIs remain intact, as supported by pytest. The direct unittest
runner entry point is removed. `uvx` provisions the exact pytest version, matching
the repository's existing approach for Python lint tools.

## Browser and manual tools

Playwright remains a browser automation library for explicitly invoked manual
benchmarks and frame measurements. No automated browser test runner, screenshot
test, browser download or new browser check is introduced. Wiki media uses
node-canvas and the existing pinned Python image encoder. Benchmarks and media
are not competing test runners.

No gameplay behavior or Wiki page changes. Existing tablet GPU work and draft
PR 836 are outside this branch.
