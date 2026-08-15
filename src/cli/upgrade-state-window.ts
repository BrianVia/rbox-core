/**
 * Retired SP-3 upgrade conversion window.
 *
 * The automatic caller was removed from `upgrade-cmd.ts`; explicit
 * `rbox migrate` is now the only migration entry. This file and export remain
 * through SP-3 so SP-4 can perform closure-complete deletion with package,
 * automation, documentation, and support-window evidence.
 */

export interface StateWindowOutcome {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/**
 * Compatibility export for test/embedding inventories. Production has no
 * import path to it, and invoking it performs no state-plane read or mutation.
 */
export async function migrateStateInUpgradeWindow(
  _root: string,
  _key: string,
): Promise<StateWindowOutcome> {
  return { ok: true, lines: [] };
}
