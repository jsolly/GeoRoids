# Music beds

Instrumental title, playfield, and optional danger loops. Drop replacements
here using these filenames:

- `menu-bed.ogg` / `menu-bed.mp3` — title screen (Phosphor Lobby)
- `in-game-bed.ogg` / `in-game-bed.mp3` — after Enter Game (Playfield Drift)
- `danger-bed.ogg` / `danger-bed.mp3` — temporary in-game threat. Optional
  follow-up drop; the client ships the API without these files.

The client prefers Ogg when the browser can play it and uses MP3 on Safari.
Howler never requests an unsupported format, so a missing sibling does not
spam the console. Keep beds quiet under crystalline SFX.

## Threat API

Gameplay calls a refcounted stack so overlapping threats do not fight:

```ts
import { pushMusicThreat, clearMusicThreat } from '../audio/musicThreat';

pushMusicThreat();
// ...threat ends
clearMusicThreat();
```

Rules:

- Music on + in play + count > 0 → danger bed (crossfade). If
  `danger-bed.{ogg,mp3}` are missing or fail to decode, Playfield Drift stays
  up slightly louder and faster until the last clear.
- Last clear → normal in-game bed, not the title bed.
- Music checkbox off → silence, including danger. Sound Effects stay
  independent. The count is kept so turning Music back on while still in
  danger resumes the threat bed.
- Leaving the playfield zeros the count so the lobby cannot inherit a stale
  threat.

Current keepers are original Song Lab / Suno instrumentals:

- Phosphor Lobby (`a5931a6b`) → `menu-bed`
- Playfield Drift (`b63b4578`) → `in-game-bed`
- danger bed: not landed yet
