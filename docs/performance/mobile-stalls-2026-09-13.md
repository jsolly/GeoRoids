# Mobile stalls: investigation and partial post-mortem

## Status

The cause of the iPhone freezes remains unconfirmed. This patch removes
confirmed unnecessary media work and adopts lazy Web Audio playback. Neither the
recordings nor desktop Chromium tests prove that audio caused the multi-second
pauses. Physical iPhone retesting is the next acceptance step after deployment.

## Observed impact

John reported severe freezes on an iPhone 16e, especially when firing, with the
game Sound setting off. Both supplied captures validate against their embedded
SHA-256 checksums. Both used client/server release `3bca766`, native DPR 3, and
recorded no hidden-tab time. The earlier incompatible-deployment incident is
separate from these captures; deployment lag does not explain these recordings.

| Capture | Gameplay time | Frame gaps over 1 second | Longest gap | Frame CPU p95 |
| --- | --- | --- | --- | --- |
| `494e60de-c31b-41a7-b66e-8d2aa31d0282` | 101.911 s | 6 | 5.227 s | 2 ms |
| `Second-recording.json`, glow off | 81.810 s | 11 | 5.234 s | 3 ms |

These are aggregate raw gameplay samples, excluding menu and respawn phases.
Both collectors report delayed collection; the samples establish stalls but
are not complete CPU profiles. Disabling glow did not eliminate the problem.
The sessions differ in actions and duration, so the larger count is not proof
that disabling glow made performance worse. Firing correlation is the user's
observation; buffered shot notifications do not identify the exact stall trigger.

Frame callbacks, collection timers and WebSocket processing pause together.
Updates then arrive in bursts. Measured update/render calls never approach the
multi-second gaps. This is consistent with browser scheduling, native work or
another uninstrumented callback; it does not isolate a WebKit or GPU defect.
Server logs also show movement-command rejection after stalls, a separate
recovery concern that this audio patch does not address.

## Confirmed audio defects and contributing change

`GameController.advanceSimulationFrame` calls `replaceThrustSources`, which
calls `applyThrustPlayback`. With sound off, that function calls `Sound.stop`.
Previously, every stop invoked `pause()` and assigned `currentTime = 0` for both
thrust media elements, even when they had never played and were already idle.
A 60-step muted regression failed on the old implementation: each thrust stream
received 60 pause calls and a seek on every step.

The repeated stop/seek behavior predates sound PR 562. That PR added 16 cue pools
totaling 61 HTML audio elements on top of the existing 17. Constructors ran when
modules loaded, including when sound was disabled. Expanding these eager pools
increased unnecessary native media setup. Its contribution to the phone stalls
is plausible, but not established by the captures.

The new laser pitch and restart operations executed inside the Sound-enabled
guard. `playWorldSound` also returned early when muted. The regression confirmed
that muted laser cues did not call `Sound.play`; blaming audible laser playback
for John's muted session was unsupported.

## Remediation

Replace HTML media pools with Howler's Web Audio backend, initialized only by an
interaction with sound enabled. Sound-off startup creates no media elements,
audio context, or sample downloads. Each sample is decoded and cached, with a
bounded number of concurrent voices. The synthesized split effect shares the
same real-time context. Cues encountered before readiness are skipped rather
than queued for delayed playback. Muting stops voices and suspends the context;
repeated muted simulation steps do no native audio work.

Keep audio recovery outside the simulation loop. User gestures and browser
lifecycle events handle readiness and interruptions, with cancellation checks
so an old asynchronous completion cannot restart playback after mute. Preserve
pitch variation, spatial volume, and the existing Sound preference.

The initial narrow idle-stop fix was superseded by this backend replacement.
The [sound design documentation](../sounds.md) records the browser guidance
behind the new lifecycle.

## Why existing coverage missed it

Playback tests verified audible cues and mute behavior after playback. They did
not assert that a muted startup allocates no audio resources or performs no
native operations during repeated simulation steps. Media mocks could pass
while every sound constructor still allocated real browser resources. The new
browser probe observes native context, media, and source creation without
replacing playback or decoding.

## Verification

The new native browser regression failed against the old backend in both
viewports: a Sound-off game constructed 78 audio elements. This establishes that
the regression detects the eager allocation defect.

The replacement passes all four native Chromium scenarios: muted and enabled
play at 1280x900 and 390x844. Muted steering/firing creates zero audio elements,
contexts, or sound requests. Mobile input uses browser touch events. Enabled
play reuses the same decoded laser buffer, varies pitch, runs sample and split
synthesis through one context, immediately stops active sources on mute, and
reaches the suspended state. All 20 shipped samples decode to nonzero audio.
Both browser receipts contain zero console warnings/errors. Screenshots of the
game and `/wiki/#hud-network` were inspected at both viewport sizes.

All 69 focused unit tests pass across seven files. They cover voice limits,
loop pitch/volume, dropped unloaded cues, mute during loading/resume, hidden and
interrupted context handling, rejected HTML playback fallback, and stopping and
bounding synthesized sources. The full local repository gate passes, including
lint, unused-code checks, TypeScript, unit tests, and the production build.
A development reload invalidated an earlier browser run; the stable rerun passed
all four scenarios without skipped cases.

Local browser artifacts are in `tests/integration/browser/screenshots/`:
`audio-desktop.png`, `audio-mobile.png`, `audio-wiki-desktop.png`,
`audio-wiki-mobile.png`, and corresponding `audio-*-receipt.json` files. These
files are ignored. The Wiki now explains initial loading and skipped unavailable
cues; no control mappings or demonstrations change. Chromium's mobile viewport
runs on desktop hardware and does not substitute for an iPhone result.

## Physical-phone acceptance

Retest on the same iPhone 16e after the deployed release is verified. Start with
Sound off, steer and repeatedly fire, then collect another performance capture.
Repeat with sound enabled and include background/foreground transitions. Compare
frame-gap counts and longest gaps over similar gameplay durations.

If stalls persist, collect native browser/main-thread activity and investigate
callbacks outside the current frame timers. The recordings do not attribute the
missing time. Reproduce post-stall movement rejection separately and add recovery
coverage once its mechanism is established. Final incident closure requires the
physical-phone result.
