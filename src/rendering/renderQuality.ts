type DprLimit = 'native' | 1.5 | 2;
type Glow = 'full' | 'off';

type RenderQuality = Readonly<{
  maxDpr: DprLimit;
  glow: Glow;
  source: 'desktop-default' | 'touch-default' | 'diagnostic';
}>;

// No reduced production preset is accepted until both physical-phone cohorts pass.
// See docs/performance/mobile-quality-decisions.md for evidence and retirement rules.
const FULL_QUALITY = Object.freeze({ maxDpr: 'native', glow: 'full' } as const);
const TOUCH_PRESET = FULL_QUALITY;
let activeQuality: RenderQuality = { ...FULL_QUALITY, source: 'desktop-default' };

/** Resolve once at the canvas resize/session boundary, never inside a drawing loop. */
export function configureRenderQuality(search: string, touchControls: boolean): RenderQuality {
  const params = new URLSearchParams(search);
  const diagnostic = ['1', 'collect'].includes(params.get('performance') ?? '');
  const defaults = touchControls ? TOUCH_PRESET : FULL_QUALITY;
  let maxDpr: DprLimit = defaults.maxDpr;
  let glow: Glow = defaults.glow;
  const dprOverride = diagnostic ? params.get('renderDpr') : null;
  const glowOverride = diagnostic ? params.get('renderGlow') : null;
  if (dprOverride !== null) {
    switch (dprOverride) {
      case 'native':
        maxDpr = 'native';
        break;
      case '1.5':
        maxDpr = 1.5;
        break;
      case '2':
        maxDpr = 2;
        break;
      default:
        throw new Error('renderDpr must be native, 2, or 1.5');
    }
  }
  if (glowOverride !== null) {
    if (glowOverride !== 'full' && glowOverride !== 'off') {
      throw new Error('renderGlow must be full or off');
    }
    glow = glowOverride;
  }
  activeQuality = Object.freeze({
    maxDpr,
    glow,
    source:
      dprOverride !== null || glowOverride !== null
        ? 'diagnostic'
        : touchControls
          ? 'touch-default'
          : 'desktop-default',
  });
  return activeQuality;
}

/** Cosmetic blur only: geometry, color, core strokes, and timing are unaffected. */
export function resolveGlow(blur: number): number {
  return activeQuality.glow === 'off' ? 0 : blur;
}
