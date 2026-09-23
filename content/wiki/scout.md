---
title: Scout
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
    demo: scout
---

Scout starts with **Mineral Scan**. **Survey Probe** must be found as a rare
equipment drop, usually in a spider nest. Its inventory card stays locked until
collected. Owned tools survive ordinary deaths, reconnects, and server restarts. Losing your last life clears your inventory.

## Mineral scan

Scout is the winged scout with a dish on the nose. It is the smaller hull
next to Hauler's barge. It turns more quickly than
Hauler and cruises automatically at the same speed. Press Shift or tap Boost for
a stronger burst than Hauler's boost; tap or press again to return to cruise.
The shared [boost tank](/wiki/#controls) drains during use and refills while inactive.
Running it empty stops boost. Activate it again as soon as some charge returns;
boosting interrupts the refill.
Choose Mineral Scan in the ship schematic, then press E or
tap Scan to run a range-limited mineral scan on every teammate's radar for a
limited time. The range is centered on the active Scout. Teammates see the
shared classification when the rock is inside their own local radar. All minerals keep the same rock silhouette: pale cyan with a crack for ice,
gold with parallel seams for metal, and orange with chipped details for rubble. Once a rock is identified, its
classification remains with that rock; unscanned rocks keep a small slate rock outline.
While the scan is active, a thin cyan radar sweep pulses from the hull to the
edge of the viewport. The sweep is a visual cue and does not expand the scan
range.
While Mineral Scan is active, spiders within its range flee from the Scout
and stop biting, including spiders chasing a teammate. They can resume hunting
when the scan ends or they leave its range. Survey Probes do not repel spiders.
The ability has a cooldown and costs no resource.

Scout also reveals a 650-unit radius around its hull for the shared
exploration chart. Those cells stay revealed for the match, so the crew can
return to a route or furnace that any Scout has charted.

Scan does not push rocks or damage ships. A qualifying scan tags the asteroid
with the Scout's ID. If a Hauler later delivers that rock to a furnace, the
Hauler and every Scout recorded on the tag receive that delivery. A pilot
who has built streets receives a higher personal payout; everyone else receives
the base reward.
The mineral classification stays with the rock until it is delivered or
removed, even after the active scan ends. The tag is also retained for the
delivery reward.

## Survey probe

Open the ship view with V or the Inventory button, then select Survey Probe. Press E or tap Probe to
fire along your heading. The first
asteroid or spider in range receives a small beacon on its surface. Aim at an
unoccupied host; a host already carrying a probe blocks the shot. Walls also block it.
A miss does not consume the cooldown or replace an existing beacon.

The probe moves and rotates with its host. It identifies a host asteroid immediately,
then periodically identifies nearby asteroid materials for everyone. A thin
expanding ring shows the scan radius, and a pulsing minimap marker lets Haulers
follow the host through the field. Discovered materials remain identified after
the beacon stops. Probe discoveries also record the launching Scout for
furnace delivery credit, just like Mineral Scan.

Attach a probe to a guarding spider, then retreat and let it return to its nest.
The beacon scans along its route and identifies nearby guarded asteroid resources
when it reaches home. Spider probes share the same battery, durability, and
per-Scout limit as asteroid probes.

A green health bar above the probe shows its durability. Any pilot can shoot
the exposed beacon off the surface without first destroying its host. Aim at
the small diamond; a shot that hits the host first still damages the host.
Destroying or delivering the host removes its probe too.

The battery expires after a limited time. An amber warning pulse signals that
it is nearly empty. Each Scout can keep a limited number of probes active;
a successful attachment beyond that limit replaces their oldest probe.
Switching tools does not remove existing beacons. Probes are temporary equipment
and do not survive a server restart.

## Build

Near a dark street foundation, E and the ability button become Build instead of
Mineral Scan or Survey Probe. Stand inside the grate and press E or tap Build.
The action spends your own score to light that street furnace, and the furnace
takes your name. It does not place a hearth at an arbitrary position. The inward
lot on that road must already be burning, and your score must cover the lot.
Each street you build raises your own later furnace deliveries. The same score
buys an extra life at the Town Square store. The bonus stays with the pilot who
paid, so a later nickname change leaves both the furnace name and the bonus
where they were. Other pilots keep the base reward. Deliveries still pay the
Hauler and each recorded Scout personally. A failed build spends neither
score nor cooldown; the HUD explains why it failed. You can build during a chase
even while a tool is cooling down. Lighting the furnace immediately breaks
nearby hunts and sends the living spiders fleeing. Nest-covered foundations
are valid; guards whose home is covered become roaming spiders.
While Build is offered, scan and probe stay unavailable until you leave the
street approach.

Town Square starts lit at the map center. Street lots are spread unevenly through
three farther bands, and each farther band costs more of the builder's score.
The pipeline stays hidden until that lot is burning. A lit street shows a fire
trail that turns at right angles, like city blocks, through each inward grate on its parent chain
and ends at Town Square. In the playfield, pipes meet each furnace's outer
circle, leaving its flame and grate unobstructed. Built streets keep
the builder's name and survive death, changing ships, reconnecting, and server
restarts. They stay until the expedition is reset.

Everyone can use a built furnace. It accepts towed and boosted ore and consumes
towed spiders, awards the usual delivery credit, guides nearby boosted cargo,
provides the usual spider safe area, and can serve as a nearby respawn site.
Dark foundations stay marked on the universe map and, when they are inside the
local radar, on the minimap. A lit hearth appears on the local radar after the
crew reveals its area. Building itself awards no delivery points. Furnaces
cannot be moved or dismantled by hand. Mapping and mining around a furnace
cannot close the delivery site.

## Satellite inventory

Loose satellites enter your ship inventory when collected. Collecting one shows
a brief label above the ship that says the equipment is in your inventory and
to open Inventory, then fades. Open the ship view
with V or the Inventory button, then choose Equip. One satellite
orbits at a time, identifying nearby asteroids until its health runs out.
Health drains with time and damage; stored satellites preserve their health. This uses a separate equipment
slot and leaves your core ability available.
