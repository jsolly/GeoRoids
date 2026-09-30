# Backlog implementation plan

The approved sequence contains 16 PRs. Status describes implementation progress,
not Todoist completion. Each PR starts from fresh `origin/main`, ships through
`/ship` semantic review and the full local gate, and merges by squash when CI is
green. Verify exact Vercel and Railway releases as applicable, then complete the
matching production smoke. Never infer deployment success from CI alone.

Gameplay acceptance covers desktop and touch with two clients, authoritative
rules, prediction, snapshots, reconnect, restart, locality and affected Wiki
content. Preserve existing shared state and the existing world. Mark completion
only after fresh evidence covers the PR's acceptance criteria.

## Sequence and acceptance

| PR | Work and required proof | Status | Todoist IDs |
| --- | --- | --- | --- |
| 1 | Reconcile verified completions and engineering decisions. Keep relative imports, no barrels and Canvas2D; verify existing regeneration and survey sharing. Distinguish historical performance from physical-phone proof. | In progress | Alias `6hcHJJpqRp2MmcMv`; GPU `6hcHJJxRJgM4GwWM`; regeneration `6hfGfxp2c6wf2gmM`; survey `6hfFGqgFPxC28f9v`; archived work `6hRVg8qpghM6Qv22` |
| 2 | Fix fixture determinism and retain actionable failure evidence for #715 and #716. Prove failures expose the cause without retries or weaker assertions. | Planned | Triage `6hfFQfq4PP367Vxv`; harness parent `6hfFQcvww7gHj4Mv`; human schedule `6hf8pMC4JVjgvgQv` |
| 3 | Fix WebKit audio and obtain cross-architecture proof for #714 and #717. Run 20 focused repetitions and three full suites on native ARM and x64. | Planned | Same triage, harness parent and human schedule as PR 2 |
| 4 | Prove authoritative firing in production. A correlated non-null `shotAcknowledged` is sufficient even if a collision consumes the bolt before a snapshot. Reject missing, null, wrong or stale acknowledgements; malformed snapshots still fail. | Planned | Projectile `6hfP8334Q638373M` |
| 5 | Run six isolated integration shards three times, each run under 300 seconds. Preserve isolation and failure evidence. | Planned | Shards `6hcHJM3WrR7Hh9CM` |
| 6 | Normalize full pre-commit checks, preserving the existing fleet documentation fast path exception, and scope Wiki source review to affected behavior. | Planned | Gate `6hcHJJjhGW7p6rFM`; Wiki `6hcHJJmG74wPCghv` |
| 7 | Audit targeted dependency injection and indexes. Use measured ownership and query needs to choose changes. | Planned | Singleton `6hcHJJrWqGh6qFqM`; index `6hfGCG7hM6rmgCfv` |
| 8 | Improve furnace travel and delivery feedback, including pinching, drop-off and shortage feedback. | Planned | Pinch `6hfFVMfQvxvm7JHv`; drop-off `6hfG7J5m99CC75mM`; shortage `6hfGfjj459h5v7Wv` |
| 9 | Add cargo shielding and hauling pressure. Consume 10 cargo points per HP; apply immunity first. Cargo speed scales from 1 empty to 0.7 full. Prove conservation, no loot consumption for full-cargo ships, retention of partial remainders and cargo drops on death. | Planned | Cargo `6hfGfwppj5j2hPmv`; roles `6hfFGqVW7vrcCWhv` |
| 10 | Add travelling tow/probe behavior at speed 1200. Preserve solo Hauler Tow Cable access to hives. Misses retract; each attempt incurs cooldown, enforced by the authoritative server. | Planned | Tow `6hfG7XPr4P73WcwM` |
| 11 | Add storage and encounter foundations plus an additive migration tool. Keep activation disabled until John applies the reviewed production database migration. | Planned | Foundation for cooperative parent `6hfFGm8JJVJ5JRmM` |
| 12 | Add crew signals and rescue. Downed state lasts 30 seconds; rescue range is 100, revive takes three seconds and restores 35% health. Preserve shared surveys. | Planned | Pings `6hfFGqhXJMf6Pc7v`; downed `6hfFGqGxgCjxFmxM`; survey `6hfFGqgFPxC28f9v` |
| 13 | Add queens with 500 HP, births every eight seconds and at most six owned spiders. Set two initial sacs and three expanded sacs, each with 50 HP and 20-second timing. Queen death permanently removes all owned spiders and its marker. | Planned | Queen `6hfFGqVRXR6496gM`; sacs `6hfFGqRWCgjQH9mv` |
| 14 | Add physical frontier restoration worth 9600, supplied from inward settlements, with a permanent 1200 atlas. Restoration is monotonic; cleared ruins have no furnace counterattacks. | Planned | Frontier `6hfFGqPVvGv8HPCv`; supply `6hfFGqMc8w3vG7Wv` |
| 15 | Add Town Square Deep Scanner requiring 10000 physical ore. Unlock the 20000–57500 frontier; initial frontier is 11000–20000. Activate the community frontier in the existing world. | Planned | Mega project `6hfFGqXQ5RvvhHrM` |
| 16 | Add UTC half-hour hazards. Warn at :25–:30 and :55–:00; active windows are :00–:03 and :30–:33. Affect ships and cargo, with no furnace damage. Reserve 12 swarm slots within 48 total; prove deadline cleanup. | Planned | Hazards `6hfFGqW8FMr7hmrM` |

## Locked decisions and human hand-off

Cargo is consumed as a shield at 10 points per HP. A solo Hauler uses Tow Cable
for hives. Queens keep birthing until death; death permanently clears their owned
spiders and marker. Ruin restoration only advances and never triggers furnace
counterattacks. The counterattack task `6hfFGqPMFqCMJfpM` is explicitly rejected
and already closed.

Hazards follow UTC half-hour boundaries, warn for five minutes and remain active
for three minutes. They affect ships and cargo, without furnace damage. Community frontier activation
uses the existing world rather than resetting it.

John alone applies the additive production database migration between foundation
and activation. PR 11 must provide the reviewed migration and exact hand-off
command; activation waits for its successful application. Agents do not perform
production database writes. Native ARM/x64 and physical-device scheduling remain
on the human schedule task where access requires John.

The engineering parent `6hcHJHRRJ3hVchRM` and cooperative parent
`6hfFGm8JJVJ5JRmM` close only when their descendants are resolved. Shared parent
IDs in the table do not imply the parent is complete. Root coordinates Todoist
updates and shipping; this document introduces no automatic schedule.

## Evidence ledger

PR 1's fresh focused tests and remaining verification are recorded in
[backlog decisions](backlog-decisions.md). Its full gate, semantic shipping
review, CI, deployment and production smoke remain pending. Later PRs require
their own evidence before their status changes.

The archived-work record `6hRVg8qpghM6Qv22` is closed. Root verified its children
with a fresh receipt; it records completed historical work and does not close
any planned PR above.
