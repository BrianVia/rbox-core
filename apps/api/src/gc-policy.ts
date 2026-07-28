export const GC_BUDGET_SAFE = 800;
export const GC_FIXED_COST = 10;
export const GC_PER_EXECUTE = 5;
export const GC_P1_COST = 3;
export const GC_P1_MAX_ROWS = 200;
export const GC_MAX_EXECUTE_ROWS = 200;
export const PER_WORKSPACE_ROOTS_COST = 90;
export const INTENT_QUIESCENCE_MS = 24 * 60 * 60 * 1000;

export function gcExecuteLimit(workspaceCount: number): number {
  return Math.max(
    0,
    Math.min(GC_MAX_EXECUTE_ROWS, Math.floor((GC_BUDGET_SAFE - 1 - workspaceCount * PER_WORKSPACE_ROOTS_COST - GC_FIXED_COST - GC_P1_COST) / GC_PER_EXECUTE)),
  );
}
