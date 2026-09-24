let open = false;
let closeStore: (() => void) | undefined;

export function isTownStoreOpen(): boolean {
  return open;
}

export function setTownStoreOpen(next: boolean): void {
  open = next;
}

export function bindTownStoreClose(close: () => void): void {
  closeStore = close;
}

export function requestTownStoreClose(): void {
  closeStore?.();
}
