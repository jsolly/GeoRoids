function isInPlay(): boolean {
  return typeof document !== 'undefined' && document.body.classList.contains('in-play');
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  );
}

function suppressPlayfieldGesture(ev: Event): void {
  if (!isInPlay() || isEditableTarget(ev.target) || !ev.cancelable) {
    return;
  }
  ev.preventDefault();
}

function collapsePlayfieldSelection(): void {
  if (!isInPlay() || typeof document === 'undefined') {
    return;
  }
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }
  const anchor = selection.anchorNode;
  const node = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  if (isEditableTarget(node)) {
    return;
  }
  selection.removeAllRanges();
}

let listenersInitialized = false;

/** Keep iOS highlight/copy banners off the playfield while still allowing form fields. */
export function initializePlayfieldSelection(): void {
  if (typeof document === 'undefined' || listenersInitialized) {
    return;
  }
  document.addEventListener('selectstart', suppressPlayfieldGesture);
  document.addEventListener('contextmenu', suppressPlayfieldGesture);
  document.addEventListener('selectionchange', collapsePlayfieldSelection);
  listenersInitialized = true;
}
