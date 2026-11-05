import type { BeltRecoveryWarning } from '../../shared/asteroidBelt';
import { WORLD_BOUNDARY } from '../../shared/boundary';
import { COOPERATIVE, QUEEN_COMBAT } from '../../shared/cooperativeRules';
import { cargoCapacity } from '../../shared/economy';
import { explorationCellAt, isCellExplored } from '../../shared/exploration';
import { sacPosition } from '../../shared/frontier';
import type { FurnaceField } from '../../shared/furnaceField';
import { CIVIC_LOTS, pipeHopToParent, pipeToTownSquare, TOWN_HEARTH } from '../../shared/furnaces';
import { planFurnaceRoute } from '../../shared/furnaceTravel';
import { isAsteroidLit } from '../../shared/glowtoy';
import type { Heightfield } from '../../shared/heightfield';
import { COURT_REFLECTORS } from '../../shared/ricochetCourt';
import { ROLY_POLY } from '../../shared/rolyPoly';
import { SHIP_ABILITY } from '../../shared/shipKits';
import { probePosition, SURVEY_PROBE } from '../../shared/surveyProbe';
import { spiderHitRadius } from '../../shared/terrainSpider';
import { nearbyRouteWaypoints } from '../../shared/travelRoutes';
import type {
  AsteroidProbe,
  CampaignSnapshot,
  ContourBridge,
  ExplorationTile,
  LootData,
  MapAsset,
  Position,
  RolyPolyState,
  SpiderFieldState,
} from '../../shared-types';
import { PALETTE } from '../constants';
import type { LootField } from '../entities/loot/LootField';
import type { Player } from '../entities/player/Player';
import type { Roid } from '../entities/roid/Roid';
import type { SatellitePickup } from '../entities/satellitePickup/SatellitePickup';
import { laserBoltColor } from '../utils/colorUtils';
import { formatPoints } from '../utils/formatPoints';
import type { DrawingContext } from './drawingContext';
import { addResourceMapPath, asteroidMapInk } from './hud/resourceMapMark';
import type { PlayfieldSize } from './playfieldCamera';
import { SimpleScanTerrain } from './simpleScanTerrain';

export interface SimpleScanView {
  viewport: Readonly<PlayfieldSize>;
  viewer: Readonly<Position>;
  /** Includes the current eased zoom exactly once. */
  worldScale: number;
  zoom: number;
  now: number;
  serverNow: number;
}

export interface SimpleScanScene {
  localPlayer: Player;
  players: readonly Player[];
  roids: readonly Roid[];
  loot: readonly LootData[];
  lootBlast: ReturnType<LootField['getBlast']>;
  pickups: readonly SatellitePickup[];
  spiders: Readonly<SpiderFieldState>;
  recovery: readonly BeltRecoveryWarning[];
  rolyPolys: readonly RolyPolyState[];
  bridges: readonly ContourBridge[];
  remains: readonly MapAsset[];
  campaign: CampaignSnapshot | undefined;
  terrain: Heightfield;
  furnaces: FurnaceField;
  exploration: readonly ExplorationTile[];
}

/** Paints live state into a caller-owned screen-sized surface, without manager globals. */
export class SimpleScanRenderer {
  private readonly terrain = new SimpleScanTerrain();

  reset(): void {
    this.terrain.reset();
  }

  draw(
    ctx: DrawingContext & Pick<CanvasRenderingContext2D, 'globalCompositeOperation'>,
    view: SimpleScanView,
    scene: SimpleScanScene
  ) {
    ctx.save();
    try {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.fillStyle = PALETTE.BG;
      ctx.fillRect(0, 0, view.viewport.width, view.viewport.height);
      const terrain = this.terrain.draw(
        ctx,
        scene.terrain,
        view.viewer,
        view.viewport,
        view.worldScale
      );
      const frame = new ScanFrame(ctx, view, scene);
      frame.draw();
      return {
        ...terrain,
        ...frame.counts,
        geometrySegments: terrain.terrainSegments + frame.geometrySegments,
      };
    } finally {
      ctx.restore();
    }
  }
}

