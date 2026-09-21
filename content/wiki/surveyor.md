---
title: Surveyor
category: Ships
summary: A nimble scout with shared mineral scans, mobile probe beacons, and furnace construction.
order: 30
related:
  - content/wiki/controls.md
  - content/wiki/satellites.md
  - content/wiki/asteroids.md
  - content/wiki/hauler.md
media:
  - heading: Mineral scan
    demo: surveyor
---

## Mineral scan

Surveyor is the winged scout with a dish on the nose. It is the smaller hull
next to Hauler's barge. It turns more quickly than
Hauler and cruises automatically at the same speed. Press Shift or tap Boost for
a stronger burst than Hauler's boost; tap or press again to return to cruise.
The shared [boost tank](/wiki/#controls) drains during use and refills while inactive.
Running it empty stops boost. Activate it again as soon as some charge returns;
boosting interrupts the refill.
Choose Mineral Scan in the ship schematic, then press E or
tap Scan to run a range-limited mineral scan on every teammate's radar for a
limited time. The range is centered on the active Surveyor. Teammates see the
shared classification when the rock is inside their own local radar. All minerals keep the same rock silhouette: pale cyan with a crack for ice,
gold with parallel seams for metal, and orange with chipped details for rubble. Once a rock is identified, its
classification remains with that rock; unscanned rocks keep a small slate rock outline.
While the scan is active, a thin cyan radar sweep pulses from the hull to the
edge of the viewport. The sweep is a visual cue and does not expand the scan
range.
While Mineral Scan is active, spiders within its range flee from the Surveyor
and stop biting, including spiders chasing a teammate. They can resume hunting
when the scan ends or they leave its range. Survey Probes do not repel spiders.
The ability has a cooldown and costs no resource.

Surveyor also reveals a 650-unit radius around its hull for the shared
exploration chart. Those cells stay revealed for the match, so the crew can
return to a route or furnace that any Surveyor has charted.

Scan does not push rocks or damage ships. A qualifying scan tags the asteroid
with the Surveyor's ID. If a Hauler later delivers that rock to a furnace, the
Hauler and every Surveyor recorded on the tag receive the same delivery points.
The mineral classification stays with the rock until it is delivered or
removed, even after the active scan ends. The tag is also retained for the
delivery reward.

## Survey probe

Open the ship schematic with V or the Schematic button on desktop, or a long
press on your hull on touch, then select Survey Probe. Press E or tap Probe to
fire along your heading. The first
asteroid or spider in range receives a small beacon on its surface. Aim at an
unoccupied host; a host already carrying a probe blocks the shot. Walls also block it.
A miss does not consume the cooldown or replace an existing beacon.

The probe moves and rotates with its host. It identifies a host asteroid immediately,
then periodically identifies nearby asteroid materials for everyone. A thin
expanding ring shows the scan radius, and a pulsing minimap marker lets Haulers
follow the host through the field. Discovered materials remain identified after
the beacon stops. Probe discoveries also record the launching Surveyor for
furnace delivery credit, just like Mineral Scan.

Attach a probe to a guarding spider, then retreat and let it return to its nest.
The beacon scans along its route and identifies nearby guarded asteroid resources
when it reaches home. Spider probes share the same battery, durability, and
per-Surveyor limit as asteroid probes.

A green health bar above the probe shows its durability. Any pilot can shoot
the exposed beacon off the surface without first destroying its host. Aim at
the small diamond; a shot that hits the host first still damages the host.
Destroying or delivering the host removes its probe too.

The battery expires after a limited time. An amber warning pulse signals that
it is nearly empty. Each Surveyor can keep a limited number of probes active;
a successful attachment beyond that limit replaces their oldest probe.
Switching tools does not remove existing beacons. Probes are temporary equipment
and do not survive a server restart.

## Build furnace

Equip Build Furnace in the ship schematic, then press E or tap Build to place a
furnace at your ship's position. Building costs no resource and shares Mineral
Scan's cooldown. A failed placement uses neither a slot nor a cooldown; the HUD
explains why it failed. Move clear of other furnaces, spider nests,
and the world edge before trying again. A nest whose
home would sit inside the new furnace's spider occupancy is an illegal site;
that miss does not wipe the nest. Standing furnaces still scare spiders that
enter that occupancy.

Each pilot can keep three furnaces at once. Fixed map furnaces do not count
against that limit. Placing a fourth removes your oldest built furnace first,
then raises the new hearth; a HUD notice explains when a prior site yields.
The schematic shows how many you have built. Your furnaces survive death,
changing ships, reconnecting with the same saved pilot credential, and server
restarts. They reset with the world at the next monthly season. Clearing your
browser's saved pilot credential creates a different pilot; it does not reclaim
old furnaces.

Everyone can use a built furnace. It accepts towed and boosted ore and consumes towed spiders, awards the
usual delivery credit, guides nearby boosted cargo, provides the usual spider
safe area, and can serve as a nearby respawn site. Discovered furnaces appear on
the local radar and universe map. Building itself awards no delivery points.
Furnaces cannot be moved or dismantled by hand. The only way one of yours
comes down is when a later placement needs the slot. Mapping and mining
around a furnace cannot close the delivery site.

## Satellite inventory

Loose satellites enter your ship inventory when collected. Open the schematic
with V or the Schematic button on desktop, or press and hold your hull on
touch, then choose Equip. One satellite
orbits at a time, identifying nearby asteroids until its health runs out.
Health drains with time and damage; stored satellites preserve their health. This uses a separate equipment
slot and leaves your core ability available.
