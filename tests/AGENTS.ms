# Writing GeoRoids tests

Tests explain a game feature and prove its expected behavior. Optimize for a
small, trustworthy suite that a maintainer can understand. Coverage percentage
and test count are not goals.

## Start with a scenario

Name the player or system event and its outcome. Good examples:

- An enemy laser removes 25 health without costing a life.
- Both pilots see the same shot, then remove it when it expires.
- A credited bot kill appears in the HUD and updates the score.
- An asteroid collision costs one life, then the ship respawns inside the arena.
- A failed connection returns to the menu and a retry joins successfully.

Avoid names such as “collision system works,” “debug regeneration,” or “handles
messages correctly.” Each test should tell one coherent story. Related outcomes
of that story belong together; unrelated features need separate setup.

## Arrange, act, observe

1. Arrange explicit participants, IDs, factions, positions, health preconditions,
   protection state, and clocks. Use a fresh world or object graph for each test.
2. Perform the action through the boundary being tested: input, a socket message,
   the collision resolver, a lifecycle tick, or a public API.
3. Observe a result that would fail if that behavior broke. Prefer exact damage,
   the identified victim/projectile/drop, credited score, the actual death cause,
   a lifecycle transition, or rendered UI output.

Setting a ship's health to 25 can arrange a weakened ship. Setting it to zero and
then asserting that its health is zero does not test death. A screenshot or an
entity count cannot prove that a hit, collision, pickup, or respawn happened.

Snapshot preconditions by value. Do not retain a mutable position object and
compare it with itself after the action. An asynchronous test must await the
operation and its assertion; cleanup must also complete.

## Keep setup deterministic and simple

- Use fixed seeds and controlled clocks for simulation rules. Advance explicit
  ticks instead of starting an unnecessary real-time loop.
- Reset world, singleton, mock, clock, and configuration state between tests.
- Use the local test controls to arrange browser scenes and synchronize the
  authoritative pose. Those controls must not produce the outcome under test.
- Isolate the chosen interaction from unrelated bots, asteroids, satellites,
  drops, and previous deaths. Identify targets explicitly; do not pick an
  arbitrary first entity and hope ambient combat creates the desired result.
- Keep fixture helpers small. Prefer a controlled starting scene over a browser
  helper that searches for targets, navigates hazards, and retries combat.
- Reuse existing geometry or simulation functions when arranging a scene. Do
  not implement a second physics engine in test helpers.

Begin observing transient banners, shots, and events before triggering them.
Use bounded waits for the actual condition. An immediate destruction event can
precede the next loot snapshot. A socket receive log can precede validation.
A fixed sleep is appropriate only when passage of time is itself part of the
scenario; it is not evidence that an action succeeded.

## Put the proof at the right level

| Level | Use it for |
| --- | --- |
| Unit | Deterministic game rules, collision geometry, protocol validation, state transitions, and failure boundaries. |
| Server integration | Real transport negotiation, authoritative shared state, reconnects, and server lifecycle. |
| Entity integration | Interactions between components/entities through real simulation operations. |
| Browser | Real input, rendered state, HUD feedback, responsive controls, and multiplayer flows requiring a browser. |

Mocks should control external boundaries or failure conditions. A mock should
not return the exact gameplay outcome the test claims to verify. Model state
can prove synchronization; it cannot alone prove that a HUD element was drawn.
Use rendered evidence for a test named after UI behavior.
Matching tokens in renderer source cannot prove drawing behavior; observe the
executed canvas calls or rendered output instead.

When expected rendering uses a production geometry helper, retain independent
checks on the captured output, such as known positions, vertex counts, or scale
ratios. Otherwise a helper that ignores a scale argument can change both the
rendering and its expected result while the test still passes.

Keep important negative scenarios: invalid ownership, malformed commands,
production-disabled controls, resource limits, failed writes, deadlines, and
reconnect exhaustion. Exercise the observable rejection or failure rather than
asserting an implementation option. Give concurrent operations distinguishable
results so the test can detect incorrectly shared completion.

Diagnostics scenarios must preserve the causal boundary too: trigger an actual
state transition or write/transport failure, then inspect its correlated record
and outcome. A hand-authored log envelope cannot prove that the runtime logger
retains player IDs or event-time values. Control clocks and mutate the source
after logging when proving that recorded state is a detached observation.

## Consolidate instead of accumulating

Before adding a test, find the canonical scenario for the same feature. Extend
that scenario when the new assertion belongs to its story. Keep a separate test
only when it proves a distinct behavior or boundary.

Delete unconditional passes, placeholder tests, assignment-only assertions,
constructor smoke repeated under feature names, and weaker duplicates. When
consolidating, carry forward unique meaningful assertions and record where the
behavior is now proved. Do not retain a test merely to keep coverage numbers up.
Do not hide a failure with retries, skipped tests, broad tolerances, a weaker
assertion, or a longer timeout. Diagnose the setup or behavior first.

## Run and report honestly

From the GeoRoids checkout, use `npm test` for unit tests. A focused unit file may
run with `npx vitest run tests/unit/<scenario>.test.ts`.

Always run integration tests through `./scripts/test-runner.sh`; never invoke
raw Vitest on `tests/integration/`. The runner owns the Vite/server pair and
serializes execution. Do not overlap integration runners or attach to an
existing developer server. Run unit and integration batches separately when
they share logging or other process resources.

A failed reset, fixture operation, evidence read, or cleanup must fail the run.
Report the commands and results actually run, including any skipped or removed
tests. Screenshots are diagnostics, not a success criterion. The repository's
full pre-push gate remains `npm run gate`.
