import { watchClientRelease } from './clientReleaseWatcher';

// Independent of the match loop: open menus and background game tabs refresh too.
if (import.meta.env.PROD) {
  let stop: () => void = () => undefined;
  const start = () => {
    stop();
    stop = watchClientRelease(import.meta.env.VITE_COMMIT_HASH, {
      fetch: (input, init) => window.fetch(input, init),
      storage: {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
      },
      document,
      reload: () => window.location.reload(),
    });
  };
  const hide = () => stop();
  const show = (event: PageTransitionEvent) => {
    if (event.persisted) {
      start();
    }
  };
  start();
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  import.meta.hot?.dispose(() => {
    stop();
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
  });
}
