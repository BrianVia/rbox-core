/**
 * Module-private construction capabilities. Deliberately NOT re-exported by
 * `index.ts`: they exist so that a deep import of `owner.js` or `scope.js`
 * cannot mint an authenticated owner, or a scope without the mandated
 * `finally scope.abortAll()`, outside `withGenerationOwnerScope`.
 */
export const OWNER_CONSTRUCTION_KEY = Symbol("rbox.entry-arena.owner-construction");
export type OwnerConstructionKey = typeof OWNER_CONSTRUCTION_KEY;

export const SCOPE_CONSTRUCTION_KEY = Symbol("rbox.entry-arena.scope-construction");
export type ScopeConstructionKey = typeof SCOPE_CONSTRUCTION_KEY;

export function requireConstructionKey<T extends symbol>(presented: unknown, expected: T, what: string): void {
  if (presented !== expected) throw new Error(`${what} is module-private — use withGenerationOwnerScope`);
}
