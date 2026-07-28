import { API } from "typescript/unstable/sync";
import {
  isArrowFunction,
  isAssignmentOperator,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isVariableDeclaration,
} from "typescript/unstable/ast/is";
import path from "node:path";

const mode = process.argv[3];
if (process.argv.length !== 4
  || (mode !== "base-composer-structure" && mode !== "state-plane-inventory")) {
  throw new Error("usage: base-composer-ast-sweep.mjs <repo> <base-composer-structure|state-plane-inventory>");
}

const root = path.resolve(process.argv[2]);
const srcRoot = path.join(root, "src");
const config = path.join(root, "tsconfig.json");
const api = new API({ cwd: root });

const BASE_CALL_CALLEES = new Set([
  "saveState",
  "saveStateUnsafeLegacyOrTest",
  "publishWholeState",
  "writeFileAtomic",
  "fs.writeFile",
  "git",
  "gitRaw",
  "spawn",
]);
const STATE_ORDER_OWNERS = new Map([
  ["src/cli/doctor-cmd.ts", new Set(["checkState"])],
  ["src/cli/reset-journal-doctor.ts", new Set(["quarantineStandingJournal", "withResetJournalDoctorFence"])],
  ["src/cli/reset-journal.ts", new Set([
    "observePhysical",
    "recoverResetJournal",
    "recoverResetJournalUnderHeldFence",
  ])],
  ["src/cli/reset-quarantine.ts", new Set(["restoreResetQuarantineUnderFence"])],
  ["src/cli/reset-state.ts", new Set(["prepareResetArtifactsUnderFence", "resetSyncState"])],
  ["src/cli/state-plane/adapters/legacy-json-publication.ts", new Set([
    "afterStatePublication",
    "publishWholeState",
  ])],
  ["src/cli/sync-state-store.ts", new Set([
    "applyStateSavePacket",
    "ensureTelemetryBindingId",
    "installGenesisResetStateUnderHeldLock",
    "loadRawState",
    "loadState",
    "writeWholeStateUnsafe",
  ])],
]);
const STATE_ORDER_CALLEES = new Set([
  "acquireLock",
  "afterStatePublication",
  "assertStatePublishable",
  "assertStateReadable",
  "ensureStateReserve",
  "fs.rename",
  "fsyncDirectory",
  "isOwner",
  "loadRawState",
  "publishWholeState",
  "recordLastWriterWitness",
  "recoverResetJournalUnderHeldFence",
  "writeFileAtomic",
]);
const STATE_PATH_ARGUMENT = /\bstatePath\(|\bactiveStatePath\(|["']state\.json["']/;
const MARKER_ARGUMENT = /RBOX-SQLITE-AUTHORITY/;

function ownerOf(node) {
  for (let current = node; current; current = current.parent) {
    if (isFunctionDeclaration(current) || isMethodDeclaration(current) || isFunctionExpression(current)) {
      return current.name?.getText() ?? "<anonymous>";
    }
    if (isArrowFunction(current) && isVariableDeclaration(current.parent)) return current.parent.name.getText();
  }
  return "<module>";
}

function argumentTexts(node, source) {
  return node.arguments.map((argument) => argument.getText(source));
}

function fragmentArguments(arguments_, pattern) {
  return arguments_.map((argument) => argument.match(pattern)?.[0] ?? "");
}

function baseComposerCall(node, source) {
  const callee = node.expression.getText(source);
  if (!BASE_CALL_CALLEES.has(callee)) return undefined;
  const arguments_ = argumentTexts(node, source);
  if (callee === "writeFileAtomic" || callee === "fs.writeFile") {
    if (arguments_[0]?.startsWith("statePath(") !== true) return undefined;
    return { category: "call", callee, arguments: ["statePath("] };
  }
  if (callee === "git" || callee === "gitRaw" || callee === "spawn") {
    if (!arguments_.some((argument) => argument.includes("update-ref"))) return undefined;
    return { category: "call", callee, arguments: fragmentArguments(arguments_, /update-ref/) };
  }
  return { category: "call", callee };
}

function statePlaneCall(node, source, file) {
  const callee = node.expression.getText(source);
  const calleeLeaf = callee.split(".").pop();
  const arguments_ = argumentTexts(node, source);
  const hasStatePath = arguments_.some((argument) => STATE_PATH_ARGUMENT.test(argument));
  const hasMarker = arguments_.some((argument) => MARKER_ARGUMENT.test(argument));
  const tracksOrder = STATE_ORDER_OWNERS.get(file)?.has(ownerOf(node)) === true
    && (STATE_ORDER_CALLEES.has(callee) || STATE_ORDER_CALLEES.has(calleeLeaf));
  if (!hasStatePath && !hasMarker && !tracksOrder) return undefined;

  let projected = fragmentArguments(arguments_, STATE_PATH_ARGUMENT);
  if (hasMarker) {
    projected = projected.map((argument, index) =>
      argument || arguments_[index]?.match(MARKER_ARGUMENT)?.[0] || "");
  }
  if (tracksOrder && calleeLeaf === "writeFileAtomic" && arguments_[2] !== undefined) projected[2] = arguments_[2];
  if (tracksOrder && calleeLeaf === "fsyncDirectory" && arguments_[0] !== undefined) projected[0] = arguments_[0];
  return {
    category: "call",
    callee,
    ...(projected.some(Boolean) ? { arguments: projected } : {}),
  };
}

try {
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const project = snapshot.getProject(config);
  if (!project) throw new Error(`TypeScript did not open ${config}`);
  const records = [];
  for (const file of project.program.getSourceFileNames().sort()) {
    if (!file.startsWith(`${srcRoot}${path.sep}`)
      || !file.endsWith(".ts")
      || file.endsWith(".test.ts")
      || file.endsWith(".bench-helper.ts")) continue;
    const source = project.program.getSourceFile(file);
    if (!source) continue;
    const relativeFile = path.relative(root, file);
    const visit = (node) => {
      let shape;
      if (isCallExpression(node)) {
        shape = mode === "base-composer-structure"
          ? baseComposerCall(node, source)
          : statePlaneCall(node, source, relativeFile);
      } else if (mode === "base-composer-structure" && isPropertyAssignment(node)) {
        shape = { category: "property-assignment", name: node.name.getText(source).replace(/["']/g, "") };
      } else if (mode === "base-composer-structure" && isBinaryExpression(node)
        && isAssignmentOperator(node.operatorToken.kind)
        && isPropertyAccessExpression(node.left)) {
        shape = { category: "property-write", name: node.left.name.text };
      } else if (mode === "base-composer-structure"
        && isDeleteExpression(node) && isPropertyAccessExpression(node.expression)) {
        shape = { category: "property-delete", name: node.expression.name.text };
      }
      if (shape && shape.category !== "call"
        && (relativeFile.startsWith("src/cli/") === false
          || !["base", "branchBaseOrigins"].includes(shape?.name))) shape = undefined;
      if (shape) {
        records.push({
          ...shape,
          file: relativeFile,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          ...(mode === "state-plane-inventory" ? { owner: ownerOf(node) } : {}),
        });
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  process.stdout.write(JSON.stringify(records));
} finally {
  api.close();
}
