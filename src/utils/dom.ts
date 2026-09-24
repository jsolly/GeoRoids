import { logger } from './Logger';

type EventCallback = ((ev: Event) => void) | ((ev: Event) => Promise<void>);

export function attachEventListener<T extends HTMLElement>(
  element: T | null,
  eventType: string,
  callback: EventCallback
): void {
  if (element) {
    element.addEventListener(eventType, (ev) => {
      const result = callback(ev);
      if (result instanceof Promise) {
        result.catch((error) => logger.error('UTILS', `Async callback error: ${String(error)}`));
      }
    });
  } else {
    logger.error('UTILS', `Unable to attach event listener, element not found`);
  }
}

export function getElementById<T extends HTMLElement>(id: string): T | null {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (!element) {
    logger.error('UTILS', `Element with id '${id}' not found`);
  }
  return element as T | null;
}
