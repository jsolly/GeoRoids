function currentDevicePixelRatio(): number {
  const dpr = window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

export function watchDevicePixelRatio(onChange: () => void): () => void {
  let mediaQuery: MediaQueryList | null = null;
  let stopped = false;

  const handleChange = (): void => {
    if (stopped) {
      return;
    }
    bindToCurrentRatio();
    onChange();
  };

  const bindToCurrentRatio = (): void => {
    mediaQuery?.removeEventListener('change', handleChange);
    mediaQuery = window.matchMedia(`(resolution: ${currentDevicePixelRatio()}dppx)`);
    mediaQuery.addEventListener('change', handleChange);
  };

  bindToCurrentRatio();

  return (): void => {
    stopped = true;
    mediaQuery?.removeEventListener('change', handleChange);
    mediaQuery = null;
  };
}
