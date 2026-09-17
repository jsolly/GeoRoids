import { getElementById } from '../utils/dom';

export function toggleScreen(id: string, toggle: boolean): void {
  const element = getElementById<HTMLElement>(id);
  if (element) {
    element.hidden = !toggle;
    element.style.display = toggle ? 'block' : 'none';
  }
}

/** Show the play canvas and hide title chrome (Freepik/version stock credit). */
export function setPlayView(inPlay: boolean): void {
  toggleScreen('gameArea', inPlay);
  toggleScreen('start-screen', !inPlay);
  if (typeof document !== 'undefined') {
    document.body.classList.toggle('in-play', inPlay);
    if (!inPlay) {
      document.body.classList.remove('touch-play');
    }
    window.dispatchEvent(new CustomEvent(inPlay ? 'playViewOn' : 'playViewOff'));
  }
}
