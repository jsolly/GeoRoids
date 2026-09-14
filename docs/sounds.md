# Sound sources

New samples come from [Kenney's Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds),
version 1.0, released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
The supplied license is in `public/sounds/Kenney-License.txt`.

The table maps shipped AAC files to the original Ogg files. Conversion uses
macOS `afconvert -f m4af -d aac -b 96000`; no pitch variants are stored.
Automatic thrust is silent. Asteroid splits use the game's original synthesized
crack and descending tones.

| Shipped file in `public/sounds` | Kenney source in `Audio` |
| --- | --- |
| `survey-scan.m4a` | `thrusterFire_000.ogg` |
| `ability-shield.m4a` | `forceField_001.ogg` |
| `asteroid-explode.m4a` | `explosionCrunch_001.ogg` |
| `core-pickup.m4a` | `laserRetro_004.ogg` |
| `explode.m4a` | `explosionCrunch_000.ogg` |
| `harpoon-latch.m4a` | `impactMetal_000.ogg` |
| `harpoon-launch.m4a` | `doorOpen_000.ogg` |
| `harpoon-release.m4a` | `doorClose_000.ogg` |
| `hit.m4a` | `impactMetal_002.ogg` |
| `laser.m4a` | `laserSmall_000.ogg` |
| `loot-explode.m4a` | `explosionCrunch_004.ogg` |
| `loot-pickup.m4a` | `forceField_003.ogg` |
| `orbital-fire.m4a` | `laserRetro_000.ogg` |
| `orbital-pickup.m4a` | `forceField_000.ogg` |
| `respawn.m4a` | `forceField_002.ogg` |
| `satellite-explode.m4a` | `explosionCrunch_002.ogg` |

## Playback

Every sample trigger uses a fresh random playback rate in the range 0.9–1.1.
Web Audio playback rate changes the audible pitch as well as duration.
Split synthesis applies the same range to its tone frequencies and noise
playback rate.

World cues retain viewport culling and distance attenuation. Sound-off stops
active effects and prevents new cues. Each effect retains its configured
simultaneous-voice limit; finished voices release their resources.

## Mobile audio lifecycle

Short effects use shared Web Audio rather than pools of HTML media elements.
The audio backend initializes only after an enabled user interaction. Entering
with Sound off does not create audio resources or request sound files. The
backend loads and decodes samples once for reuse; firing does not fetch or decode
another copy. Cues that occur before an asset is ready are skipped, not replayed
later in a burst. Audio failures must not block simulation or networking.

One realtime audio context serves sample effects and the synthesized split cue.
Muting stops active sources and suspends audio work; delayed loads or resumes
cannot undo a mute.
Tab visibility and mobile interruptions are lifecycle events rather than work
repeated by the simulation loop.

These choices follow [MDN's short-sample guidance](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)
and [shared-context recommendation](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext).
Decoded [buffers can be reused across inexpensive playback nodes](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode).
Mobile testing includes [interrupted context states](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state),
muted starts, repeated firing, enable/mute transitions, and returning from another
app. Desktop mobile emulation is not evidence of physical-phone frame pacing.
