type DiagnosticMode = 'timing' | 'observation';
type ReadbackWarning = 'webgl-readback' | 'canvas-readback';

// Pinned Chromium messages only: surrounding prefixes/suffixes or different GL
// diagnostics are unknown warnings, even when they contain the same keywords.
const WEBGL_READBACK =
  /^\[\.WebGL-0x[0-9a-fA-F]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/u;
const CANVAS_READBACK =
  /^Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true\. See: https:\/\/html\.spec\.whatwg\.org\/multipage\/canvas\.html#concept-canvas-will-read-frequently$/u;

export function classifyReadbackWarning(message: string): ReadbackWarning | undefined {
  return WEBGL_READBACK.test(message)
    ? 'webgl-readback'
    : CANVAS_READBACK.test(message)
      ? 'canvas-readback'
      : undefined;
}

/** Every capture performs one composed draw/read: at most one warning of each
 * known type may be attributed to it. Timing performs zero captures and admits
 * zero warnings. A successful receipt retains every exact warning message. */
export function createClientConsoleDiagnostics(mode: DiagnosticMode, plannedCaptures: number) {
  if (
    !Number.isSafeInteger(plannedCaptures) ||
    plannedCaptures < 0 ||
    (mode === 'timing' && plannedCaptures !== 0) ||
    (mode === 'observation' && plannedCaptures === 0)
  ) {
    throw new Error('Invalid console diagnostic capture budget');
  }
  const counts = { 'webgl-readback': 0, 'canvas-readback': 0 };
  const warnings: { mode: DiagnosticMode; kind: ReadbackWarning; message: string }[] = [];
  let warningCount = 0;
  let failure: Error | undefined;
  return {
    warning(message: string): void {
      warningCount++;
      if (failure) {
        return;
      }
      if (mode === 'timing') {
        failure = new Error(`Timing context console warning: ${message}`);
        return;
      }
      const kind = classifyReadbackWarning(message);
      if (kind === undefined) {
        failure = new Error(`Unknown observation console warning: ${message}`);
        return;
      }
      counts[kind]++;
      if (counts[kind] > plannedCaptures || warningCount > plannedCaptures * 2) {
        failure = new Error(`Observation readback warning budget exceeded: ${message}`);
        return;
      }
      warnings.push({ mode, kind, message });
    },
    finish(actualCaptures: number) {
      if (failure) {
        throw failure;
      }
      if (!Number.isSafeInteger(actualCaptures) || actualCaptures !== plannedCaptures) {
        throw new Error('Console diagnostic budget does not match actual observation captures');
      }
      return {
        mode,
        actualCaptures,
        warningCount,
        warningLimit: plannedCaptures * 2,
        limitsByType: { 'webgl-readback': plannedCaptures, 'canvas-readback': plannedCaptures },
        warnings: warnings.map((warning) => ({ ...warning })),
      };
    },
  };
}
