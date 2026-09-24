import { afterEach, expect, test, vi } from 'vitest';
import { WikiScrollMemory } from '../../../src/wiki/scrollMemory';

afterEach(() => {
  vi.useRealTimers();
});

function memory(start = 'index'): {
  scroll: WikiScrollMemory;
  writes: number[];
  remembered: Array<{ id: string; y: number }>;
  visit: () => string;
} {
  const writes: number[] = [];
  const remembered: Array<{ id: string; y: number }> = [];
  let y = 0;
  let visitNumber = 0;
  return {
    writes,
    remembered,
    visit: () => {
      visitNumber += 1;
      return `visit-${visitNumber}`;
    },
    scroll: new WikiScrollMemory(
      start,
      (next) => {
        y = next;
        writes.push(next);
      },
      (id, saved) => {
        remembered.push({ id, y: saved });
      },
      () => y
    ),
  };
}

test('back returns to the scrolled index after an article opens at the top', () => {
  const { scroll, writes, visit } = memory();
  scroll.noteScroll(720);
  scroll.prepareForLink(720);
  scroll.prepareForTraversal('index', 720, 720);
  scroll.noteScroll(0);
  scroll.show(visit);
  expect(writes).toEqual([0]);

  scroll.prepareForTraversal('index', 0, 180);
  scroll.noteScroll(0);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(720);
});

test('forward returns to the scrolled article', () => {
  const { scroll, writes, visit } = memory();
  scroll.noteScroll(720);
  scroll.prepareForLink(720);
  scroll.prepareForTraversal('index', 720, 720);
  scroll.show(() => 'hauler');
  expect(writes.at(-1)).toBe(0);
  scroll.noteScroll(180);
  scroll.prepareForTraversal('index', 720, 180);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(720);
  scroll.prepareForTraversal('hauler', 0, 720);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(180);
});

test('opening an article again starts at the top and keeps the earlier offset', () => {
  const { scroll, writes, visit } = memory();
  scroll.prepareForLink(400);
  scroll.prepareForTraversal('index', 400, 400);
  scroll.show(() => 'hauler-first');
  expect(writes.at(-1)).toBe(0);
  scroll.noteScroll(400);
  scroll.prepareForLink(400);
  scroll.prepareForTraversal('hauler-first', 400, 400);
  scroll.show(() => 'controls');
  scroll.prepareForTraversal('hauler-first', 0, 0);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(400);

  scroll.prepareForLink(400);
  scroll.prepareForTraversal('index', 400, 400);
  scroll.show(() => 'hauler-second');
  expect(writes.at(-1)).toBe(0);
  scroll.noteScroll(180);
  scroll.prepareForTraversal('index', 400, 180);
  scroll.show(visit);
  scroll.prepareForTraversal('hauler-first', 400, 400);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(400);
  scroll.prepareForTraversal('hauler-second', 180, 400);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(180);
});

test('back to the ship comparison keeps the old offset instead of jumping to the anchor', () => {
  let anchors = 0;
  const { scroll, writes, visit } = memory();
  scroll.noteScroll(540);
  scroll.prepareForLink(540);
  scroll.show(visit, () => {
    anchors += 1;
  });
  expect(anchors).toBe(1);
  expect(writes).toEqual([]);

  scroll.prepareForTraversal('index', 540, 0);
  scroll.show(visit, () => {
    anchors += 1;
  });
  expect(anchors).toBe(1);
  expect(writes).toEqual([540]);
});

test('a link click that never leaves still remembers the next scroll', async () => {
  vi.useFakeTimers();
  const { scroll, writes, visit } = memory('hauler');
  scroll.prepareForLink(40);
  scroll.noteScroll(12);
  await vi.advanceTimersByTimeAsync(0);
  scroll.noteScroll(260);
  scroll.prepareForTraversal('controls', undefined, 260);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(0);
  scroll.prepareForTraversal('hauler', 40, 0);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(260);
});

test('leaving the manual keeps the offset when the document then scrolls to the top', () => {
  const { scroll, remembered } = memory();
  scroll.noteScroll(831);
  scroll.prepareForDocumentLeave(831);
  scroll.noteScroll(0);
  expect(remembered.at(-1)).toEqual({ id: 'index', y: 831 });
});

test('search keeps the offset from before the results', () => {
  const { scroll, writes, visit } = memory();
  scroll.hold(720);
  scroll.noteScroll(0);
  scroll.prepareForLink(0);
  scroll.prepareForTraversal('index', 720, 0);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(0);
  scroll.prepareForTraversal('index', 0, 0);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(720);
});

test('a restored visit records the next scroll', () => {
  const { scroll, remembered, writes } = memory();
  scroll.prepareForDocumentLeave(640);
  scroll.noteScroll(0);
  scroll.restoreSaved(640);
  expect(writes.at(-1)).toBe(640);
  scroll.noteScroll(900);
  scroll.capture(900);
  expect(remembered.at(-1)).toEqual({ id: 'index', y: 900 });
});

test('back during search keeps the offset from before the results', () => {
  const { scroll, writes, visit } = memory();
  scroll.hold(720);
  scroll.prepareForTraversal('previous', 10, 0);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(10);
  scroll.prepareForTraversal('index', 0, 10);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(720);
});

test('a reload jump to the top keeps the offset queued by scrolling', () => {
  const { scroll, remembered } = memory();
  scroll.noteScroll(836);
  scroll.capture(0);
  expect(remembered.at(-1)).toEqual({ id: 'index', y: 836 });
});

test('a saved history offset is used when this document has not seen that visit', () => {
  const { scroll, writes, visit } = memory();
  scroll.prepareForTraversal('earlier', 640, 0);
  scroll.show(visit);
  expect(writes.at(-1)).toBe(640);
});
