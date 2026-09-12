# Follow-up: a repeatable phone testing setup

## Status and recommendation

Investigated September 12, 2026. Start with Samsung Remote Test Lab on a fixed
Galaxy A53. Use AWS Device Farm on a Samsung A51 running Android 13 if Samsung's
debug bridge or automation cannot support the workload. Keep the iPhone 16e and
iPhone 17 as separate Safari checks; success on Android cannot establish that
the reported iPhone slowdown is fixed.

This is a setup handoff requested by the user. No phone session ran, no Samsung
account was created, no password was generated or stored, and no AWS project or
billable session was created. The user redirected account setup into this
document. Physical-phone FPS, sustained heat, and recorder overhead remain
unmeasured. Local results are recorded separately in the
[implementation report](performance/mobile-implementation-status.md).

## Samsung Remote Test Lab

### What was verified

The live [Galaxy A inventory](https://developer.samsung.com/remotetestlab/devices/124/galaxy-a)
displayed four available Galaxy A53 devices. The other visible models were A54,
A25, A26, A36, A56, A17, A07, A37 and A57. A cached search result listed A24/A34,
but those were absent from the live page. Recheck the live inventory when booking;
counts and models are not a reservation guarantee.

Selecting A53 displayed a sign-in requirement. Samsung account sign-in opened
successfully, but we did not authenticate. OS versions, individual device IDs,
locations, account credits, installed Chrome version and hardware variant still
need confirmation. Prefer a nearby location, then keep that location fixed.

Samsung's [usage rules](https://developer.samsung.com/remotetestlab/doc/about-remote-test-lab)
describe 20 daily credits, each worth 15 minutes: five hours of new credit daily.
The minimum reservation is 30 minutes, costing two credits. The documented
maximum is ten hours daily with 40 credits; that is not the daily free grant.
Unused reservation time can return credits. A Samsung Developer account is
required. No paid subscription is needed for the documented allowance.

The current [web client guide](https://developer.samsung.com/remotetestlab/doc/get-started-with-web-client)
documents model/OS selection, rotation, remote touch, clipboard/file transfer,
audio streaming and screen-quality controls. Mouse drag sends a swipe;
Shift-click plus drag provides a two-finger zoom interaction. This does not yet
prove sustained independent steering and firing for GeoRoids.

The [device testing guide](https://developer.samsung.com/remotetestlab/doc/tests-on-devices)
marks its built-in Automated Test feature temporarily unavailable. It also
documents a Remote Debug Bridge, or RDB: install ADB locally, run Samsung's RDB
application, select Connect in the web client, and accept the debugging prompt
on the reserved phone. This is the promising path for our own automation.
The RDB helper's current macOS/Apple Silicon compatibility, download and session
behavior have not been tested. ADB was absent from PATH and the usual local SDK
platform-tools directory during the investigation. Nothing was installed.

### First-session procedure

1. Sign in or create a Samsung account. Check for an existing vault login first.
   The requested credential destination is Bitwarden's Agent collection. The
   vault was locked when inspected; no collection or login was read or changed.
   Resolve the account email, required profile fields, terms and verification in
   the account flow. Keep passwords and recovery data in the vault.
2. Reserve one A53 for 30 minutes. Record the exact device, region, OS, Chrome
   version, viewport, device pixel ratio, refresh rate and power state. Pin these
   for later comparisons. Do not combine different device allocations silently.
3. Open GeoRoids in Chrome and prove Play, held steering/fire, death/respawn and
   orientation behavior. A short production session can establish compatibility;
   its uncontrolled live world cannot establish an optimization comparison.
4. Obtain the RDB helper through Samsung's authenticated interface and use
   official [Android SDK Platform Tools](https://developer.android.com/tools/adb).
   Connect only to the reserved phone, verify its identity, then inspect Chrome
   through the documented [Android remote-debugging path](https://developer.chrome.com/docs/devtools/remote-debugging).
5. Test whether the bridge permits a local benchmark connection and Chrome
   automation. The repository uses Playwright, whose [Android support](https://playwright.dev/docs/api/class-android)
   is experimental. ADB availability alone does not prove that the current
   desktop CDP benchmark runs unchanged. Verify simultaneous trusted input,
   in-page evaluation, raw sample extraction and tab cleanup before adapting it.
6. Test recorder and streaming overhead. Audio can be disabled, and screen
   quality can be adjusted, but we did not establish that video capture can be
   disabled. Closing the web viewer may affect the RDB session; test it. Read FPS
   from the game running on the phone, not the streamed video.
7. Export the samples, release held input, close the owned game tab, disconnect
   the bridge and release the reservation. Verify the reservation ended. Keep
   device/session details and any failure alongside the recording.

Use AWS if RDB is unavailable on this Mac, trusted multitouch cannot be driven,
recordings cannot be exported, or repeated unchanged-build trials vary too much
to distinguish a useful improvement. A temporary sign-in requirement alone does
not establish that Samsung is unsuitable.

## AWS Device Farm fallback

### Verified account and inventory

Read-only AWS CLI calls succeeded using the existing `agent-readonly` profile in
`us-west-2`. The account reported **1,000 total and 1,000 remaining trial minutes**,
zero unlimited Android/iOS slots and no Device Farm projects. This is an actual
account readback, not an assumption from the advertised trial. Recheck before
starting a session because other work can consume that balance.

The authenticated inventory contained 106 Android entries, including:

| Device | Android | Remote access | Availability at inspection |
| --- | --- | --- | --- |
| Samsung A51 | 13 | Enabled | Highly available |
| Samsung A51 | 10 | Enabled | Highly available |
| Samsung Galaxy A13 5G | 11 | Enabled | Highly available |
| Google Pixel 4a | 11 | Enabled | Highly available |
| Google Pixel 3a XL | 11 or 12 | Enabled | Highly available |
| Google Pixel 3a | 10 | Enabled | Highly available |

Recommended fallback identity: Samsung A51, Android 13,
`arn:aws:devicefarm:us-west-2::device:FE809921D72C48798B9F7DEFF547F79C`.
The device ARN selects an inventory configuration; it does not prove a specific
physical unit was allocated. Save the returned instance identity when available.
Do not interpret the inventory's `memory` value as measured available RAM.

Raw read-only receipts are in the implementation worktree's gitignored
`.performance/aws-android-inventory.json` and `aws-devicefarm-allowance.json`.
To refresh them from `/Users/johnsolly/code/GeoRoids`, run these read-only commands:

```sh
aws devicefarm get-account-settings --profile agent-readonly \
  --region us-west-2 --query accountSettings.trialMinutes --no-cli-pager
aws devicefarm list-devices --profile agent-readonly --region us-west-2 \
  --query 'devices[?name==`Samsung A51`].{arn:arn,os:os,remote:remoteAccessEnabled,availability:availability}' \
  --no-cli-pager
```

### Price and automation path

[Real-device pricing](https://aws.amazon.com/device-farm/pricing/) is $0.17 per
device-minute after the trial, or $10.20 for 60 billable device-minutes. The
1,000-minute offer is temporary and one-time. Installation, execution and
cleanup contribute to device time; five minutes of gameplay is not necessarily
five billable minutes. There is no need for an unlimited monthly plan here.

AWS provides [Chrome and Safari web testing through a managed Appium endpoint](https://docs.aws.amazon.com/devicefarm/latest/developerguide/appium-endpoint-interaction.html).
The current guide supports tests driven from a local client during remote
access, so uploading the whole test suite is not the only path. This differs
from the older server-side-only description still present in the AWS FAQ.

The endpoint is returned as
`remoteAccessSession.endpoints.remoteDriverEndpoint`. Treat its URL as a
credential and exclude it from public reports. The installed AWS CLI was
2.34.64; its generated input schema did not expose the newer Appium-version
parameters documented online. Update/check SDK or CLI service-model support
before relying on those fields. No session was created to test the returned
endpoint. Do not guess an endpoint or pass unsupported parameters.

The [supported-command documentation](https://docs.aws.amazon.com/devicefarm/latest/developerguide/appium-endpoint-support.html)
lists Appium 2/3 and excludes several local-device capabilities and recording
start/stop commands. We have not verified trusted held multitouch or disabling
provider recording. Remote sessions have a documented 150-minute limit and
five-minute inactivity timeout. Add a much shorter explicit trial deadline and
always call stop-session in cleanup; retain its terminal status and actual
device minutes. Read the allowance again afterward.

### Network fixture requirement

The current benchmark assumes local client and health ports and an owned
WebSocket endpoint. A cloud phone cannot reach the Mac's `127.0.0.1`. For AWS,
prepare a dedicated HTTPS/WSS fixture with pinned client/server artifacts and
explicit endpoint configuration. Keep fixture controls private to the benchmark
controller. Verify release identity and actual WebSocket traffic from the phone,
as well as controller health checks. Hosting cost is separate from device time.

For Samsung's ADB path, first test whether the bridge supports routing to the
owned local fixture. If it does not, use the same dedicated remote fixture.
Either path needs exact route, source and workload evidence. Stop only the
resources created for that run, including after failures. No fixture has been
provisioned and no remote adapter has been implemented yet.

## What makes this a benchmark

Use the existing game recorder; a new FPS-overlay library is unnecessary.
The [measurement plan](performance/phone-fps-measurement.md) defines frame-time,
input, snapshot, workload and comparison evidence. Its minimum sequence is:

1. Prove compatibility and measurement coverage on one phone.
2. Record 30 seconds of warmup and five foreground minutes of a fixed combat
   workload, with complete raw metrics and actual admitted projectile witnesses.
3. Run three unchanged-build A/A pairs, then three alternating baseline/candidate
   A/B pairs on the same device configuration. Report session variation, p95/p99
   frame interval, stutters, input response and snapshot freshness.
4. Validate sustained behavior separately on an owned phone. Cloud allocation
   and streaming cannot establish battery or temperature behavior at home.

Render-loop FPS is `1000 * intervalCount / sum(frameIntervalMs)`. Preserve
hidden/menu/rejoin time, dropped samples and lifecycle events; do not average
instantaneous FPS or discard bad phases to improve a score. JavaScript frame
cadence is not proof that each frame reached the physical display.

The existing `?performance=collect` UI provides Start/Stop/Download, bounded
recoverable storage and checksummed raw exports. It does not yet provide the
automated fixture/source/input/device witnesses required by the comparison CLI.
Do not relabel manual exports as controlled comparisons or weaken the validator.

An emulator is useful for OS/browser functionality. A constrained desktop is
useful for frequent regression tests after real-phone calibration. Neither
reproduces the older phone's GPU; [Chrome documents the limitation](https://developer.chrome.com/docs/devtools/device-mode#limitations).
Keep profiling and screen streaming separate from timing where possible because
[screencasts affect frame rates](https://developer.chrome.com/docs/devtools/remote-debugging).

## Other options considered

BrowserStack fits the existing Playwright code more closely and lists Galaxy
M32/Android 11; Sauce Labs lists A51 devices with Appium web/multitouch support.
Their recurring real-device automation plans led to the cheaper Samsung/AWS
choice. Manual-testing prices are not automation-plan prices. No subscription
was selected or purchased. BrowserStack documents video disabling; that alone
does not establish zero measurement overhead.

A dedicated used Android becomes attractive for daily testing. At inspection,
[Galaxy A51 listings](https://swappa.com/buy/samsung-galaxy-a51) started at $92,
or $107 unlocked, before tax. It offers more control over power, temperature and
physical identity than a shared cloud phone, with no recurring device-service
fee. No hardware purchase was made.
