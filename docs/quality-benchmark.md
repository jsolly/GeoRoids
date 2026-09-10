# Knip and ts-prune benchmark

GeoRoids runs **Knip 6.35.1 and ts-prune 0.10.3** as blocking local and CI checks.
Knip checks unused files, dependencies, exports, and types. ts-prune also catches
unconsumed type export keywords that Knip treats as used through public signatures.

## Measured results

Both tools analyzed the same saved source tree, including client, server, tests,
and scripts. Measurements used Node 24.16.0 on macOS 26.6.2 ARM64, one warm-up
followed by five alternating runs per tool, with no concurrent test or build.
The table uses ts-prune with the **ts-morph 28.0.0 parser override** now installed.

| Measurement | Knip 6.35.1 | ts-prune 0.10.3 + ts-morph 28.0.0 |
| --- | ---: | ---: |
| Median elapsed time | 0.408 s | 2.133 s |
| Fastest–slowest measured run | 0.394–0.463 s | 2.080–2.268 s |
| Reported export/type symbols | 71 | 136 |
| Findings also reported by the other tool | 65 | 65 |
| Findings unique to this tool | 6 | 71 |
| Exit status with findings | 1 | 1 |

Knip was approximately 5.2 times faster in this run. These timings include command
startup and configuration loading with warm filesystem caches; they do not measure
memory or general performance across projects. The commands were
`knip --include exports,types --no-progress` and `ts-prune --error`.

## What each tool added

Knip's six unique findings were `LASER_HIT_RADIUS`, `LASER_ROID_AUTHORITY_SLOP`,
`checkCircularCollision`, `ClientLogDiagnostics`, `ClientLogIngressResult`, and
`currentLogLevel`. Its 71 findings comprised 58 value exports and 13 exported types.
The unused export keywords were removed, and the dead `currentLogLevel` alias was
deleted. Declarations used within their defining modules remain.

ts-prune's 71 unique results comprised 70 unconsumed type/interface export keywords
and the `vitest.browser.config.ts` default export. The 70 export keywords have now
been removed, preserving the live supporting types. The gate declares Vite and
Vitest configuration modules as tool entry points in `tsconfig.prune.json`, so their
required default exports are not falsely reported. There is no findings baseline,
ignore pattern, or source suppression.

The first comparison used ts-prune's original ts-morph 13 parser. It reported 163
symbols and took a median 1.798 seconds, versus Knip's 0.413 seconds. Of the 98
results unique to that run, 23 had real external references and four were syntax
tokens misread as exports. Updating the parser eliminated all 27 false positives.
The remaining results were the same 70 supporting type exports and one tool entry.

The override keeps ts-prune's analyzer while supplying a parser that understands
`satisfies` and bundler module resolution. ts-morph 28 uses TypeScript 6.0; the
measured application used TypeScript 5.9. The application compiler has since
advanced to TypeScript 7.0, and the parser override remains separately pinned. The installed CLI contract tests exercise
namespace imports and `satisfies`, then prove that adding an unused export causes
each tool to exit with an error. This is a repository-tested dependency override,
not an upstream ts-prune release. [ts-morph release notes](https://github.com/dsherret/ts-morph/releases/tag/28.0.0)

## Configuration and evidence

The immutable source snapshot was based on commit
`c60859d20c03a760ee9e423a50c9996a723c2781` plus the cleanup working tree. Its manifest
SHA-256 was `2e888434f38f62d52e1fae8375fdd6db588b97ead0759475fe45e976683d3880`.
Both tools read that same tree with the installed dependencies. Since the snapshot
has no `.git` directory, both commands received the actual commit through
`VERCEL_GIT_COMMIT_SHA` for Vite's required release-identity check.

Knip's entry points include shell-invoked scripts and browser tests. The benchmark
restricted its report to exports and types for the symbol comparison; the active
gate checks all categories and treats configuration and tag hints as errors.
Its dependency exceptions identify `concurrently`, `markdownlint-cli2`, and
`jsonc-parser`, whose consumers are shell scripts. The current analysis also
includes the benchmark modules added after this measurement. ts-prune uses `--error`; its default exit status
would otherwise permit findings. [ts-prune CLI](https://github.com/nadeesha/ts-prune)

Run both gates from the repository:

```sh
cd /Users/johnsolly/code/GeoRoids
npm run prune
```

The individual commands are `npm run check:knip` and `npm run check:ts-prune`.
Both are required by the pre-commit gate and GitHub CI.
