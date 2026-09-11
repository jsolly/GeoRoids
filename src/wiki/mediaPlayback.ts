export function shouldAutoplayMedia(reducedMotion: boolean, hidden: boolean): boolean {
  return !reducedMotion && !hidden;
}

export function setMediaSource(image: HTMLImageElement, id: string, playing: boolean): void {
  image.src = `/wiki/media/${id}.${playing ? 'gif' : 'png'}`;
}
