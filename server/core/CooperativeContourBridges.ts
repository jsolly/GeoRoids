import { SHIP } from '../../shared/constants/gameplay';
import { CONTOUR_BRIDGE } from '../../shared/contourBridge';
import { contourLockVelocity } from '../../shared/contourLock';
import { sampleGradient, sampleHeight } from '../../shared/heightfield';
import { getTerrainField } from '../../shared/terrainField';
import { WORLD } from '../../shared/world';
import type { ContourBridge, ContourLockState, Position } from '../../shared-types';
import type { EntityManager, GameEntity } from './EntityManager';
import type { PlayerMotionService } from './PlayerMotionService';

type Entry = { bridge: ContourBridge; created: number; expires: number; used: Set<string> };
interface ContourBridgeInputs {
  readonly actors: Pick<EntityManager, 'getAllEntities'>;
  readonly motion: Pick<PlayerMotionService, 'handoffActor' | 'finishContourBridge'>;
}

export class CooperativeContourBridges {
  private readonly entries = new Map<string, Entry>();
  private nextId = 0;

  constructor(private readonly inputs: ContourBridgeInputs) {}

  advance(frame: number, now: number): void {
    this.expire(frame);
    for (const actor of this.inputs.actors.getAllEntities()) {
      if (
        actor.health <= 0 ||
        actor.exploding ||
        actor.overlayHold === true ||
        actor.furnaceTransit
      ) {
        delete actor.contourTransit;
        continue;
      }
      if (!actor.contourTransit) {
        const bridge = this.catch(actor, frame);
        if (!bridge) {
          continue;
        }
        this.inputs.motion.handoffActor(actor.id, now);
        actor.contourTransit = {
          from: { ...actor.position },
          to: { ...bridge.to },
          target: { ...bridge.target },
          frame: 0,
        };
      }
      const transit = actor.contourTransit;
      const t = Math.min(1, ++transit.frame / CONTOUR_BRIDGE.transitFrames);
      actor.position = {
        x: transit.from.x + (transit.to.x - transit.from.x) * t,
        y: transit.from.y + (transit.to.y - transit.from.y) * t,
      };
      if (t < 1) {
        continue;
      }
      actor.contourLock = transit.target;
      actor.contourDraftFrames = CONTOUR_BRIDGE.draftFrames;
      const velocity = contourLockVelocity(
        actor.position,
        transit.target,
        SHIP.MAX_VELOCITY * CONTOUR_BRIDGE.draftMultiplier
      );
      actor.velocity = velocity ?? { x: 0, y: 0 };
      actor.angle = Math.atan2(-actor.velocity.y, actor.velocity.x);
      actor.thrusting = true;
      delete actor.contourTransit;
      this.inputs.motion.finishContourBridge(actor.id, now);
    }
  }

  noteHop(
    ownerId: string,
    from: Position,
    source: ContourLockState,
    target: ContourLockState,
    count: number,
    frame: number
  ): void {
    const to = { ...from };
    const field = getTerrainField();
    for (let step = 0; step < 8; step++) {
      const gradient = sampleGradient(field, to.x, to.y, 0.25);
      const squared = gradient.x ** 2 + gradient.y ** 2;
      if (squared < 1e-16) {
        return;
      }
      const correction = (target.height - sampleHeight(field, to.x, to.y)) / squared;
      to.x += gradient.x * correction;
      to.y += gradient.y * correction;
    }
    if (
      Math.hypot(to.x - from.x, to.y - from.y) > 80 ||
      Math.hypot(to.x, to.y) > WORLD.radius - 100
    ) {
      return;
    }
    const id = `contour-bridge:${++this.nextId}`;
    if (this.entries.size >= CONTOUR_BRIDGE.maximum) {
      const oldest = this.entries.keys().next().value;
      if (oldest != null && oldest !== '') {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(id, {
      bridge: {
        id,
        ownerId,
        from: { ...from },
        to,
        source: { ...source },
        target: { ...target },
        charged: count === CONTOUR_BRIDGE.hopLimit,
        framesLeft: CONTOUR_BRIDGE.lifetimeFrames,
      },
      created: frame,
      expires: frame + CONTOUR_BRIDGE.lifetimeFrames,
      used: new Set([ownerId]),
    });
  }

  catch(actor: GameEntity, frame: number): ContourBridge | undefined {
    if (
      !actor.contourLock ||
      actor.health <= 0 ||
      actor.exploding ||
      actor.overlayHold === true ||
      actor.furnaceTransit ||
      actor.contourTransit
    ) {
      return;
    }
    for (const { bridge, used, created, expires } of this.entries.values()) {
      if (
        !bridge.charged ||
        expires <= frame ||
        used.has(actor.id) ||
        actor.contourLock.height !== bridge.source.height ||
        actor.contourLock.direction !== bridge.source.direction ||
        Math.hypot(actor.position.x - bridge.from.x, actor.position.y - bridge.from.y) >
          CONTOUR_BRIDGE.catchRadius
      ) {
        continue;
      }
      used.add(actor.id);
      const entry = this.entries.get(bridge.id);
      if (entry) {
        entry.expires = Math.min(
          created + CONTOUR_BRIDGE.maximumLifetimeFrames,
          frame + CONTOUR_BRIDGE.lifetimeFrames
        );
      }
      return bridge;
    }
    return undefined;
  }

  private expire(frame: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expires <= frame) {
        this.entries.delete(id);
      }
    }
  }

  snapshot(frame: number): ContourBridge[] {
    this.expire(frame);
    return [...this.entries.values()].map(({ bridge, expires }) => ({
      ...bridge,
      from: { ...bridge.from },
      to: { ...bridge.to },
      source: { ...bridge.source },
      target: { ...bridge.target },
      framesLeft: expires - frame,
    }));
  }
  clear(): void {
    this.entries.clear();
  }
}
