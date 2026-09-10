/** Set the JSDOM window used by rendering, independently of Vitest globals. */
export function setWindowViewport(width: number, height: number, devicePixelRatio = 1): () => void {
  const values = { innerWidth: width, innerHeight: height, devicePixelRatio };
  const previous = Object.entries(values).map(([name, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
    return { name, descriptor };
  });
  return () => {
    for (const { name, descriptor } of previous) {
      if (descriptor) {
        Object.defineProperty(window, name, descriptor);
      } else {
        Reflect.deleteProperty(window, name);
      }
    }
  };
}
