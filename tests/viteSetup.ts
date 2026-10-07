import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '../src/utils/logLevel';

// Node-environment suites have no browser globals to configure.
if (typeof window !== 'undefined') {
  // Use the DOM owned by Vitest so events and elements share one window.
  document.body.innerHTML =
    readFileSync(resolve(__dirname, '../index.html'), 'utf8')
      .split('<body>')[1]
      ?.split('</body>')[0] ?? '';

  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }) as unknown as MediaQueryList;
  }

  // Mock localStorage for tests with the same backing store for global/window access.
  const storage = new Map<string, string>();
  const localStorageMock: Storage = {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: localStorageMock,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorageMock,
    writable: true,
  });
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: localStorageMock,
    writable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: localStorageMock,
    writable: true,
  });

  // Silence jsdom "Not implemented: HTMLMediaElement.prototype.play" by stubbing media methods
  type MediaProto = {
    play: () => Promise<void>;
    pause: () => void;
    load: () => void;
  };

  const maybePatchMediaProto = (proto: unknown) => {
    if (!proto || typeof proto !== 'object') {
      return;
    }
    const p = proto as MediaProto;
    Object.defineProperty(p, 'play', {
      configurable: true,
      writable: true,
      value: () => Promise.resolve(),
    });
    Object.defineProperty(p, 'pause', {
      configurable: true,
      writable: true,
      value: () => {},
    });
    Object.defineProperty(p, 'load', {
      configurable: true,
      writable: true,
      value: () => {},
    });
  };

  maybePatchMediaProto(
    (globalThis as unknown as { HTMLMediaElement?: { prototype?: unknown } }).HTMLMediaElement
      ?.prototype
  );
  maybePatchMediaProto(
    (global.window as unknown as { HTMLMediaElement?: { prototype?: unknown } }).HTMLMediaElement
      ?.prototype
  );
  maybePatchMediaProto(
    (globalThis as unknown as { HTMLAudioElement?: { prototype?: unknown } }).HTMLAudioElement
      ?.prototype
  );
  maybePatchMediaProto(
    (global.window as unknown as { HTMLAudioElement?: { prototype?: unknown } }).HTMLAudioElement
      ?.prototype
  );

  // Mock Audio for tests
  if (typeof global.window.Audio === 'undefined') {
    global.window.Audio = class {
      constructor(src?: string) {
        if (src) {
          this.src = src;
        }
      }
      src: string = '';
      play(): Promise<void> {
        return Promise.resolve();
      }
      pause(): void {}
      load(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      volume: number = 1;
      currentTime: number = 0;
      duration: number = 0;
      paused: boolean = true;
    } as unknown as typeof HTMLAudioElement;
  }
}
