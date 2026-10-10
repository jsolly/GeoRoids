---
title: HUD and the shared world
category: Systems
summary: Read cargo, health, the local radar, the universe map, and scores. Understand what
  to do if the connection drops.
order: 150
related:
  - content/wiki/field-manual.md
  - content/wiki/controls.md
  - content/wiki/combat-survival.md
  - content/wiki/teamwork.md
media: []
---

## Read the HUD

Gold crates fill the cargo bay inside local and crew hulls as they collect points; a full hold pulses with Cargo Full, and [offloading](/wiki/#loot-growth) shows a stream, countdown and completion flash. The HUD shows your bank, cargo capacity, kit, shared settlement progress and resource requirements, and the crew leaderboard, ranked by bank (top ten on desktop, top three on touch, so you may not appear). The settlement percentage averages its five requirements. A thin health bar appears above a damaged ship, and the Contour Lock button shows whether a contour is available or locked. On mobile, two compact lines show bank and cargo, then kit and settlement level progress; the detailed points and resource requirements remain in the desktop HUD. On touch, the ability button names your tool and a ring shows its cooldown; desktop has no cooldown indicator. One line at the top briefly shows satellite pickups, Delivery +N or Team delivery +N each, and Scout build results; no message appears on death.

## Travel prompt

Inside a lit furnace's visible footprint, the prompt offers travel; at Town Square it says Enter and opens a choice of Store or Fast Travel. See [furnace travel and store](/wiki/#controls) for controls and boarding rules.

## Radar and universe map

The minimap shows nearby space; M or Map opens the full shared chart. Both keep north at the top, matching the viewport and furnace destination map. Your ship marker turns to show its heading. Pinch the full chart to zoom and drag to pan; desktop also supports the mouse wheel and +/− keys. The north arrow and legend sit inside the chart, and Locate restores the nearby ship view. The minimap shows furnaces once explored and pins off-radar crew to its rim, while the full chart always shows every lit furnace and foundation; their names appear on the chart only after you zoom in close, and only lit furnaces show fire trails. Explored ground has a pale blue tint; dark fog hides uncharted rocks and loot.

## Ricochet Court

Discovered spider nests are red while any guard survives and turn dark gray when the last guard dies. A cleared marker stays until its original resource moves or disappears.

The cyan open-corner marker northeast of Town Square is always visible on both maps. See [bank-shot duels](/wiki/#combat-survival) before entering.

## Probe beacons

A pulsing cyan radar marker identifies a live Survey Probe. Follow its moving host to find scanned minerals; a low battery makes the beacon itself flicker pale yellow in the world while the radar marker stays steady.

## Sound and haptics

The title screen has separate Sound Effects, Music, and Haptics settings, saved in this browser; Sound Effects start off and Music starts on. They live only on the title screen. Haptics appears only on touch devices whose browser can vibrate, so it is hidden on desktop and iPhone. If sound stops, tap the game to let automatic audio recovery retry, and check your device volume and output.

## Connection interruptions

The game retries about fifteen seconds, then returns to the title screen; choose Enter Game. A brief interruption restores your ship, and carrying cargo preserves your field position even after a longer absence. Progress is tied to this browser's saved pilot, so a private window, cleared site data, blocked storage, or another device starts a new pilot. A crash or restart can undo about the last second of play, with no warning beyond the Reconnecting banner.

Published client updates refresh open tabs automatically after two checks about thirty seconds apart, with no prompt; a per-version guard prevents a cached old client from repeatedly reloading. Right after a release an old tab may show a generic connection error until it refreshes; reload if it does not.

## Can't join

A generic connection-failed banner can mean your nickname is in use by an online pilot (try another), the server is full, or your tab is outdated (reload). An "unexpected error" notice during play also means reload.

## Diagnostics

Visit `/debug` for player and page session IDs, frame rate, and connection health. Logging defaults to Info; add `?log-level=debug`, `info`, or `warn` to change it for that visit. Use Copy Diagnostics when reporting trouble, including silent audio.

## Graphics option

Try the [experimental WebGL version](https://www.georoids.com/?renderer=webgl2) to compare graphics performance on your device. It uses the same scene and controls and falls back automatically if the renderer is unavailable. Reload the [standard version](https://www.georoids.com/) to return to the default renderer.
