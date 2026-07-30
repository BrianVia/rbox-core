/**
 * The state-authority coordinator (design 222 §1.3).
 *
 * Genesis and migration never see each other: `genesis.ts` imports nothing from
 * `migration/`, `migration/**` imports nothing from `genesis.ts`, and this is
 * the one module permitted to import both (§7.9). It carries no protocol of its
 * own — it asks genesis whether the workspace is its business, and otherwise
 * runs migration.
 *
 * It also owns the state-plane write fence, because the fence is one policy
 * spanning both domains and the boundary gate leaves exactly one module able to
 * express it.
 */
import { randomBytes } from "node:crypto";
import { StateAuthorityCorruptError, StateWriteRefusedError } from "./errors.js";
import * as genesis from "./genesis.js";
import type { GenesisIds, GenesisInspection, GenesisOutcome } from "./genesis.js";
// Not from `genesis.js`: the fence's reachable graph must contain no SQLite.
import { readGenesisIntent } from "./genesis-intent.js";
import type { EntryProof } from "./locks.js";
import type { MigrationOutcome } from "./migration/authority.js";
import { blocksSqliteWrites } from "./migration/control-codec.js";
import { readCanonicalControl } from "./migration/control-publication.js";
import { statePath } from "./paths.js";

/** M-9's `runMigration`, with its progress sink already bound by the entry site
 * (lane 2D's amendment 2: genesis has no progress surface, so a sink on this
 * module's signature would be a parameter only one branch reads).
 *
 * Wave 5A collapsed 2D's `MigrationDriver<M>`/`AuthorityOutcome<M>` generics onto
 * the real `MigrationOutcome`, which `migration/authority.ts` now declares. It
 * stays an INJECTED function rather than a direct call: binding the sink is the
 * entry site's job, and injection is what lets the coordinator's own tests drive
 * the dispatch and the C8 re-inspect without standing up a whole migration. The
 * duplicate-declaration gate confirms `MigrationOutcome` is declared exactly
 * once, in the module that owns the protocol. */
export type MigrationDriver = (root: string, entry: EntryProof) => Promise<MigrationOutcome>;

export type AuthorityOutcome =
  | { readonly domain: "genesis"; readonly outcome: GenesisOutcome }
  | { readonly domain: "migration"; readonly outcome: MigrationOutcome };

/**
 * The one thing both entry points call, under an already-held lock bundle
 * (§3.2: the caller wraps this in `withStatePlaneLocks` and passes the proof).
 *
 * One re-inspect, for the one outcome that changes the answer (§1.3 C8). A
 * genesis attempt that finds an `L` has appeared refuses `legacy-present` after
 * removing its own artifacts and retiring its intent — which leaves an ordinary
 * migration candidate. Dispatching again in the same pass is what makes
 * §6.1's "run `rbox migrate`" true. A second genesis claim is impossible once
 * the intent is gone, so it is corruption rather than a third pass.
 */
export async function establishStateAuthority(
  root: string, entry: EntryProof, runMigration: MigrationDriver,
): Promise<AuthorityOutcome> {
  const first = await dispatch(root, entry, runMigration);
  if (!isLegacyPresent(first)) return first;

  const second = await dispatch(root, entry, runMigration);
  if (second.domain === "genesis") {
    throw new StateAuthorityCorruptError(
      statePath(root),
      "genesis claimed this workspace again after retiring its intent over legacy JSON",
    );
  }
  return second;
}

/**
 * The state-plane write fence, as ONE exported predicate, called at the SQLite
 * save boundary under the already-held state lock.
 *
 * A durable migration control that blocks writes and an unretired genesis
 * intent are the same policy — authority recovery has not finished — so they
 * are one branch and one refusal reason.
 *
 * FILE-LEVEL ONLY, NEVER A SQLITE OPEN (163 v13, lane 2D). This runs on every
 * SQLite save. A read-only open creates `-wal`/`-shm` on its first read and
 * cannot remove them, so an open here would deposit debris on the hot path and
 * manufacture the very at-rest violation 163 halts over.
 *
 * Both readers are deliberately imported from modules whose import graphs
 * contain no `bun:sqlite`, which is what makes an open here unreachable rather
 * than merely absent — a snapshot cannot see an open that checkpoints and
 * removes its own sidecars before returning. `authority-bootstrap.test.ts`
 * walks that graph and carries 163 v13's read-only-open negative control.
 */
export function assertAuthorityWritable(root: string): void {
  const control = readCanonicalControl(root);
  if (control && blocksSqliteWrites(control)) {
    refuse(root, `migration ${control.migrationId} is at ${control.witness.phase}`);
  }
  const intent = readGenesisIntent(root);
  if (intent) refuse(root, `genesis attempt ${intent.authorityId} has not been retired`);
}

async function dispatch(
  root: string, entry: EntryProof, runMigration: MigrationDriver,
): Promise<AuthorityOutcome> {
  if (claimsGenesis(root, await genesis.inspect(root, entry.locks))) {
    return { domain: "genesis", outcome: await genesis.establish(root, mintIds, entry.locks) };
  }
  return { domain: "migration", outcome: await runMigration(root, entry) };
}

/** §1.3: genesis claims a workspace with no authority and no migration control,
 * or one carrying an exact genesis intent. `genesis.inspect` answers the first
 * half and leaves the control to its caller, so the control read lives here —
 * the boundary forbids genesis from performing it. */
function claimsGenesis(root: string, inspection: GenesisInspection): boolean {
  if (inspection.intent) return true;
  return inspection.claims && readCanonicalControl(root) === undefined;
}

/** Fresh ids for a fresh attempt. Genesis calls this at most once and never on
 * a resume, where the intent is the sole source of both ids (§2.4). */
function mintIds(): GenesisIds {
  return { authorityId: hex32(), lineageId: hex32() };
}

function hex32(): string {
  return randomBytes(16).toString("hex");
}

function isLegacyPresent(outcome: AuthorityOutcome): boolean {
  return outcome.domain === "genesis"
    && outcome.outcome.kind === "refused"
    && outcome.outcome.reason === "legacy-present";
}

function refuse(root: string, detail: string): never {
  throw new StateWriteRefusedError("authority-recovery-pending", statePath(root), detail);
}
