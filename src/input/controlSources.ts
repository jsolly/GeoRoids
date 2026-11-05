/** Pointer headings stay in screen space and are converted each simulation step. */
export const controlSources: {
  pointerHeading: number | null;
  touchFire: boolean;
  steeringEpoch: number;
} = {
  pointerHeading: null,
  touchFire: false,
  steeringEpoch: 0,
};

/** Release held controls independently of navigation orders. */
export function resetControlSources(): void {
  controlSources.pointerHeading = null;
  controlSources.steeringEpoch++;
  controlSources.touchFire = false;
}
