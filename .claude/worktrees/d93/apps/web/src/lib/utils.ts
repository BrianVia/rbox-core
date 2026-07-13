import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class lists, resolving Tailwind conflicts (last wins). */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Prop-type helpers the shadcn-svelte components rely on (mirror bits-ui's shapes). */
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
