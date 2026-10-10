/** Notify the shell synchronously; it owns DOM visibility and body modes. */
export function setPlayView(inPlay: boolean): void {
  window.dispatchEvent(new CustomEvent(inPlay ? 'playViewOn' : 'playViewOff'));
}
