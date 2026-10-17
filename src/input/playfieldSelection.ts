import { getOpenGameOverlay } from '../runtime/overlayState';
import { isPlayViewOn } from '../ui/uiUtils';

function isPlayfieldActive(): boolean {
  return isPlayViewOn() && getOpenGameOverlay() === null;
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
  if (!isPlayfieldActive() || isEditableTarget(ev.target) || !ev.cancelable) {
    return;
  }
  ev.preventDefault();
}

function collapsePlayfieldSelection(): void {
  if (!isPlayfieldActive() || typeof document === 'undefined') {
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
let listenerScope: AbortController | null = null;

/** Keep iOS highlight/copy banners off the playfield while still allowing form fields. */
export function initializePlayfieldSelection(): void {
  if (typeof document === 'undefined' || listenersInitialized) {
    return;
  }
  listenerScope = new AbortController();
  const { signal } = listenerScope;
  document.addEventListener('selectstart', suppressPlayfieldGesture, { signal });
  document.addEventListener('contextmenu', suppressPlayfieldGesture, { signal });
  document.addEventListener('selectionchange', collapsePlayfieldSelection, { signal });
  listenersInitialized = true;
}

export function disposePlayfieldSelection(): void {
  listenerScope?.abort();
  listenerScope = null;
  listenersInitialized = false;
}
