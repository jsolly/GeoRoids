# Sound design

All shipped samples are original GeoRoids synthesis from
`scripts/generate-sounds.ts`, covered by the repository's ISC license. They use
sine partials, rounded attacks, short decays, and the C-major pentatonic palette.
No third-party sample pack, external service, or runtime CDN is needed.
The previous Kenney samples have been replaced.

Regenerate on macOS from the checkout root with `npm run sounds:generate`.
The deterministic PCM generator uses the system `afconvert` to encode mono
48 kHz AAC at 96 kbps. An optional output path writes a WAV audition reel:
`npm run sounds:generate -- /tmp/georoids-palette.wav`.

## Cue inventory

| Action or event | Voice and musical role |
| --- | --- |
| Resource Tap ejection | Lower C4–G4–E4–C5 plucks with a small rounded pop |
| Material pickup | C5-root crystal instrument; three-note answers begin E5–G5–C6 |
| Laser core pickup | Brighter octave partial in the same pickup phrase |
| Orbital pickup | G4–C5 answering interval |
| Harpoon launch, latch, release | Low plucks, seated latch tone, descending release |
| Surveyor scan | C4–G4–D5 rising shimmer |
| Flight entry and respawn | C4–E4–G4–C5 welcoming phrase |
| Ship and orbital shots | Short G4 and C4 pulses, without pitch randomization |
| Hits | Rounded low impact with a soft C4 overtone |
| Asteroid destruction | Low body, quiet G3/E4 tail, low-pass dust |
| Asteroid split | Existing destruction layer plus quiet sine body and low-pass dust |
| Satellite and loot destruction | Shorter, lighter relatives of the asteroid impact |
| Ship destruction | Deeper and longer C/G body, without sharp noise |
| Local hull damage | Short low knock, only on a surviving damage event |
| Boost start and stop/depletion | Low ascending/descending two-note acknowledgements |
| Boost Coupling ignition | Rounded push with a rising C/G crystal tail |
| Furnace reward | E4–G4–C5 cadence for each rewarded pilot, including distant collaborators |
| Game over | G3–E3–C3 descending resolution, once per run |
| Ship selection, map, schematic and utility selection | Quiet crystal tick on actual open/close/change |
| Satellite equip | C4–G4 confirmation when stored hardware enters orbit |
| Local satellite orbit | Soft C4/C5 chime once per orbit, with silence between passes; HRTF movement follows orbital phase |
| Permanent disconnect | One quiet D4–G3 warning, never on each reconnect attempt |

## Coverage decisions

The audit traced firing, damage/death/respawn, asteroid destruction/splits,
resource extraction/collection, tools, boost, satellite inventory, furnace
rewards, and in-flight menus. Missing boost transitions, surviving hull damage,
coupling ignition, satellite equip, game-over and menu feedback now have cues.
Furnace delivery now has its own cadence rather than reusing orbital pickup.
A permanent connection failure sounds once until connection recovery. Local
shots, boost controls and predicted boundary death intentionally acknowledge
input immediately; their existing prediction rules remain unchanged. Rewards,
resource notes, surviving damage, equip and coupling ignition use authoritative
notifications or state changes. Duplicate/stale damage and loot-break events
cannot replay their cues; coupling ignition is an accepted ability event rather
than an inferred snapshot transition. Release confirms at the ship even when
the ignition itself is offscreen.

Automatic thrust, steering, regeneration, map pan/zoom, ordinary score/snapshot
updates, cooldown/recharge ticks, and repeated clicks on the equipped tool stay
silent. These continuous or repetitive actions should not compete with the
musical feedback. Changing the selected title-screen ship plays a crystal tick;
successfully entering a flight plays the welcoming phrase. Selecting the same
ship, title-screen typing, hover, and other settings remain silent;
Sound-off must not initialize the effect backend. Optional instrumental beds
live in `public/music/` and follow the Music checkbox instead: a title loop
on the start screen, a playfield loop after Enter Game, and an optional
danger loop while gameplay holds `pushMusicThreat()`. Pair every push with
`clearMusicThreat()` (`src/audio/musicThreat.ts`); counts nest. Iso Threat
(`danger-bed.ogg` / `danger-bed.mp3`) is the danger keeper; a missing or failed
decode still keeps Playfield Drift slightly louder and faster. Music off
silences every bed, including danger, without muting cues.
Leaving the playfield zeros the threat count. All beds stay quieter than
cues. Satellite break, respawn, scan, latch/release and
shockwave already had cues and now use the new family.

