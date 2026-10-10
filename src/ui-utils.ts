export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
