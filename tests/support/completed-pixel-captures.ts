/** Failed observation reads cannot create credits for console warnings. */
export function createCompletedPixelCaptures() {
  let completed = 0;
  return {
    capture<T>(read: () => T): T {
      const pixels = read();
      completed++;
      return pixels;
    },
    count: () => completed,
  };
}
