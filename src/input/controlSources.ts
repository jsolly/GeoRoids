type ControlSources = {
  mouseThrust: boolean;
  touchThrust: boolean;
  touchHeading: number | null;
  touchFire: boolean;
  touchSteeringActive: boolean;
};

export const controlSources: ControlSources = {
  mouseThrust: false,
  touchThrust: false,
  touchHeading: null,
  touchFire: false,
  touchSteeringActive: false,
};

export function resetControlSources(): void {
  controlSources.mouseThrust = false;
  resetTouchSources();
}

export function resetTouchSources(): void {
  controlSources.touchThrust = false;
  controlSources.touchHeading = null;
  controlSources.touchFire = false;
  controlSources.touchSteeringActive = false;
}
