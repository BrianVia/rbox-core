import path from "node:path";
import type { InitPlan } from "./init-plan.js";
import { loadConfigIfPresent, type WorkspaceConfig } from "./workspace-config.js";
import { observeStateAuthority } from "./state-plane/authority-bootstrap.js";

type NewInitPlan = Pick<InitPlan, "root" | "remoteUrl" | "workspace" | "syncGit" | "respectGitignore" | "scope">;

export interface OrdinaryInitContinuation {
  readonly workspaceId: string;
}

function sameOptionalStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function matches(plan: NewInitPlan, config: WorkspaceConfig | undefined): config is WorkspaceConfig {
  return plan.workspace.kind === "new"
    && config !== undefined
    && config.remoteWorkspaceId.trim().length > 0
    && path.resolve(config.rootPath) === path.resolve(plan.root)
    && config.remoteUrl === plan.remoteUrl
    && config.projectId === plan.workspace.project
    && config.name === plan.workspace.name
    && config.syncGit === plan.syncGit
    && config.respectGitignore === plan.respectGitignore
    && sameOptionalStrings(config.scope, plan.scope);
}

/** Recognize only the exact durable-config/absent-authority retry window. */
export async function ordinaryInitContinuation(
  plan: NewInitPlan,
  consentPresent: boolean,
): Promise<OrdinaryInitContinuation | undefined> {
  if (consentPresent) return undefined;
  const config = await loadConfigIfPresent(plan.root);
  if (!matches(plan, config) || (await observeStateAuthority(plan.root)).kind !== "uninitialized") return undefined;
  return { workspaceId: config.remoteWorkspaceId };
}

/** Revalidate the same window under the command's acquired workspace mutex. */
export async function assertOrdinaryInitContinuation(
  plan: NewInitPlan,
  continuation: OrdinaryInitContinuation,
): Promise<void> {
  const config = await loadConfigIfPresent(plan.root);
  if (!matches(plan, config)
    || config.remoteWorkspaceId !== continuation.workspaceId
    || (await observeStateAuthority(plan.root)).kind !== "uninitialized") {
    throw new Error("the incomplete init binding changed before genesis admission; retry from the current workspace state");
  }
}
