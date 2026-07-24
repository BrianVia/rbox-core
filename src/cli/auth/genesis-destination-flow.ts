
import { promptCheckbox, promptConfirm, promptSelect, type CheckboxPrompt } from "../prompt.js";
import { type AtomicGenesisDestinationSetContext, type AtomicGenesisDestinationSetResult } from "../e2ee-client.js";
import { canonicalString, randomBytes, sha256Hex, toB64url, utf8 } from "../../engine/e2ee/index.js";
import { rboxBanner } from "../wordmark.js";
import { stderrStyle } from "../style.js";
import { defaultKitPath, displayPath, invalidateOnePasswordArtifact, readPlaintextKit, recordOnePasswordArtifact, writeRecoveryKit } from "../recovery-kit.js";
import { foldDestinationProgress, type DestinationCompletion, type DestinationSetCompletionIntent, type RecoveryDestination } from "../genesis-durable.js";
import { probeKeychainKit, type KeychainArtifact } from "../recovery-kit-keychain.js";
import { type CompletionIntent, type ValidatedStagedRecoveryKey } from "../genesis-seam.js";
import { createOnePasswordRecoveryItem, detectOnePasswordCli, listOnePasswordAccounts, listOnePasswordVaults, reconcileOnePasswordRecoveryItem, verifyOnePasswordRecoveryItem, type OnePasswordDiscovery, type OnePasswordLocator, type OnePasswordProvider } from "../recovery-kit-1password.js";
import { clearRecoverySecretClipboard, copyRecoverySecretToClipboard } from "../recovery-secret-clipboard.js";


import { actionableKeychainOfferTarget } from "./recovery-kit-flow.js";

type GenesisDestinationChoice = "onepassword" | "keychain" | "kit-path" | "clipboard";

export interface GenesisDestinationFlowDeps {
  checkbox?: CheckboxPrompt;
  select?: typeof promptSelect;
  confirm?: typeof promptConfirm;
  writeStderr?: (text: string) => void;
  detectOnePassword?: typeof detectOnePasswordCli;
  listOnePasswordAccounts?: typeof listOnePasswordAccounts;
  listOnePasswordVaults?: typeof listOnePasswordVaults;
  reconcileOnePassword?: typeof reconcileOnePasswordRecoveryItem;
  createOnePassword?: typeof createOnePasswordRecoveryItem;
  verifyOnePassword?: typeof verifyOnePasswordRecoveryItem;
  copyClipboard?: typeof copyRecoverySecretToClipboard;
  clearClipboard?: typeof clearRecoverySecretClipboard;
}

// Copy shaped by two founder field-review rounds (2026-07-23): one clear task,
// heading bright, two short sentences, no security essay. Cut material lives in
// design 187 for docs/web use.
const genesisRecoveryLeadIn = (): string => `
${stderrStyle.bold("Protect your files")}

rbox encrypts files before they leave this machine. Save your recovery
phrase so you can restore access later.

Your files on this machine stay unchanged.
`;

function destinationKinds(destinations: readonly RecoveryDestination[]): Set<GenesisDestinationChoice> {
  return new Set(destinations.map((destination) => destination.kind));
}

