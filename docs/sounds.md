# Sound sources

New samples come from [Kenney's Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds),
version 1.0, released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
The supplied license is in `public/sounds/Kenney-License.txt`.

The table maps shipped AAC files to the original Ogg files. Conversion uses
macOS `afconvert -f m4af -d aac -b 96000`; no pitch variants are stored.
The existing `thrust.m4a` is retained. Asteroid splits also use the game's
original synthesized crack and descending tones.

| Shipped file in `public/sounds` | Kenney source in `Audio` |
| --- | --- |
| `ability-boost.m4a` | `thrusterFire_000.ogg` |
| `ability-pulse.m4a` | `lowFrequency_explosion_000.ogg` |
| `ability-ring.m4a` | `laserLarge_000.ogg` |
| `ability-shield.m4a` | `forceField_001.ogg` |
| `asteroid-explode.m4a` | `explosionCrunch_001.ogg` |
| `core-pickup.m4a` | `laserRetro_004.ogg` |
| `explode.m4a` | `explosionCrunch_000.ogg` |
| `fuel-pickup.m4a` | `forceField_004.ogg` |
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
Pitch preservation is disabled so changing the rate changes the audible pitch.
Thrust picks its pitch when the loop starts and keeps it while held. Volume
updates do not restart or retune a running loop. Split synthesis applies the
same range to its tone frequencies and noise playback rate.

World cues use the existing viewport and distance attenuation. Sound-off stops
all registered sample streams and prevents new cues. Pools bound simultaneous
voices; reusing a voice restarts its sample at the beginning.