class ScanFrame {
  readonly counts = {
    visibleAsteroids: 0,
    visibleSpiders: 0,
    visibleMeteors: 0,
    visibleShots: 0,
    visibleLoot: 0,
    primitivePaths: 0,
    glyphPaths: 0,
  };
  geometrySegments = 0;
  private readonly targets = new Map<string, Position>();

  constructor(
    private readonly ctx: DrawingContext,
    private readonly view: SimpleScanView,
    private readonly scene: SimpleScanScene
  ) {}

  private at(position: Readonly<Position>): Position {
    return {
      x: (position.x - this.view.viewer.x) * this.view.worldScale + this.view.viewport.width / 2,
      y: (position.y - this.view.viewer.y) * this.view.worldScale + this.view.viewport.height / 2,
    };
  }

  private visible(at: Position, radius = 8): boolean {
    return (
      Number.isFinite(at.x) &&
      Number.isFinite(at.y) &&
      at.x + radius >= 0 &&
      at.y + radius >= 0 &&
      at.x - radius <= this.view.viewport.width &&
      at.y - radius <= this.view.viewport.height
    );
  }

  private line(a: Position, b: Position, ink: string, width = 1): void {
    const { ctx } = this;
    if (
      Math.max(a.x, b.x) < 0 ||
      Math.min(a.x, b.x) > this.view.viewport.width ||
      Math.max(a.y, b.y) < 0 ||
      Math.min(a.y, b.y) > this.view.viewport.height
    ) {
      return;
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    this.geometrySegments++;
    this.counts.primitivePaths++;
  }

  private circle(at: Position, radius: number, ink: string, width = 1): void {
    if (!(radius > 0) || !this.visible(at, radius)) {
      return;
    }
    this.ctx.strokeStyle = ink;
    this.ctx.lineWidth = width;
    this.ctx.beginPath();
    this.ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    this.ctx.stroke();
    this.counts.primitivePaths++;
  }

  private label(text: string, at: Position, ink: string): void {
    if (!this.visible(at, 80)) {
      return;
    }
    this.ctx.font = '10px sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillStyle = ink;
    this.ctx.fillText(text, at.x, at.y);
  }

  private glyph(
    kind: Parameters<typeof addResourceMapPath>[1],
    at: Position,
    size: number,
    ink: string,
    material?: Roid['material']
  ): void {
    this.ctx.strokeStyle = ink;
    this.ctx.lineWidth = 1.2;
    this.ctx.beginPath();
    addResourceMapPath(this.ctx, kind, at.x, at.y, size, material);
    this.ctx.stroke();
    this.counts.glyphPaths++;
  }

  draw(): void {
    this.travelAndTerrainCues();
    this.boundary();
    this.asteroids();
    this.spiders();
    this.campaign();
    this.resources();
    this.furnaces();
    this.players();
  }

  private travelAndTerrainCues(): void {
    const { ctx, scene, view } = this;
    for (const waypoint of nearbyRouteWaypoints(scene.terrain, view.viewer)) {
      const at = this.at(waypoint.position);
      if (!this.visible(at)) {
        continue;
      }
      for (const side of [-1, 1]) {
        this.line({ x: at.x + side * 4, y: at.y - 4 }, { x: at.x + side * 7, y: at.y }, '#718c96');
        this.line({ x: at.x + side * 7, y: at.y }, { x: at.x + side * 4, y: at.y + 4 }, '#718c96');
      }
    }
    for (const bridge of scene.bridges) {
      const from = this.at(bridge.from),
        to = this.at(bridge.to);
      ctx.setLineDash(bridge.charged ? [] : [3, 4]);
      this.line(from, to, bridge.charged ? '#a4eeff' : '#738389', bridge.charged ? 2 : 1);
      ctx.setLineDash([]);
      if (bridge.charged) {
        this.circle(from, 5, '#a4eeff');
        this.label('3 · DRAFT', { x: from.x, y: from.y - 9 }, '#a4eeff');
      }
    }
    for (const remains of scene.remains) {
      const at = this.at(remains.position);
      if (!this.visible(at)) {
        continue;
      }
      const nest = remains.kind === 'nest-remains';
      this.line({ x: at.x - 5, y: at.y + 3 }, { x: at.x - 1, y: at.y }, '#687d88');
      this.line({ x: at.x + 1, y: at.y }, { x: at.x + 5, y: at.y - 3 }, '#687d88');
      if (nest) {
        this.line({ x: at.x - 4, y: at.y - 4 }, { x: at.x + 4, y: at.y + 4 }, '#687d88');
      }
    }
    for (const animal of scene.rolyPolys) {
      const at = this.at(animal.position),
        r = Math.max(3, ROLY_POLY.radius * view.worldScale);
      if (!this.visible(at, r)) {
        continue;
      }
      ctx.strokeStyle = '#a6c5a8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(at.x, at.y, r, r * (animal.phase === 'walking' ? 0.65 : 1), 0, 0, Math.PI * 2);
      ctx.stroke();
      this.counts.primitivePaths++;
    }
    ctx.setLineDash([4, 3]);
    for (const reflector of COURT_REFLECTORS) {
      const a = this.at(reflector.start),
        b = this.at(reflector.end);
      this.line(a, b, '#88c9ef');
      this.circle(a, 2, '#88c9ef');
      this.circle(b, 2, '#88c9ef');
    }
    ctx.setLineDash([]);
  }

  private boundary(): void {
    const center = this.at({ x: WORLD_BOUNDARY.cx, y: WORLD_BOUNDARY.cy });
    const r = WORLD_BOUNDARY.radius * this.view.worldScale;
    const distance = Math.hypot(
      center.x - this.view.viewport.width / 2,
      center.y - this.view.viewport.height / 2
    );
    if (
      Math.abs(distance - r) <=
      Math.hypot(this.view.viewport.width, this.view.viewport.height) / 2 + 4
    ) {
      this.circle(center, r, '#ff986f', 2);
    }
  }

  private asteroids(): void {
    const { ctx, view, scene } = this;
    for (const rock of scene.roids) {
      this.targets.set(rock.id, rock.position);
      if (rock.health > 0) {
        if (rock.probe) {
          this.probe(
            rock.probe,
            probePosition({ position: rock.position, rotation: rock.angle }, rock.probe)
          );
        }
      }
      if (rock.health <= 0 || !isAsteroidLit(rock)) {
        continue;
      }
      const at = this.at(rock.position),
        r = Math.max(3.5, rock.r * view.worldScale);
      if (!Number.isFinite(r) || !this.visible(at, r)) {
        continue;
      }
      this.counts.visibleAsteroids++;
      this.glyph('asteroid', at, r, asteroidMapInk(rock.material), rock.material);
      if (rock.phenomenon?.kind === 'reflective') {
        this.line(
          { x: at.x - r / 2, y: at.y + r / 2 },
          { x: at.x + r / 2, y: at.y - r / 2 },
          '#ffffff'
        );
      }
      if (rock.contourRider) {
        this.circle(at, r + 3, '#a4eeff');
      }
      if (rock.supply) {
        this.label(`SUPPLY ${rock.supply.value}`, { x: at.x, y: at.y - r - 4 }, '#78dddc');
      }
      if (rock.glowtoy) {
        this.circle(at, r + 2 + rock.glowtoy.charge * 4, '#a2ffcf');
        if (!rock.glowtoy.cacheRevealed && rock.glowtoy.charge >= 0.7) {
          ctx.setLineDash([2, 5]);
          this.line(at, this.at(rock.glowtoy.cachePosition), '#a2ffcf');
          ctx.setLineDash([]);
        }
      }
      if (rock.boost) {
        const end = {
          x: at.x + Math.cos(rock.boost.angle) * (r + 9),
          y: at.y - Math.sin(rock.boost.angle) * (r + 9),
        };
        this.line(at, end, rock.boost.phase === 'burning' ? '#ffad72' : '#78dddc', 2);
        this.circle(end, 2, '#ffad72');
      }
    }
    for (const warning of scene.recovery) {
      const at = this.at(warning.position),
        r = Math.max(5, warning.size * view.worldScale);
      if (!this.visible(at, r)) {
        continue;
      }
      ctx.setLineDash([4, 3]);
      this.circle(at, r + 3, '#ffc477', 2);
      ctx.setLineDash([]);
      this.label(
        `REFORMING ${Math.max(0, Math.ceil((warning.recoverAt - view.serverNow) / 1000))}s`,
        { x: at.x, y: at.y - r - 6 },
        '#ffc477'
      );
    }
  }

  private probe(probe: AsteroidProbe, position: Position): void {
    if (probe.health <= 0) {
      return;
    }
    const at = this.at(position);
    const range = SURVEY_PROBE.RANGE * this.view.worldScale;
    if (!this.visible(at, range)) {
      return;
    }
    const warning = probe.expiresAt - this.view.serverNow <= SURVEY_PROBE.WARNING_MS;
    const ink = warning ? '#ffad72' : '#67e8f9';
    const phase =
      (Math.max(0, this.view.serverNow - probe.attachedAt) % SURVEY_PROBE.PULSE_MS) /
      SURVEY_PROBE.PULSE_MS;
    this.ctx.globalAlpha = 0.25 * (1 - phase);
    this.circle(at, range * phase, ink);
    this.ctx.globalAlpha = 1;
    if (this.visible(at)) {
      this.glyph('survey_probe', at, 4, ink);
      this.health(at, 5, probe.health, probe.maxHealth, ink);
    }
  }

  private health(at: Position, r: number, health: number, max: number, ink: string): void {
    if (!(max > 0)) {
      return;
    }
    this.line({ x: at.x - r, y: at.y - r - 4 }, { x: at.x + r, y: at.y - r - 4 }, '#35404d', 2);
    this.line(
      { x: at.x - r, y: at.y - r - 4 },
      { x: at.x - r + 2 * r * Math.max(0, Math.min(1, health / max)), y: at.y - r - 4 },
      ink,
      2
    );
  }

  private spiders(): void {
    for (const spider of this.scene.spiders.spiders) {
      this.targets.set(spider.id, spider.position);
      if (spider.health <= 0) {
        continue;
      }
      const at = this.at(spider.position),
        r = Math.max(4, spiderHitRadius(spider.id) * this.view.worldScale);
      if (this.visible(at, r + 8)) {
        this.counts.visibleSpiders++;
        const warning =
          spider.phase === 'hunting' ||
          spider.crawler?.phase === 'winding' ||
          spider.crawler?.phase === 'lunging';
        const ink = warning ? '#ff6075' : spider.crawler ? '#bd8291' : '#d04c66';
        this.circle(at, r, ink, 1.5);
        for (const side of [-1, 1]) {
          this.line({ x: at.x - r, y: at.y + side * r }, { x: at.x + r, y: at.y - side * r }, ink);
        }
        this.line(
          at,
          {
            x: at.x + Math.cos(spider.angle) * (r + (warning ? 8 : 3)),
            y: at.y + Math.sin(spider.angle) * (r + (warning ? 8 : 3)),
          },
          ink,
          2
        );
        if (spider.health < spider.maxHealth) {
          this.health(at, r, spider.health, spider.maxHealth, ink);
        }
      }
      if (spider.probe) {
        this.probe(spider.probe, probePosition(spider, spider.probe));
      }
    }
  }

  private campaign(): void {
    const campaign = this.scene.campaign;
    if (!campaign) {
      return;
    }
    for (const hive of campaign.hives) {
      this.targets.set(hive.id, hive.position);
      const at = this.at(hive.position),
        r = Math.max(8, QUEEN_COMBAT.radius * this.view.worldScale);
      if (hive.clearedAt === null && this.visible(at, r)) {
        const ink = hive.shieldOpen ? '#ffad72' : '#af97ef';
        this.circle(at, r, ink, 2);
        this.circle(at, r * 0.65, ink);
        this.health(at, r, hive.queenHealth, COOPERATIVE.queenHealth, ink);
        this.label(
          hive.shieldOpen ? 'QUEEN EXPOSED' : 'QUEEN SHIELDED',
          { x: at.x, y: at.y + r + 12 },
          ink
        );
      } else if (hive.clearedAt !== null && hive.commissionedAt === null && this.visible(at, r)) {
        this.glyph('wreckage', at, r, '#78dddc');
        this.label(
          `RESTORE ${hive.restoredValue}/${COOPERATIVE.restoreValue}`,
          { x: at.x, y: at.y + r + 12 },
          '#78dddc'
        );
      }
      for (let i = 0; i < hive.sacs.length; i++) {
        const health = hive.sacs[i] ?? 0;
        if (health <= 0) {
          continue;
        }
        const sac = this.at(sacPosition(hive.position, i, hive.sacs.length));
        const radius = Math.max(4, 34 * this.view.worldScale);
        if (!this.visible(sac, radius)) {
          continue;
        }
        this.circle(sac, radius, '#d4db8d');
        this.health(sac, radius, health, COOPERATIVE.sacHealth, '#d4db8d');
      }
      if (hive.sacDeadline !== null && this.visible(at, r)) {
        this.label(
          `SACS ${Math.max(0, Math.ceil((hive.sacDeadline - this.view.serverNow) / 1000))}s`,
          { x: at.x, y: at.y + r + 24 },
          '#d4db8d'
        );
      }
    }
    for (const meteor of campaign.meteors) {
      const at = this.at(meteor.position),
        r = Math.max(4, 16 * this.view.worldScale);
      if (!this.visible(at, r)) {
        continue;
      }
      this.counts.visibleMeteors++;
      this.circle(at, r, '#ffad72', 2);
      this.line(
        { x: at.x - r / 2, y: at.y - r / 2 },
        { x: at.x + r / 2, y: at.y + r / 2 },
        '#ffad72'
      );
    }
  }

  private resources(): void {
    const { scene, view } = this;
    if (scene.lootBlast !== null) {
      this.circle(
        this.at(scene.lootBlast.position),
        scene.lootBlast.radius * view.worldScale,
        PALETTE.DANGER,
        2
      );
    }
    for (const drop of scene.loot) {
      const at = this.at(drop.position),
        r = Math.max(
          drop.kind === 'shard' || drop.kind === 'points' || drop.kind === 'silk' ? 2.5 : 5,
          drop.radius * view.worldScale
        );
      if (!this.visible(at, r)) {
        continue;
      }
      this.counts.visibleLoot++;
      this.glyph(drop.kind, at, r, PALETTE.LOOT);
      if (drop.kind !== 'shard' && drop.kind !== 'points' && drop.kind !== 'silk') {
        this.label(
          drop.kind.replaceAll('_', ' ').toUpperCase(),
          { x: at.x, y: at.y + r + 10 },
          PALETTE.LOOT
        );
      }
    }
    for (const pickup of scene.pickups) {
      if (pickup.health <= 0 || (pickup.state !== 'loose' && pickup.state !== 'orbiting')) {
        continue;
      }
      const at = this.at(pickup.position),
        r = Math.max(4, pickup.radius * view.worldScale);
      if (!this.visible(at, r)) {
        continue;
      }
      this.glyph('satellite', at, r, pickup.color || '#8bc7ef');
      if (pickup.state === 'orbiting') {
        this.circle(at, r + 2, '#78dddc');
      }
      if (pickup.health < pickup.maxHealth) {
        this.health(at, r, pickup.health, pickup.maxHealth, '#78dddc');
      }
    }
  }

  private route(points: readonly Position[], ink: string): void {
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1],
        current = points[i];
      if (previous && current) {
        this.line(this.at(previous), this.at(current), ink);
      }
    }
  }

  private furnaces(): void {
    const { scene, view, ctx } = this;
    const reach =
      Math.hypot(view.viewport.width, view.viewport.height) / (2 * view.worldScale) + 300;
    const nearby = scene.furnaces.nearby(view.viewer, reach);
    for (const furnace of nearby) {
      const cell = explorationCellAt(furnace.position);
      if (cell === null || !isCellExplored(scene.exploration, cell)) {
        continue;
      }
      const at = this.at(furnace.position),
        r = Math.max(6, furnace.radius * view.worldScale);
      if (!this.visible(at, r)) {
        continue;
      }
      this.route(
        furnace.id.startsWith('frontier:')
          ? pipeToTownSquare(furnace.id)
          : pipeHopToParent(furnace.id),
        '#745b43'
      );
      this.circle(at, r, '#ffb966', 2);
      this.circle(at, r * 0.35, '#ffb966');
      this.label(
        `${furnace.name} · ${furnace.id === TOWN_HEARTH.id ? 'STORE' : 'DELIVERY'}`,
        { x: at.x, y: at.y + r + 12 },
        '#ffb966'
      );
    }
    for (const lot of CIVIC_LOTS) {
      if (scene.furnaces.isLit(lot.id)) {
        continue;
      }
      const at = this.at(lot.position),
        r = Math.max(6, lot.radius * view.worldScale);
      if (!this.visible(at, r)) {
        continue;
      }
      ctx.setLineDash([4, 3]);
      this.circle(at, r, '#86766b');
      ctx.setLineDash([]);
      this.label(
        `${lot.name} · SCORE ${formatPoints(lot.cost)}`,
        { x: at.x, y: at.y + r + 12 },
        '#b7a492'
      );
    }
  }

  private players(): void {
    const { scene, view, ctx } = this;
    for (const player of scene.players) {
      const ship = player.ship,
        at = this.at(ship.position);
      const r = Math.max(player.id === scene.localPlayer.id ? 6 : 4, ship.r * view.worldScale);
      const alive = !ship.exploding && ship.health > 0;
      if (alive && ship.kitId === 'scout' && ship.abilityActiveFrames > 0) {
        const elapsed = Math.max(0, SHIP_ABILITY.SCAN_FRAMES - ship.abilityActiveFrames);
        const pulseFrames = SHIP_ABILITY.SCAN_FRAMES / SHIP_ABILITY.SCAN_PULSES;
        for (let pulse = 0; pulse < SHIP_ABILITY.SCAN_PULSES; pulse++) {
          const progress = (elapsed - pulse * pulseFrames) / pulseFrames;
          if (progress < 0 || progress >= 1) {
            continue;
          }
          const inner = ship.r * view.worldScale;
          const radius = inner + (SHIP_ABILITY.SCAN_RANGE * view.worldScale - inner) * progress;
          ctx.globalAlpha = 0.5 * (progress <= 0.75 ? 1 : (1 - progress) / 0.25);
          this.circle(at, radius, '#67e8f9', 2);
          ctx.globalAlpha = 1;
        }
      }

      if (ship.utilityFlight) {
        const tip = this.at(ship.utilityFlight.position);
        if (ship.utilityFlight.kind === 'tow') {
          this.line(at, tip, PALETTE.LOOT);
        }
        if (this.visible(tip)) {
          this.glyph(
            ship.utilityFlight.kind === 'probe' ? 'survey_probe' : 'wreckage',
            tip,
            4,
            '#67e8f9'
          );
        }
      }
      if (ship.harpoonTargetId) {
        const target = this.targets.get(ship.harpoonTargetId) ?? ship.harpoonLatchPos;
        if (target) {
          ctx.setLineDash([3, 3]);
          const tip = this.at(target);
          this.line(at, tip, PALETTE.LOOT);
          ctx.setLineDash([]);
          this.circle(tip, 2, PALETTE.LASER_LOCAL);
        }
      }
      if (ship.furnaceTransit) {
        this.route(
          planFurnaceRoute(ship.furnaceTransit.sourceId, ship.furnaceTransit.destinationId),
          '#ffad72'
        );
      }
      if (this.visible(at, r + 10)) {
        if (ship.exploding) {
          this.circle(at, r * 1.5, '#ffad72');
        }
        if (alive && (ship.blinkCount <= 0 || ship.blinkOn)) {
          const cos = Math.cos(ship.angle),
            sin = -Math.sin(ship.angle);
          const nose = { x: at.x + cos * r, y: at.y + sin * r };
          const left = { x: at.x - cos * r - sin * r * 0.7, y: at.y - sin * r + cos * r * 0.7 };
          const right = { x: at.x - cos * r + sin * r * 0.7, y: at.y - sin * r - cos * r * 0.7 };
          this.line(nose, left, player.color, 1.5);
          this.line(left, right, player.color, 1.5);
          this.line(right, nose, player.color, 1.5);
          if (ship.kitId === 'hauler') {
            this.line(left, { x: at.x + sin * r * 0.7, y: at.y - cos * r * 0.7 }, player.color);
          }
          if (ship.thrusting) {
            this.line(
              { x: at.x - cos * r, y: at.y - sin * r },
              { x: at.x - cos * r * 1.8, y: at.y - sin * r * 1.8 },
              '#ffad72'
            );
          }
          this.health(at, r, ship.health, ship.maxHealth, player.color);
          if (ship.weaponChargeFrames > 0 || ship.weaponChargeStartedAt !== null) {
            this.circle(at, r + 4, PALETTE.LASER_LOCAL);
          }
          if (ship.navigationAssistFrames > 0 || ship.contourLock) {
            this.circle(at, r + 6, '#a4eeff');
          }
          const cargo = player.cargo / cargoCapacity(ship.kitId);
          if (cargo > 0) {
            this.line(
              { x: at.x - r, y: at.y + r + 3 },
              { x: at.x - r + 2 * r * Math.min(1, cargo), y: at.y + r + 3 },
              PALETTE.LOOT,
              2
            );
          }
          if (cargo >= 1) {
            this.label('CARGO FULL', { x: at.x, y: at.y + r + 13 }, PALETTE.LOOT);
          }
          if (player.id !== scene.localPlayer.id) {
            this.label(player.name, { x: at.x, y: at.y + r + 24 }, player.color);
          }
        }
      }
      if (player.id === scene.localPlayer.id || alive) {
        for (const shot of ship.lasers) {
          if (shot.explodeTime !== 0 || shot.hasExploded) {
            continue;
          }
          const tip = this.at(shot.position);
          if (!this.visible(tip)) {
            continue;
          }
          this.counts.visibleShots++;
          const magnitude = Math.hypot(shot.velocity.x, shot.velocity.y) || 1;
          this.line(
            tip,
            {
              x: tip.x - (shot.velocity.x / magnitude) * 5,
              y: tip.y - (shot.velocity.y / magnitude) * 5,
            },
            laserBoltColor(PALETTE.LASER_LOCAL, shot.bounceCount),
            2
          );
        }
      }
      const signalPosition = ship.downedUntil ? ship.position : ship.crewSignal?.position;
      if (
        signalPosition &&
        Math.hypot(signalPosition.x - view.viewer.x, signalPosition.y - view.viewer.y) <=
          COOPERATIVE.signalRadius
      ) {
        const signal = this.at(signalPosition);
        signal.x = Math.max(20, Math.min(view.viewport.width - 20, signal.x));
        signal.y = Math.max(20, Math.min(view.viewport.height - 20, signal.y));
        const ink = ship.downedUntil ? '#ffbd69' : '#78dddc';
        this.circle(signal, 7, ink, 2);
        this.line({ x: signal.x - 4, y: signal.y }, { x: signal.x + 4, y: signal.y }, ink);
        this.label(
          `${player.name} · ${ship.downedUntil ? 'RESCUE' : ship.crewSignal?.kind}`,
          { x: signal.x, y: signal.y + 17 },
          ink
        );
      }
    }
  }
}
