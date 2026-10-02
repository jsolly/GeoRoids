import type { ShipKitId, TerrainSpider } from '../shared-types';

export type ClientScene = 'stationary' | 'scan-transition' | 'scan-wide' | 'spider-field';
type SceneTraits = Readonly<{
  kit: ShipKitId;
  activation: 'none' | 'before-warmup' | 'after-warmup';
  spiders: 0 | 10;
  presentationClock: 'native' | 'fixed-60hz';
  warmupFrames: number;
  measuredFrames: number;
  checkpoints: readonly number[];
}>;

export interface ClientSceneFrame {
  frame: number;
  zoom: number;
  nativeScale: number;
  virtualWidth: number;
  virtualHeight: number;
  activeFrames: number;
  cooldownFrames: number;
  worldLayerBegins: number;
  spiderLegStrokes: number;
  spiderBodyEllipses: number;
  infestationStrokes: number;
  canvasCreates: number;
}

const SCENES = {
  stationary: {
    kit: 'hauler',
    activation: 'none',
    spiders: 0,
    presentationClock: 'native',
    warmupFrames: 30,
    measuredFrames: 120,
    checkpoints: [],
  },
  'scan-transition': {
    kit: 'scout',
    activation: 'after-warmup',
    spiders: 0,
    presentationClock: 'fixed-60hz',
    warmupFrames: 30,
    measuredFrames: 240,
    checkpoints: [6, 60, 119, 120, 126, 240],
  },
  'scan-wide': {
    kit: 'scout',
    activation: 'before-warmup',
    spiders: 0,
    presentationClock: 'fixed-60hz',
    warmupFrames: 60,
    measuredFrames: 45,
    checkpoints: [1, 45],
  },
  'spider-field': {
    kit: 'hauler',
    activation: 'none',
    spiders: 10,
    presentationClock: 'fixed-60hz',
    warmupFrames: 30,
    measuredFrames: 120,
    checkpoints: [1, 60, 120],
  },
} as const satisfies Record<ClientScene, SceneTraits>;

/** Presets lock coupled traits; callers cannot quietly measure a different scan window. */
export function isClientScene(scene: unknown): scene is ClientScene {
  return typeof scene === 'string' && Object.hasOwn(SCENES, scene);
}

export function clientSceneTraits(scene: unknown = 'stationary'): SceneTraits {
  if (!isClientScene(scene)) {
    throw new Error('Unknown client scene');
  }
  const traits = SCENES[scene];
  return Object.freeze({ ...traits, checkpoints: Object.freeze([...traits.checkpoints]) });
}

export function validateClientSceneFrames(
  scene: ClientScene,
  warmup: number,
  measured: number
): void {
  const traits = clientSceneTraits(scene);
  if (
    scene !== 'stationary' &&
    (warmup !== traits.warmupFrames || measured !== traits.measuredFrames)
  ) {
    throw new Error('Client scene requires its declared warmup and measured frame counts');
  }
}

/** Server snapshot participants; this fixture does not pretend to simulate predator motion. */
export function clientSceneSpiders(): TerrainSpider[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `benchmark-spider-${index}`,
    position: { x: -90 + (index % 5) * 45, y: index < 5 ? -60 : 60 },
    angle: (index * Math.PI) / 7,
    health: 100,
    maxHealth: 100,
    phase: 'scuttling',
    targetId: null,
  }));
}

export function verifyClientSceneAbility(
  scene: ClientScene,
  active: number,
  cooldown: number
): void {
  const expected =
    scene === 'scan-wide' ? [15, 1095] : scene === 'scan-transition' ? [0, 960] : [0, 0];
  if (active !== expected[0] || cooldown !== expected[1]) {
    throw new Error('Client scene did not execute its one ordinary ability lifecycle');
  }
}

/** These are outcome guards, not fixed API-call budgets: legitimate batching may reduce work. */
export function verifyClientScenePresentation(
  scene: ClientScene,
  viewport: { width: number; height: number },
  frames: readonly ClientSceneFrame[]
): void {
  const traits = clientSceneTraits(scene);
  if (
    frames.length !== traits.measuredFrames ||
    frames.some(
      (row, index) =>
        row.frame !== index + 1 ||
        row.worldLayerBegins !== 1 ||
        !Object.values(row).every(Number.isFinite) ||
        row.zoom <= 0 ||
        // Canvas retains its native transform at float precision. The logical
        // viewport still supplies the exact camera zoom; test both observations.
        Math.abs(row.nativeScale - row.zoom) > Math.max(row.zoom, row.nativeScale) * 2 ** -22 ||
        Math.abs(row.virtualWidth * row.zoom - viewport.width) > 1e-8 ||
        Math.abs(row.virtualHeight * row.zoom - viewport.height) > 1e-8
    )
  ) {
    throw new Error('Missing scene probe or inconsistent actual world projection');
  }
  const last = frames.at(-1);
  if (!last) {
    throw new Error('Missing final scene frame');
  }
  const target = Math.min(1, Math.min(viewport.width, viewport.height) / (2 * 1200 * 1.15));
  if (
    scene === 'scan-wide' &&
    frames.some((row) => Math.abs(row.zoom - target) > 1e-12 || row.activeFrames <= 0)
  ) {
    throw new Error('Steady scan did not stay at the actual wide projection');
  }
  if (scene === 'scan-transition') {
    const entry = frames[5];
    const wide = frames[59];
    const expires = frames[119];
    const returning = frames[125];
    if (
      !entry ||
      !wide ||
      !expires ||
      !returning ||
      !(entry.zoom < 1 && entry.zoom > wide.zoom) ||
      Math.abs(wide.zoom - target) > 1e-12 ||
      wide.activeFrames !== 60 ||
      expires.activeFrames !== 0 ||
      !(returning.zoom > wide.zoom && returning.zoom < 1) ||
      last.zoom !== 1
    ) {
      throw new Error('Scan entry, widening, expiry or return did not execute');
    }
  }
  if (
    scene === 'spider-field' &&
    frames.some(
      (row) =>
        row.zoom !== 1 ||
        row.spiderLegStrokes < 1 ||
        row.spiderBodyEllipses < 1 ||
        row.infestationStrokes < 1
    )
  ) {
    throw new Error('Spider scene omitted observed legs, bodies or infested contours');
  }
}