export async function chooseGenesisDestinationIntent(args: {
  accountId: string;
  requestSha256: string;
  now: number;
  keychainTarget?: KeychainArtifact;
  filePath: string;
  fixed?: RecoveryDestination[];
  opDiscovery?: OnePasswordDiscovery;
  deps?: GenesisDestinationFlowDeps;
}): Promise<DestinationSetCompletionIntent> {
  const deps = args.deps ?? {};
  const checkbox = deps.checkbox ?? promptCheckbox;
  const select = deps.select ?? promptSelect;
  const write = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const fixed = args.fixed ?? [];
  const fixedKinds = destinationKinds(fixed);
  const discovery = args.opDiscovery ?? await (deps.detectOnePassword ?? detectOnePasswordCli)();

  write(rboxBanner() + genesisRecoveryLeadIn());
  // No "1Password CLI not found" notice here (founder cut, 2026-07-23): when op
  // is absent the option simply doesn't appear, and the clipboard flow already
  // says "paste it into your password manager now" at the moment that matters.

  for (;;) {
    const selected = await checkbox<GenesisDestinationChoice>({
      // The TUI renders its own key-hint line — do not embed one in the message.
      message: "Save it in one or more places:",
      choices: [
        ...(discovery.state === "available" ? [{
          name: "1Password",
          value: "onepassword" as const,
          description: "creates a secure item in a vault you choose",
          checked: fixedKinds.has("onepassword"),
          disabled: fixedKinds.has("onepassword") ? "already saved" : false,
        }] : []),
        ...(args.keychainTarget ? [{
          name: "macOS Keychain",
          value: "keychain" as const,
          description: "saves on this Mac; it does not sync through iCloud",
          checked: fixedKinds.has("keychain") || fixed.length === 0,
          disabled: fixedKinds.has("keychain") ? "already saved" : false,
        }] : []),
        {
          name: "Plain-text file",
          value: "kit-path" as const,
          // The exact path prints after the save succeeds — not here.
          description: "Protect it like a password.",
          checked: fixedKinds.has("kit-path") || fixed.length === 0 && !args.keychainTarget,
          disabled: fixedKinds.has("kit-path") ? "already saved" : false,
        },
        {
          name: "Copy to clipboard",
          value: "clipboard" as const,
          // Exposure disclosure moved to copy time, where it matters.
          checked: fixedKinds.has("clipboard"),
          disabled: fixedKinds.has("clipboard") ? "already saved" : false,
        },
      ],
      validate: (values) => values.length + fixed.length > 0 || "Choose at least one place to save the phrase.",
    });

    const requested = new Set<GenesisDestinationChoice>([...fixedKinds, ...selected]);
    const destinations: RecoveryDestination[] = [];
    if (requested.has("onepassword")) {
      const existing = fixed.find((destination) => destination.kind === "onepassword");
      if (existing) {
        destinations.push(existing);
      } else {
        if (discovery.state !== "available") continue;
        write("\n1Password may ask you to sign in or approve access.\n");
        const provider: OnePasswordProvider = { executable: discovery.executable, env: process.env };
        const accountResult = await (deps.listOnePasswordAccounts ?? listOnePasswordAccounts)(provider);
        if (accountResult.state !== "ok" || accountResult.accounts.length === 0) {
          write("\nNo 1Password account is available to the CLI. Sign in or add an account in the 1Password app/CLI, then try again.\n");
          continue;
        }
        const accountUuid = accountResult.accounts.length === 1
          ? accountResult.accounts[0]!.uuid
          : await select<string>({
              message: "Choose a 1Password account:",
              choices: accountResult.accounts.map((account) => ({ name: account.label, value: account.uuid })),
            });
        const vaultResult = await (deps.listOnePasswordVaults ?? listOnePasswordVaults)(provider, accountUuid);
        if (vaultResult.state !== "ok" || vaultResult.vaults.length === 0) {
          write("\nNo writable 1Password vault is available. Choose another save method or try again.\n");
          continue;
        }
        const back = "__rbox_back__";
        const vaultUuid = await select<string>({
          message: "Choose a 1Password vault:",
          choices: [
            ...vaultResult.vaults.map((vault) => ({ name: vault.label, value: vault.uuid })),
            { name: "← Choose another save method", value: back },
          ],
        });
        if (vaultUuid === back) continue;
        destinations.push({
          kind: "onepassword",
          accountUuid,
          vaultUuid,
          operationTag: `rbox_${toB64url(randomBytes(12))}`,
          fieldId: "rboxRecoveryPhrase",
        });
      }
    }
    if (requested.has("keychain") && args.keychainTarget) {
      const existing = fixed.find((destination) => destination.kind === "keychain");
      destinations.push(existing ?? {
        kind: "keychain",
        service: args.keychainTarget.service,
        account: args.keychainTarget.account,
        keychainPath: args.keychainTarget.keychainPath,
      });
    }
    if (requested.has("kit-path")) {
      const existing = fixed.find((destination) => destination.kind === "kit-path");
      destinations.push(existing ?? { kind: "kit-path", path: args.filePath });
    }
    if (requested.has("clipboard")) destinations.push({ kind: "clipboard" });
    return {
      version: 2,
      accountId: args.accountId,
      requestSha256: args.requestSha256,
      mode: "destination-set",
      destinations,
      successThreshold: 1,
      intentAt: new Date(args.now).toISOString(),
    };
  }
}

function destinationLabel(destination: RecoveryDestination): string {
  if (destination.kind === "onepassword") return "1Password";
  if (destination.kind === "keychain") return "macOS Keychain";
  if (destination.kind === "kit-path") return "plain-text file";
  return "Clipboard";
}

