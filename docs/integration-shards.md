# Isolated integration shards

From `/Users/johnsolly/code/GeoRoids`, or the absolute feature-worktree path, run
`npm run test:integration:sharded`. The existing `scripts/test-runner.sh` owns the
run and its common-Git lock. `npm run test:review` uses the same six-shard path
before running its performance measurements serially.

The coordinator collects every integration file and expanded case, then starts
six runner children using Vitest `--shard=1/6` through `--shard=6/6`, with at most
three active children. Proposed complete-file costs allocate six equal-capacity
buckets with relative capacities `1, 1, 1, 1, 1, 1`. Load balancing and the
heaviest-first queue dispatch the remaining buckets after verified cleanup. Current discovery owns the inventory. New files or
changed case counts use a median per-case estimate and remain included. Each child
keeps one fork, one worker, isolated files, no file parallelism, no concurrent
sequence and maximum concurrency one. Individual test and hook budgets remain
unchanged. Standalone file/directory runs retain their 1,200-second default and
own Vite/server pair. Benchmark modes remain serial.

Set `GEOROIDS_TEST_MAX_ACTIVE_SHARDS=2` on a memory-constrained local host
to run at most two children. Values `1`, `2`, and `3` are accepted; the default
remains three. All six shards and every discovered case still run, with the same
600-second aggregate deadline and individual budgets. The selected cap is bound
to the coordinator, assignments, authenticated children, queue, and review receipt.
Lower concurrency does not waive the complete gate or its timing requirement.

Collection uses Node with dynamic registration and per-file isolation. Playwright
scenario files select Node workers and still drive real Chromium/WebKit pages.
Entity and unit DOM tests retain their existing environments; all gameplay
children retain the isolated serial worker configuration. Discovery
records each file's actual environment, source and tool fingerprints, and
collected or unhandled errors. Missing evidence fails the run. Exact comparison
against gameplay reports rejects environment-dependent registration differences.
The discovery probe checks the reviewed Vitest 5.0.1 runtime accessor explicitly;
an incompatible upgrade requires a reviewed probe update.

## Ownership and isolation

Only the coordinator can issue a child assignment. A child waits up to five
seconds for its 0600 manifest, then checks its nonce, actual PID and parent,
process birth times, worktree realpath, run ID and live common-lock owner. A
caller cannot pass a partial `--shard` through the standalone runner. Children
never release the coordinator's lock.

The installed Vitest sequencer checks the issued assignment digest, actual live
process ancestry and exact full candidate inventory before selecting its bucket.
Copied environment variables cannot authorize a partial suite. The retained
`assignments.json` records all current files, estimated weights and fallback
reasons; weights never replace expanded case discovery.

Each child has distinct Vite and game-server ports and an in-memory world. Its
logs, screenshots, audio/crew/fixture receipts, Vite and Vitest caches, temporary
files, console output, Vitest JSON and cleanup receipt live under its own shard
directory. Ordinary development and production log locations retain their
defaults. The coordinator also isolates collection output, diagnostics, cache,
logs and temporary files; collection runs in test mode with an in-memory world.

Children run in owned process groups. The runner cleans its process tree, and
the coordinator checks surviving group members and listening ports before
returning control to the lock owner. A cleanup or inspection failure fails the
run; it never authorizes killing an unrelated listener. A slot becomes available
only after process close and verified cleanup.

Failure, deadline or interruption stops the queue permanently and signals each
active child once. On TERM or INT, the lock owner signals the coordinator once
and keeps the lock during a 30-second receipt-first shutdown. Repeated signals
cannot interrupt child cleanup. Missing cancellation receipts or an unresponsive
coordinator cause explicit failure-marked owned-tree fallback; the owner retains
its cancellation and cleanup inspection before releasing the lock.

Ownership records precede child authorization and include the discovery process.
Group signals require verified process birth and membership; an observed-empty
group remains retired. Pending or failed cleanup markers block stale-lock
reclamation, including after an owner crash. Unresolved ownership retains the
lock and its evidence rather than treating a dead owner as proof of cleanup.

## Evidence and acceptance

The command prints a retained `.performance/integration-shards/run-*` directory.
It contains discovery identities, each shard's report/output/logs/screenshots,
process and cleanup receipts, per-file timing evidence, an artifact hash index
and `result.json`. The
review runner retains a receipt pointing to this directory. Failed attempts
remain available; there are no retries or exclusions.

The aggregate compares files and every source-located full case name with the
complete discovery set. Repeated titles use source location and occurrence
counts; duplicates cannot replace a missing case. Missing or malformed output,
failed/skipped/todo cases, reset or evidence failures, child exits, cleanup and
retention failures all fail the aggregate, even when report metadata claims
success. A full run must finish in less than 600 seconds, including collection,
service startup, execution, cleanup and artifact indexing. Three successful
real runs establish the timing acceptance; contract fixtures and discovery-only
runs do not.

For collection without starting game services, use
`./scripts/test-runner.sh --discover-integration`. It acquires the same lock and
retains the exact discovered file/case identities, but marks the result as
collection evidence rather than a successful integration run.
This mode collects in jsdom. `./scripts/test-runner.sh --discovery-node` collects
in Node for an explicit comparison; neither mode executes test lifecycle hooks
or test bodies. Setup modules and registration callbacks still run.
Compare exact source-located case identities from matching frozen-source runs,
alongside their environment, error and cleanup receipts.

The timing reporter records Vitest's five public module phases once each:
environment setup, harness preparation, shared setup, collection, and tests/hooks.
Their sum measures tracked file work; callback intervals also include reporter
and scheduling effects. These values are distinct from parent/child wall time.
Interrupted files retain partial evidence and cannot certify a successful
measurement. A successful child requires exact assigned rows, runtime versions,
zero retained errors and a complete receipt. The coordinator rechecks the source
after cleanup and artifact retention before accepting measurements.

Scheduling estimates are explicitly proposed observations, not an accepted
performance baseline. Complete passed file rows from a cancelled run can inform
estimates with their partial-run provenance preserved. Interrupted or unexecuted
files retain conservative historical estimates until measured successfully.
The three complete runs below 600 seconds still require
actual execution; predicted critical paths do not satisfy acceptance.

### Current acceptance and schedule

On October 1, John approved 600 seconds for each of three complete runs, including collection, startup, execution, cleanup and evidence retention. The original 300-second goal remains a future performance target. The current schedule uses six equal-capacity partitions with at most three active children after the four-slot experiment showed shared responsiveness failures. Historical measurements above are retained and do not establish a successful run. Native compile-cache diagnostics are optional collection-only tools; normal full-suite validation uses no cache treatment.

Three consecutive complete runs passed all 91 files and 210 cases on the same source fingerprint, taking 302.28, 336.14 and 365.86 seconds including the runner. Each aggregate retained zero errors and verified child cleanup. These establish the approved 600-second timing result; they do not meet the 300-second target.
