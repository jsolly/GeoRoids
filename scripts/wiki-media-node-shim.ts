/** Minimal browser surface for gameplay modules imported by the server helpers. */
if (!('localStorage' in globalThis)) {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string): string | null => values.get(key) ?? null,
      removeItem: (key: string): void => {
        values.delete(key);
      },
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
    },
  });
}

if (!('Audio' in globalThis)) {
  class NodeAudio {
    public volume = 1;
    public loop = false;
    public currentTime = 0;
    public paused = true;

    public addEventListener(): void {}

    public removeEventListener(): void {}

    public play(): Promise<void> {
      this.paused = false;
      return Promise.resolve();
    }

    public pause(): void {
      this.paused = true;
    }
  }

  Object.defineProperty(globalThis, 'Audio', {
    configurable: true,
    value: NodeAudio,
  });
}
