import '../src/utils/logLevel';

// Node-environment suites have no browser globals to configure.
if (typeof window !== 'undefined') {
  // Use the DOM owned by Vitest so events and elements share one window.
  document.body.innerHTML = `
    <canvas id="title-terrain"></canvas>
    <div id="gameWrapper">
      <div id="start-screen" class="screen">
        <h1>GeoRoids</h1>
        <p id="controls-hint" class="controls-hint">Always thrust · Mouse, A/D or left/right arrows to steer · Space fires · Shift or right-click boost · E ability · M map</p>
        <div class="game-modes">
          <div>
            <label for="playerNameInput" class="nickname-label">Your Nickname</label>
            <input
              type="text"
              id="playerNameInput"
              maxlength="20"
              placeholder="Crimson Falcon"
              class="nickname-input"
              autocomplete="nickname"
            />
          </div>
          <fieldset class="ship-kit-select">
            <legend>Ship kit</legend>
            <div id="ship-kit-grid" class="ship-kit-grid"></div>
            <p class="ship-kit-placeholder-note">AD v2 silhouettes</p>
          </fieldset>
          <div class="start-actions">
            <button id="start-game" type="button" class="enter-game">
              Enter Game
            </button>
          </div>
        </div>
        <div class="settings">
          <div class="sound-toggle-row">
            <input
              class="sound-toggle"
              type="checkbox"
              id="soundPref"
              checked
            />
            <label class="sound-toggle-label" for="soundPref">Sound</label>
          </div>
          <details id="advanced-settings" class="advanced-settings">
            <summary>Advanced</summary>
            <div class="debug-toggle-row">
              <input class="sound-toggle" type="checkbox" id="debugPref" />
              <label class="sound-toggle-label" for="debugPref">Debug</label>
            </div>
            <div id="debug-identity" class="debug-identity" hidden>
              <div>
                <label class="debug-id-label" for="debug-player-id">Player ID</label>
                <div class="debug-id-row">
                  <input id="debug-player-id" class="debug-id-input" type="text" readonly />
                  <button id="copy-debug-player-id" type="button" class="debug-copy" disabled>Copy</button>
                </div>
              </div>
              <div>
                <label class="debug-id-label" for="debug-session-id">Page session</label>
                <div class="debug-id-row">
                  <input id="debug-session-id" class="debug-id-input" type="text" readonly />
                  <button id="copy-debug-session-id" type="button" class="debug-copy">Copy</button>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div id="gameArea" hidden>
        <div id="debug-play-chip" class="debug-play-chip" hidden>
          <span class="debug-play-chip-label">playerId</span>
          <code id="debug-play-chip-id"></code>
          <button id="copy-debug-play-chip" type="button" class="debug-copy" disabled>Copy</button>
        </div>
        <canvas id="gameCanvas" width="800" height="600"></canvas>
        <div id="touch-controls" class="touch-controls" hidden aria-hidden="true">
        </div>
      </div>
      <div id="safe-area-probe"></div>
    </div>
    <div id="attribution">
      <span id="buildInfo" class="build-info"></span>
    </div>
`;

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