export async function completeGenesisDestinationSet(
  initial: AtomicGenesisDestinationSetContext,
  creds: { accountId: string; deviceId: string },
  keychainCompletion: GenesisRecoveryKitCompletionDeps,
  deps: GenesisDestinationFlowDeps = {}
): Promise<AtomicGenesisDestinationSetResult> {
  const confirm = deps.confirm ?? promptConfirm;
  const select = deps.select ?? promptSelect;
  const write = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  let context = initial;
  let continuedAfterPartial = false;
  const eventAt = (): string => {
    const current = new Date().toISOString();
    return current < context.progress.updatedAt ? context.progress.updatedAt : current;
  };

  for (;;) {
    const folded = await foldDestinationProgress(context.intent, context.progress.events);
    const liveValid = new Set<number>();
    const failed = new Map<number, string>();

    for (let index = 0; index < context.intent.destinations.length; index++) {
      const destination = context.intent.destinations[index]!;
      const prior = folded.completions[index];
      if (prior) {
        let state: "valid" | "invalid" | "unverifiable" = "valid";
        // Distinguish authoritative-missing from authoritative-mismatch so the
        // durable invalidation records the real reason (MINOR 6).
        let invalidReason: "missing" | "mismatch" = "missing";
        if (prior.kind === "keychain") {
          const probe = await probeKeychainKit(prior);
          state = probe === "present" ? "valid" : probe === "missing" ? "invalid" : "unverifiable";
          invalidReason = "missing";
        } else if (prior.kind === "kit-path") {
          const probe = await readPlaintextKit(prior.path);
          if (probe.state === "present" && probe.accountId === creds.accountId && probe.phrase === context.phrase) state = "valid";
          else if (probe.state === "missing") { state = "invalid"; invalidReason = "missing"; }
          else if (probe.state === "present" || probe.state === "unrecognized") { state = "invalid"; invalidReason = "mismatch"; }
          else state = "unverifiable";
        } else if (prior.kind === "onepassword") {
          const discovery = await (deps.detectOnePassword ?? detectOnePasswordCli)();
          if (discovery.state !== "available") state = "unverifiable";
          else {
            const expected = Buffer.from(context.phrase, "utf8");
            try {
              const verification = await (deps.verifyOnePassword ?? verifyOnePasswordRecoveryItem)(
                { executable: discovery.executable, env: process.env },
                prior,
                expected
              );
              state = verification === "valid" ? "valid" : verification === "mismatch" ? "invalid" : "unverifiable";
              invalidReason = "mismatch";
            } finally {
              expected.fill(0);
            }
          }
        }
        if (state === "valid") {
          liveValid.add(index);
          continue;
        }
        if (state === "invalid") {
          if (prior.kind === "onepassword") {
            await invalidateOnePasswordArtifact(creds.accountId, {
              rboxAccountId: creds.accountId,
              accountUuid: prior.accountUuid,
              vaultUuid: prior.vaultUuid,
              itemUuid: prior.itemUuid,
              fieldId: prior.fieldId,
              operationTag: prior.operationTag,
            }, invalidReason);
          }
          context.progress = await context.append({
            kind: "invalidated",
            destinationIndex: index,
            priorCompletionSha256: await sha256Hex(utf8(canonicalString(prior))),
            reason: invalidReason,
            at: eventAt(),
          });
        } else {
          failed.set(index, "couldn't verify the existing copy");
          continue;
        }
      }

      try {
        let completion: DestinationCompletion | undefined;
        if (destination.kind === "keychain") {
          await keychainCompletion.saveKeychain(context.phrase, {
            version: 1,
            accountId: context.intent.accountId,
            requestSha256: context.intent.requestSha256,
            mode: "keychain",
            keychain: destination,
            intentAt: context.intent.intentAt,
          });
          completion = { ...destination, kind: "keychain", completedAt: eventAt() };
        } else if (destination.kind === "kit-path") {
          const written = await writeRecoveryKit(context.phrase, creds, destination.path);
          if (written.recordError) throw written.recordError;
          completion = { ...destination, kind: "kit-path", completedAt: eventAt() };
        } else if (destination.kind === "clipboard") {
          write("\nClipboard history, other apps, or cross-device clipboard sync may retain this phrase.\nPaste it into your password manager now; rbox will clear the clipboard when you confirm.\n");
          const copied = await (deps.copyClipboard ?? copyRecoverySecretToClipboard)(context.phrase);
          if (!copied.ok) throw new Error("clipboard copy failed");
          if (!(await confirm({ message: "Have you pasted and saved the phrase somewhere durable?", default: false }))) {
            // The phrase is on the clipboard; best-effort clear it before we bail
            // so declining doesn't leave it lingering there (the disclosure said
            // rbox clears the clipboard). Failure to clear is non-fatal here.
            await (deps.clearClipboard ?? clearRecoverySecretClipboard)().catch(() => {});
            throw new Error("not yet confirmed saved");
          }
          const cleared = await (deps.clearClipboard ?? clearRecoverySecretClipboard)();
          if (!cleared.ok && !(await confirm({ message: "rbox couldn't clear the clipboard. Have you cleared it yourself?", default: false }))) {
            throw new Error("clipboard was not cleared");
          }
          completion = { kind: "clipboard", confirmedAt: eventAt() };
        } else {
          const discovery = await (deps.detectOnePassword ?? detectOnePasswordCli)();
          if (discovery.state !== "available") throw new Error("1Password CLI is unavailable");
          const provider: OnePasswordProvider = { executable: discovery.executable, env: process.env };
          const reconciliation = await (deps.reconcileOnePassword ?? reconcileOnePasswordRecoveryItem)(provider, destination);
          let locator: OnePasswordLocator | undefined;
          if (reconciliation.state === "found") {
            if (!folded.attempts[index]) throw new Error("unexpected untracked 1Password item");
            locator = reconciliation.locator;
          } else if (reconciliation.state === "missing") {
            const attempt = folded.attempts[index];
            // Fail closed: once an attempt reached may-have-dispatched, an item
            // might exist in the vault even though we can't see it, so we never
            // create a second one. A plain Retry can't get past this — tell the
            // user to pick "Change incomplete choices" to set up 1Password again.
            if (attempt && attempt.state !== "child-not-started") throw new Error('1Password didn\'t confirm the earlier save. Choose "Change incomplete choices" to set up 1Password again — rbox won\'t create a duplicate');
            const attemptId = `op_${toB64url(randomBytes(12))}`;
            context.progress = await context.append({ kind: "op-dispatch-prepared", destinationIndex: index, attemptId, at: eventAt() });
            context.progress = await context.append({ kind: "op-may-have-dispatched", destinationIndex: index, attemptId, at: eventAt() });
            const created = await (deps.createOnePassword ?? createOnePasswordRecoveryItem)(provider, {
              ...destination,
              rboxAccountId: creds.accountId,
              phrase: context.phrase,
            });
            if (created.state === "child-not-started") {
              context.progress = await context.append({ kind: "op-child-not-started", destinationIndex: index, attemptId, reason: created.reason, at: eventAt() });
              throw new Error("1Password CLI could not start");
            }
            if (created.state !== "created") throw new Error('1Password didn\'t confirm the save. Choose "Change incomplete choices" to set up 1Password again — rbox won\'t create a duplicate');
            locator = created.locator;
          } else {
            throw new Error(reconciliation.state === "ambiguous"
              ? "multiple matching 1Password items need attention"
              : "1Password is unavailable");
          }
          const expected = Buffer.from(context.phrase, "utf8");
          try {
            const verification = await (deps.verifyOnePassword ?? verifyOnePasswordRecoveryItem)(provider, locator, expected);
            if (verification !== "valid") throw new Error(verification === "mismatch" ? "1Password item did not match" : "1Password item could not be verified");
          } finally {
            expected.fill(0);
          }
          const completedAt = eventAt();
          await recordOnePasswordArtifact(creds.accountId, {
            rboxAccountId: creds.accountId,
            ...locator,
            writtenAt: completedAt,
            state: "active",
          });
          completion = { ...locator, kind: "onepassword", completedAt };
        }
        // Derive the event's `at` from the completion's own timestamp instead of
        // sampling the clock a second time — a second sample can land in a later
        // millisecond (e.g. across the 1Password locator write) and there is no
        // integrity reason for them to differ.
        const completedAt = completion.kind === "clipboard" ? completion.confirmedAt : completion.completedAt;
        context.progress = await context.append({ kind: "completed", destinationIndex: index, completion, at: completedAt });
        liveValid.add(index);
      } catch (error) {
        failed.set(index, error instanceof Error ? error.message : "couldn't complete the save");
      }
    }

    if (liveValid.size === context.intent.destinations.length) {
      write(`\n✓ Recovery phrase saved to ${liveValid.size === 1 ? destinationLabel(context.intent.destinations[0]!) : `${liveValid.size} selected places`}\n`);
      for (const index of [...liveValid].sort((a, b) => a - b)) {
        const destination = context.intent.destinations[index]!;
        if (destination.kind === "kit-path") write(`  ${displayPath(destination.path)}\n`);
      }
      return { intent: context.intent, progress: context.progress, liveValidDestinationIndexes: [...liveValid], continuedAfterPartial };
    }

    write(`\nSaved recovery phrase to ${liveValid.size} of ${context.intent.destinations.length} selected places:\n`);
    for (let index = 0; index < context.intent.destinations.length; index++) {
      const destination = context.intent.destinations[index]!;
      write(`  ${liveValid.has(index) ? "✓" : "!"} ${destinationLabel(destination)}${failed.has(index) ? ` — ${failed.get(index)}` : ""}\n`);
    }
    const action = liveValid.size === 0
      ? await select<"retry" | "change">({
          message: "No durable recovery copy is complete yet. What do you want to do?",
          choices: [
            { name: "Retry incomplete choices", value: "retry" },
            { name: "Change incomplete choices", value: "change" },
          ],
        })
      : await select<"retry" | "continue" | "change">({
          message: "What do you want to do?",
          choices: [
            { name: "Retry failed choices", value: "retry" },
            { name: "Continue with the successful copies", value: "continue" },
            { name: "Change incomplete choices", value: "change" },
          ],
        });
    if (action === "retry") continue;
    if (action === "continue") {
      if (await confirm({ message: "Continue setup with only the successful recovery copies?", default: false })) {
        continuedAfterPartial = true;
        return { intent: context.intent, progress: context.progress, liveValidDestinationIndexes: [...liveValid], continuedAfterPartial };
      }
      continue;
    }

    // If an incomplete 1Password choice ever reached may-have-dispatched, an item
    // might already exist in the vault even though rbox can't confirm it. Say so
    // without claiming it is absent (design 187 failure semantics) before the user
    // replaces that choice.
    const maybeOrphanedOnePassword = context.intent.destinations.some((destination, index) =>
      destination.kind === "onepassword" && !liveValid.has(index)
      && folded.attempts[index] !== undefined && folded.attempts[index]!.state !== "child-not-started");
    if (maybeOrphanedOnePassword) {
      write("\nNote: an earlier 1Password save may have created an item rbox can't confirm.\nrbox won't remove it — check 1Password and delete any extra \"rbox recovery phrase\" item you don't want.\n");
    }

    const fixed = [...liveValid].map((index) => context.intent.destinations[index]!);
    let keychainTarget: KeychainArtifact | undefined = context.intent.destinations.find(
      (destination): destination is Extract<RecoveryDestination, { kind: "keychain" }> => destination.kind === "keychain"
    );
    if (!keychainTarget && process.platform === "darwin") {
      try { keychainTarget = await actionableKeychainOfferTarget(creds.accountId) } catch {}
    }
    const replacement = await chooseGenesisDestinationIntent({
      accountId: context.intent.accountId,
      requestSha256: context.intent.requestSha256,
      now: Date.now(),
      keychainTarget,
      filePath: context.intent.destinations.find((destination): destination is Extract<RecoveryDestination, { kind: "kit-path" }> => destination.kind === "kit-path")?.path ?? await defaultKitPath(creds.accountId),
      fixed,
      deps,
    });
    const newIndexByKind = new Map(replacement.destinations.map((destination, index) => [destination.kind, index]));
    const carriedCompletions = await Promise.all([...liveValid].map(async (oldDestinationIndex) => {
      const completion = folded.completions[oldDestinationIndex]!;
      return {
        oldDestinationIndex,
        newDestinationIndex: newIndexByKind.get(completion.kind)!,
        completionSha256: await sha256Hex(utf8(canonicalString(completion))),
      };
    }));
    context = { ...context, ...(await context.replace({ newIntent: replacement, carriedCompletions, liveValidOldIndexes: [...liveValid] })) };
  }
}

export interface GenesisRecoveryKitCompletionDeps {
  select(phrase: string, staged: ValidatedStagedRecoveryKey): Promise<CompletionIntent>;
  validatePhrase(phrase: string): Promise<void>;
  displayPhrase(phrase: string, intent: Extract<CompletionIntent, { mode: "phrase-display" }>): Promise<void>;
  saveKeychain(phrase: string, intent: Extract<CompletionIntent, { mode: "keychain" }>): Promise<void>;
  saveFile(phrase: string, intent: Extract<CompletionIntent, { mode: "kit-path" }>): Promise<void>;
  retargetAfterKeychainFailure?(phrase: string, intent: Extract<CompletionIntent, { mode: "keychain" }>): Promise<Extract<CompletionIntent, { mode: "kit-path" }> | undefined>;
  offerClaimed?(accountId: string): Promise<boolean>;
}
