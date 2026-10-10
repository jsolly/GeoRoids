export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

export type WithoutChildrenOrChild<T> = Omit<T, 'children' | 'child'>;
