# Repeatable phone FPS measurement

## Recommendation and current status

Use an automated run on a fixed older Android phone as the reference measurement. Keep
the desktop GPU benchmark as a fast regression lane, calibrated against that
phone. A viewport preset and CPU multiplier alone cannot establish phone FPS;
[Chrome documents those limitations](https://developer.chrome.com/docs/devtools/device-mode#limitations).

The user selected Samsung Remote Test Lab first, with AWS Device Farm as the
fallback, then requested a setup handoff while local optimization continues.
The [phone testing setup follow-up](../phone-testing-setup.md) records the live
Samsung A53 inventory, RDB/ADB requirements, sign-in boundary, verified AWS A51
inventory and 1,000 remaining trial minutes, pricing and exact remaining work.
No account or phone session was created. No phone FPS has been measured.

Keep the reported iPhone 16e and iPhone 17 slowdown as a separate Safari check.
The existing 25% movement/projectile slowdown is implemented and independently
reviewed; that changes game pace, not phone frame rate.

## What the number means

Measure the running game on the phone, rather than the video streamed from a
device service. Reuse `ClientPerformanceMetrics` in
`src/diagnostics/performanceMetrics.ts`; an additional FPS-overlay library does
not supply a phone GPU model or better workload control.

For each foreground play/respawn session report:

- **Render-loop FPS:** `1000 * intervalCount / sum(frameIntervalMs)`, with explicit
  boundary-reset handling and coverage checks. Do not average instantaneous
  `1000 / interval` values. Require completed-render counts to agree with frame
  intervals, and retain errors/hidden/rejoin time separately.
- **Stutter:** p95/p99 frame interval, intervals above 25 ms and 33.3 ms for the
  proposed 60 FPS target, plus the worst one-second window. Record actual browser
  cadence and display settings; do not combine 60 Hz and 120 Hz cohorts.
- **Responsiveness:** existing handler-to-render latency, snapshot arrival gaps,
  parse/decode/application CPU, and server tick/broadcast cost. A smooth local
  animation can still accompany stale remote gameplay.

These JavaScript measurements describe render-loop cadence and submission, not
guaranteed physical display presentation or hardware input latency.
[requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
is scheduled before repaint. Calibrate with separate short phone traces using
[Safari's rendering-frame timeline](https://webkit.org/web-inspector/timelines-tab/)
or Chrome's frame diagnostics. Keep profiling runs separate from timing
acceptance. Disable screenshot capture, screencasting and live video where the
provider permits; [Chrome explicitly warns that screencasts affect frame rates](https://developer.chrome.com/docs/devtools/remote-debugging).

## Repeatable experiment

1. Pin client/server build hashes, harness/dependency hashes, phone model, actual
   OS/browser version, orientation, viewport/backing size, graphics settings and
   network path. Retain provider session/device identity when exposed. Reject
   silent device/version substitutions.
2. Use the repository-owned isolated benchmark server and fixture. Run traversal
   and five-pilot combat separately. Record actual visible populations, motion
   acknowledgments and admitted projectiles, not just initial entity counts.
   The current corrected peer driver must be used in every arm.
3. Run trusted touch inputs on a fixed schedule. Keep dispatch timing and
   cancellations in the report. Browser automation round trips must not pace
   the workload; missed input slots and stale state make a comparison suspect.
4. Use 30 seconds of warmup and at least five foreground minutes per recording.
   Start with a clean connection to isolate graphics. Repeat constrained-network
   cohorts separately with the same explicit proxy settings.
5. Run three A/A pairs to measure unchanged-build variation, then three A/B pairs
   with alternating order and a consistent cooldown. Compare session results;
   never pool phone models or millions of correlated frames as independent runs.
   A claimed improvement must exceed the observed A/A variation without worsening
   input response, workload coverage or recovery.
6. Validate the chosen change in a separate 15-minute session on an owned phone
   under recorded battery/power/brightness/ambient conditions. Run a separate
   instrumentation-on/off calibration. Long-session heat and recorder overhead
   are acceptance questions, not properties established by a cloud device name.

## Repository work needed

The current phone collector already stores raw samples, release IDs, graphics
settings, phase time, user-provided conditions and checksummed recoverable
downloads. It does not carry automated fixture, trusted-input, exact source or
provider-device witnesses. The controlled comparison CLI intentionally rejects
those exports. Do not relax that validation to manufacture a phone comparison.

Add a real-device adapter around the current benchmark: session creation,
trusted touch, in-page metric drains, build/workload witnesses and deterministic
cleanup. Keep provider access in benchmark tooling and credentials outside
source. Reuse the existing snapshot peers and isolated server controls. Retain
device-side metrics in bounded memory with periodic export, and measure drain
overhead before accepting timings. New export provenance must let the comparison
CLI identify real devices explicitly rather than relabel desktop emulation.

The current client, health and WebSocket targets use local `127.0.0.1` ports.
A cloud phone cannot reach those loopbacks. For the AWS trial, use a dedicated,
externally reachable HTTPS/WSS benchmark fixture with pinned client and server
artifacts. Configure all three endpoint URLs explicitly; verify health/release
identity from both the controller and device, and require the device's actual
WebSocket handshake and first snapshot to identify the expected fixture. Keep
fixture controls private to the controller. Record and stop only the run's owned
peers, Appium session, Device Farm session and fixture resources, including on
timeout or failure. Hosting cost is separate from device-minute pricing.
Provisioning and running that fixture remain open work. If BrowserStack is
selected instead, use its documented Local tunnel and record the tunnel route
with the same endpoint and cleanup witnesses.

The trial succeeds only when repeated unchanged-build sessions finish with
complete samples, admitted combat work, verified device identity, clean cleanup
and acceptable A/A variation. If a service cannot supply those controls or its
mandatory streaming materially distorts results, use an owned device with local
automation as the reference and reserve the cloud service for compatibility.
