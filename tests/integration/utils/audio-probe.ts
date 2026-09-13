import type { Page } from 'playwright';

/** Observe real media playback; preserve the browser implementation and rejection behavior. */
export async function installAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('soundOn', 'true');
    const original = HTMLMediaElement.prototype.play;
    const media = new Set<HTMLMediaElement>();
    const updateActive = () => {
      document.documentElement.dataset['activeAudio'] = String(
        [...media].filter((audio) => !audio.paused).length
      );
    };
    const events: Array<{ src: string; rate: number; preservesPitch: boolean }> = [];
    HTMLMediaElement.prototype.play = function () {
      if (!media.has(this)) {
        media.add(this);
        this.addEventListener('pause', updateActive);
        this.addEventListener('ended', updateActive);
      }
      const result = original.call(this);
      void result.then(
        () => {
          updateActive();
          events.push({
            src: this.src,
            rate: this.playbackRate,
            preservesPitch: this.preservesPitch,
          });
          document.documentElement.dataset['audioEvents'] = JSON.stringify(events);
        },
        () => {}
      );
      return result;
    };
  });
}
