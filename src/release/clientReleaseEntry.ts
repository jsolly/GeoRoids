import { watchClientRelease } from './clientReleaseWatcher';

/** Independent of the match loop; owned by the mounted browser shell. */
export function mountClientRelease(): () => void {
  if (!import.meta.env.PROD) {
    return () => {};
  }
  const previous = document.documentElement.dataset['clientRelease'];
  const release = import.meta.env['VITE_COMMIT_SHA'];
  document.documentElement.dataset['clientRelease'] = release;
  let stop: () => void = () => {};
  const start = () => {
    stop();
    stop = watchClientRelease(release, {
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
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    stop();
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
    if (document.documentElement.dataset['clientRelease'] === release) {
      if (previous === undefined) {
        delete document.documentElement.dataset['clientRelease'];
      } else {
        document.documentElement.dataset['clientRelease'] = previous;
      }
    }
  };
}
