/** Pointer headings stay in screen space and are converted each simulation step. */
export const controlSources: { pointerHeading: number | null; touchFire: boolean } = {
  pointerHeading: null,
  touchFire: false,
};

/** Release held controls; automatic cruise is a flight rule, not an input source. */
export function resetControlSources(): void {
  controlSources.pointerHeading = null;
  controlSources.touchFire = false;
}
