# GeoRoids art canon

The source pack was recovered from Game Director on September 7, 2026. Its ZIP SHA-256 is `33ba9fd279504d8862fadb3bc7b5add13a4abf8f2a4fc32ea2a36dfd47c01bb2`. Review screenshots and v1 drafts are historical references; the v2 contact and play-scale PNGs are the locked ship references.

Current direction lives in `style-guide.md`, `palette-ships-factions.md`, `ships-and-factions.md`, and `eo-satellites/roster-and-briefs.md`. The existing repository's ship implementation notes take precedence over the older source pack's contradictory optional-Hook and temporary-saucer language. There are exactly five player kits.

`src/entities/ship/hullOutlines.ts` traces the recovered contact sheet. The five `ships-v2/*.svg` files and the runtime use those same contours. This corrects the former approximations of the tail fins, Warden notch, Skirmisher aft fork, and Quake rear stem.

Wave 1 passed on production release `5139af1` on September 7, including a real WebSocket reconnect and more than five minutes of simultaneous two-pilot play. Implementation remains owned by Codex; the Grok Developer bot is idle until September 9.

`ACCEPTANCE-AND-GAPS.md` records what the source ZIP contained and what was absent when recovered; it is a provenance record, not a substitute for the implemented assets and tests.

The six EO SVGs and `eo-satellites/runtime-contact.png` derive from `src/entities/satellite/eoOutlines.ts`. The three mineral SVGs and `personality-roids/runtime-contact.png` derive from the same contour/facet data used by the Canvas renderer. `ships-v2/runtime-contact.png` shows the corrected ship contours at 32 and 48 pixels.

Recovered `reviews/`, v1 ship sheets, UFO files and the original gauntlet log remain historical evidence; their older acceptance status does not describe the current release. `ACCEPTANCE-AND-GAPS.md` retains the source-pack inventory; Markdown spacing and fence labels were normalized on import. The original ZIP retains the exact source bytes. Code verification and live acceptance are recorded with the integrating pull request.
