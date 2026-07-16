import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
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

const root = path.resolve(process.argv[2]);
const srcRoot = path.join(root, "src");
const config = path.join(root, "tsconfig.json");
const api = new API({ cwd: root });

function ownerOf(node) {
  for (let current = node; current; current = current.parent) {
    if (isFunctionDeclaration(current) || isMethodDeclaration(current) || isFunctionExpression(current)) {
      return current.name?.getText() ?? "<anonymous>";
    }
    if (isArrowFunction(current) && isVariableDeclaration(current.parent)) return current.parent.name.getText();
  }
  return "<module>";
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
    const visit = (node) => {
      let shape;
      if (isCallExpression(node)) {
        shape = {
          category: "call",
          callee: node.expression.getText(source),
          arguments: node.arguments.map((argument) => argument.getText(source)),
        };
      } else if (isPropertyAssignment(node)) {
        shape = { category: "property-assignment", name: node.name.getText(source).replace(/["']/g, "") };
      } else if (isBinaryExpression(node)
        && isAssignmentOperator(node.operatorToken.kind)
        && isPropertyAccessExpression(node.left)) {
        shape = { category: "property-write", name: node.left.name.text };
      } else if (isDeleteExpression(node) && isPropertyAccessExpression(node.expression)) {
        shape = { category: "property-delete", name: node.expression.name.text };
      }
      if (shape) {
        records.push({
          ...shape,
          file: path.relative(root, file),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          kind: SyntaxKind[node.kind],
          owner: ownerOf(node),
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
