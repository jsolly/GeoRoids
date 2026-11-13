// Independent sender clock. Delivery can queue while the main thread is blocked.
let sequence = 0;
setInterval(() => {
  globalThis.postMessage({
    sequence: ++sequence,
    monotonicMs: performance.now(),
    timeOrigin: performance.timeOrigin,
    wallMs: Date.now(),
  });
}, 100);

export {};
