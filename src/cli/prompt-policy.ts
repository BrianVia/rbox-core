import { AsyncLocalStorage } from "node:async_hooks";

export interface InteractionPolicy {
  enabled: boolean;
}

const policies = new AsyncLocalStorage<InteractionPolicy>();

export function currentInteractionPolicy(): InteractionPolicy {
  return policies.getStore() ?? { enabled: true };
}

export function withInteractionPolicy<T>(policy: InteractionPolicy, run: () => T): T {
  return policies.run(policy, run);
}

export function interactionPolicyForArgv(argv: readonly string[]): InteractionPolicy {
  return { enabled: !argv.includes("--no-interactive") };
}