## Satellite orbit

Only the local pilot's orbiting satellite plays a soft C4/C5 chime once per
revolution (about every 2.3 seconds at the current speed). Each chime lasts
0.65 seconds, with a rounded attack, fading tail and complete silence between
passes. The authoritative orbit angle controls HRTF position and a subtle
±18-cent pitch movement during each chime. Two sine oscillators share the
game's existing context without per-frame node allocation, requests or decoding.
Stored, broken, loose and remote satellites remain silent. Muting, tab hiding,
loss of orbit and connection reset stop/disconnect both oscillators. Joining,
unmuting and reconnecting wait for the next pass without replaying missed chimes
or the equip cue.

## Resource orchestration

Extraction and collection share an activity clock and compatible notes, with
separate lower accompaniment and upper melody positions. They never steal one
another's melody steps. Each accepted event sounds immediately; simultaneous
pickups form a chord instead of queuing a delayed tune. Pickups cycle through
four composed three-note answers, with bounded register rather than endless
ascending pitch. After 1.4 seconds without an audible resource note the phrase
restarts. Laser cores share the melody with a brighter instrument.

The server emits `tapEjected` for each created canister before collection
notifications and snapshots. The client validates positions and deduplicates
by loot ID. Existing loot in join/reconnect snapshots does not play an ejection. World
messages arriving before the first accepted snapshot update state silently,
including events queued just before a pilot joins an active world.
Resetting the network session, muting, or hiding the tab clears the phrase and
stops its active notes. Muted, offscreen, unavailable, and voice-limited notes do
not advance the melody. No sound delays simulation, input, or collection.

## Playback

Samples retain their authored tuning. Resource notes use exact semitone ratios;
playback rate also shortens higher notes' tails. Only the split's quiet noise
texture varies in rate; its body tones stay tuned. The split uses sine tones
and low-pass noise instead of a sawtooth and high-pass crack.

World cues retain viewport culling and distance attenuation. Sound Effects off
stops active cues and prevents new ones. Music off stops looping beds without
muting cues. Each effect retains its configured
simultaneous-voice limit; finished voices release their resources. Resource
pickups allow eight overlapping voices, extraction four.

## Directional playback

All positioned samples, including nearby players' lasers and asteroid breaks,
use a separate HRTF panner per active voice. Screen right maps to audio right;
screen up maps to front, with the local ship at the listener origin. Turning the
ship does not rotate the soundfield: it remains aligned with the screen. The
satellite's chime source follows its authoritative orbit angle, including
front/back motion. Instantaneous events retain the direction of their origin
at playback; they do not follow the departing laser.

Howler panners are allocated before starting playback to avoid its spatial
plugin's pause/restart when inserting a new panner into an active voice. Each
play sets its own coordinates, including recentering local/interface cues on
reused voices. Native distance rolloff is disabled because the existing game
attenuation already controls volume. Viewport culling remains unchanged.

[Web Audio HRTF](https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/panningModel)
provides binaural directional cues, most apparent on headphones. The browser's
[PannerNode outputs stereo](https://developer.mozilla.org/en-US/docs/Web/API/PannerNode),
not discrete 5.1/7.1 or Atmos channels. Speakers and OS spatial-audio processing
use that browser output according to the user's device configuration. Mono
output retains the melody, distance gain, and orbit pitch/amplitude movement.

## Mobile audio lifecycle

Short effects use shared Web Audio rather than pools of HTML media elements.
The audio backend initializes only after an enabled user interaction. Entering
with Sound off does not create audio resources or request sound files. The
backend loads and decodes samples once for reuse; firing does not fetch or decode
another copy. Cues that occur before an asset is ready are skipped, not replayed
later in a burst. Audio failures must not block simulation or networking.

One realtime audio context serves sample effects, the orbit chime, looping
beds, and the synthesized split cue.
Muting sound effects stops active cue sources; hiding the tab or turning both
Sound Effects and Music off suspends audio work. Delayed loads or resumes
cannot undo a mute.
Tab visibility and mobile interruptions are lifecycle events rather than work
repeated by the simulation loop.

These choices follow [MDN's short-sample guidance](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)
and [shared-context recommendation](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext).
Decoded [buffers can be reused across inexpensive playback nodes](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode).
Mobile testing includes [interrupted context states](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state),
muted starts, repeated firing, enable/mute transitions, and returning from another
app. Desktop mobile emulation is not evidence of physical-phone frame pacing.
