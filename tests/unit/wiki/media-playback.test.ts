import { describe, expect, test } from 'vitest';
import { setMediaSource, shouldAutoplayMedia } from '../../../src/wiki/mediaPlayback';

describe('Wiki demonstration playback', () => {
  test.each([
    [false, false, true],
    [true, false, false],
    [false, true, false],
    [true, true, false],
  ])(
    'autoplay is allowed only for a visible page without reduced motion (%s, %s)',
    (reducedMotion, hidden, expected) => {
      expect(shouldAutoplayMedia(reducedMotion, hidden)).toBe(expected);
    }
  );

  test('autoplay and reduced-motion fallback keep the image source in sync', () => {
    document.body.innerHTML = '<img alt="" src="/wiki/media/hauler.png" />';
    const image = document.querySelector('img');
    if (!image) {
      throw new Error('Playback fixture did not render');
    }

    setMediaSource(image, 'hauler', true);
    expect(image.getAttribute('src')).toBe('/wiki/media/hauler.gif');

    setMediaSource(image, 'hauler', false);
    expect(image.getAttribute('src')).toBe('/wiki/media/hauler.png');
  });
});
