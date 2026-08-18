/**
 * Lexically confined ownership for the DB-artifact reset executors.
 *
 * The raw token is never returned or exported as a value.  Binding a complete
 * executor set produces closures that retain it, while the WeakSets below
 * authenticate both executor calls and the public facade.
 *
 * Never: reset implementation, format-conversion policy, or an exported token/construction key.
 */
import {
  beginSqliteReset,
  inspectSqliteReset,
  observeSqliteResetControlPlane,
  observeSqliteResetJournal,
  recoverSqliteReset,
} from "./recovery.js";

declare const dbArtifactResetExecutorCapabilityBrand: unique symbol;
export interface DbArtifactResetExecutorCapability {
  readonly kind: "db-artifact-reset-executor/v1";
  readonly [dbArtifactResetExecutorCapabilityBrand]: true;
}

type AnyExecutor = (
  capability: DbArtifactResetExecutorCapability,
  ...args: never[]
) => unknown;

interface DbArtifactResetExecutorSet {
  readonly begin: AnyExecutor;
  readonly inspect: AnyExecutor;
  readonly observeControlPlane: AnyExecutor;
  readonly observeJournal: AnyExecutor;
  readonly recover: AnyExecutor;
}

type BoundExecutor<T> = T extends (
  capability: DbArtifactResetExecutorCapability,
  ...args: infer Args
) => infer Result ? (...args: Args) => Result : never;

export type SqliteResetFacade<T extends DbArtifactResetExecutorSet = DbArtifactResetExecutorSet> = {
  readonly kind: "db-artifact-reset/v1";
  readonly begin: BoundExecutor<T["begin"]>;
  readonly inspect: BoundExecutor<T["inspect"]>;
  readonly observeControlPlane: BoundExecutor<T["observeControlPlane"]>;
  readonly observeJournal: BoundExecutor<T["observeJournal"]>;
  readonly recover: BoundExecutor<T["recover"]>;
};

const TOKENS = new WeakSet<object>();
const REQUIRED_METHODS = Object.freeze([
  "begin",
  "inspect",
  "observeControlPlane",
  "observeJournal",
  "recover",
] as const);

export function assertDbArtifactResetExecutorCapability(
  value: unknown,
): asserts value is DbArtifactResetExecutorCapability {
  if (value === null || typeof value !== "object" || !TOKENS.has(value)) {
    throw new Error("DB-artifact reset executor requires its confined capability");
  }
}

/**
 * Bind all completed U2 exits.  This never returns the token: authority remains
 * captured in the five frozen facade closures.
 */
function bindDbArtifactResetExecutors<const T extends DbArtifactResetExecutorSet>(
  executors: T,
): SqliteResetFacade<T> {
  for (const name of REQUIRED_METHODS) {
    if (typeof executors[name] !== "function") {
      throw new TypeError(`DB-artifact reset executor set is missing ${name}`);
    }
  }
  const token = Object.freeze({
    kind: "db-artifact-reset-executor/v1" as const,
  }) as DbArtifactResetExecutorCapability;
  TOKENS.add(token);
  const facade = Object.freeze({
    kind: "db-artifact-reset/v1" as const,
    begin: (...args: never[]) => executors.begin(token, ...args),
    inspect: (...args: never[]) => executors.inspect(token, ...args),
    observeControlPlane: (...args: never[]) => executors.observeControlPlane(token, ...args),
    observeJournal: (...args: never[]) => executors.observeJournal(token, ...args),
    recover: (...args: never[]) => executors.recover(token, ...args),
  }) as SqliteResetFacade<T>;
  return facade;
}

/** The only bound U2 entry seam. Binding and token construction are lexical to
 * this module; deep importers can use the facade but cannot mint another one. */
export const sqliteResetFacade = bindDbArtifactResetExecutors({
  begin: beginSqliteReset,
  inspect: inspectSqliteReset,
  observeControlPlane: observeSqliteResetControlPlane,
  observeJournal: observeSqliteResetJournal,
  recover: recoverSqliteReset,
});

/**
 * Reports whether this entry arena is fully bound. This is deliberately not a
 * value-authentication API: no exported value is the executor capability.
 * Link failure is the real gate; this predicate cannot be false in a reachable state.
 */
export function hasDbArtifactResetCapability(): boolean {
  const executors = {
    begin: beginSqliteReset,
    inspect: inspectSqliteReset,
    observeControlPlane: observeSqliteResetControlPlane,
    observeJournal: observeSqliteResetJournal,
    recover: recoverSqliteReset,
  } as const;
  return Object.isFrozen(sqliteResetFacade)
    && sqliteResetFacade.kind === "db-artifact-reset/v1"
    && REQUIRED_METHODS.every((name) =>
      typeof sqliteResetFacade[name] === "function"
      && typeof executors[name] === "function");
}
