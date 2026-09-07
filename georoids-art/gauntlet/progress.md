# GeoRoids Gauntlet — progress

**Goal:** Live duo feels solid enough that strategy (ships / factions / env) is the fun, not fighting the sim.

**Bar (John 2026-09-05):** Live duo 5-min play with **zero** empty-canvas, freeze-stick, or bad-death. Art polish after.

**Mode:** plan→implementation (stability wave first)

## Wave 1 — Stability (Dev/QA; critic = Pilots duo smoke)

Must-clear for bar:

- [ ] `6hR7XChqr2wV5QJ2` empty canvas vs dense minimap (P1)
- [ ] `6hR6f9wfM9x9r8wR` ship freezes on wall/asteroid collision (P1)
- [ ] `6hR6gc4HMq5qp7X2` tick/lifecycle stalls (P1)
- [ ] `6hR6hm3XPpJwrpvR` game clock + tick audit (P1)
- [ ] `6hR7Vrg9jC2GG9qR` boundary HUD snap (P2)
- [ ] `6hR7XChg9qwRfv72` boundary kill → GO / no respawn (P2)
- [ ] `6hR6hFf54Gg4x6GR` game-over stuck / killed by unknown (P2)

Also watch (not bar-blockers unless they break the 5-min):

- laser ghosts `6hR6fC339Hq4frHR`
- stuck invuln / ghost lifecycle `6hR6fC2qMg5gCmcR`
- Chrome Aw Snap soak `6hR7gXh6JcPHXrc2`

**Critic pass:** Pilots A+B live duo ≥5 min on <www.georoids.com>. PASS only if none of the three bar failures appear.

## Wave 2 — Art locks (Game Director; after Wave 1 bar)

- [ ] Silhouette v2 lock (John)
- [ ] EO satellite sprites (Researchy briefs → art pack → Dev)
- [ ] Personality roid language (ice/metal/rubble)
- Soft factions marks: already steered (#465)

## Wave 3 — Features (after feel)

- Mobile cross-play, collab split / shockwaves / fuel / destroy-drop, remove SP, etc.

## Status

- Charter opened: 2026-09-05 ~10:36pm ET
- Critic: not run yet
- Status: **in progress — Wave 1**

### Update 2026-09-05 ~10:38pm ET

- Dev ack Wave 1; art/features held
- #467 boundary merged + Railway live; www still #449 (Vercel Hobby promote block)
- #469 empty-canvas rebase after #467; blocked on www catch-up
- Freeze/tick/clock + game-over stuck: auditing next
- Critic duo: wait for Dev “ready”

### Update 2026-09-05 ~10:38pm ET (2)

- #469 empty-canvas merged (`9423d3bc`)
- #467 Railway live; www still Hobby-lag
- Freeze/tick: cloud agent `bc-c88217e5`
- #422 game-over rebasing
- Critic: still waiting www has both client halves

### Update 2026-09-05 ~10:40pm ET

- Researchy EO briefs landed → locked 6-bird Wave 2 roster (L7, Terra, Aqua, GOES-16, ENVISAT, WV-3)
- Briefs at `eo-satellites/roster-and-briefs.md`
- Sprites still held until Wave 1 bar

### Update 2026-09-05 ~10:42pm ET

- #467 preview → www promote in flight (boundary)
- #469 empty-canvas: merged but www Hobby-blocked for that client
- Freeze/tick `bc-c88217e5` still running; #422 rebasing
- Critic still waiting

### Update 2026-09-05 ~10:43pm ET

- Silhouette v2 LOCKED by John — Wave 2 art item cleared for bake prep

### Charter update 2026-09-05 ~10:44pm ET

John locked **two waves**:

- **Wave 1** (floor): live duo ≥5 min, zero empty-canvas / freeze-stick / bad-death
- **Wave 2** (feel+art): Asteroids clarity + Geometry Wars juice; silhouette bake (v2 locked), EO 6-bird pack, personality roids

### Update 2026-09-05 ~10:49pm ET

- #470 freeze/tick merged + Railway SUCCESS — QA Ready no-stick smoke
- www still missing #467/#469 client (Hobby/promote)
- Critic duo still blocked on www

### Update 2026-09-05 ~10:59pm ET

- Local Vite→Railway interim smoke: FAIL overall (Aw Snap, GO naming, freeze-stick unclear)
- www promote deferred (Hobby) — duo critic tomorrow
- Wave 1 status: **not met**

### Update 2026-09-05 ~11:05pm ET

- www LIVE `827b13d` — Pilots A+B Wave 1 duo ≥5 min critic in flight

### Update 2026-09-05 ~11:12pm ET

- Pilot B Wave 1 PASS on www
- Standing by A + QA close before calling bar / merging #468 #465

### Update 2026-09-05 ~11:12pm ET — WAVE 1 PASS

- QA: Wave 1 PASS www `827b13d` — B duo ≥5m with A; ZERO list clean
- Status: **bar met**
- Next: Wave 2 (feel juice + EO/personality art; merge #468/#465)
