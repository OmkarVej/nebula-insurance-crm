#!/usr/bin/env node
"use strict";

// Symbol-layer extractor for TS/TSX. Invoked by scripts/kg/symbols.py.
// Reads a JSON array of repo-relative file paths from stdin, parses each
// file with ts-morph (TypeScript compiler API), and writes a JSON array
// of symbol records to stdout. One record per top-level declaration plus
// per class member (methods, properties).
//
// Output schema (each item):
//   {
//     file:       string  // repo-relative path
//     name:       string  // symbol identifier as written in source
//     container:  string|null  // owning type for methods/properties
//     kind:       "function"|"method"|"class"|"interface"|"type"|"enum"|"property"
//     line:       number  // 1-based start line of the declaration
//     signature:  string  // first line of the declaration up to the body
//     visibility: "export"|"local"|"public"
//     calls:      string[]  // referenced names inside the symbol body
//   }

const { Project, SyntaxKind } = require("ts-morph");

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function hasExportModifier(node) {
  const modifiers = typeof node.getModifiers === "function" ? node.getModifiers() : [];
  return modifiers.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
}

function lineOf(node) {
  return node.getStartLineNumber();
}

function shortSignature(node) {
  const text = node.getText();
  const firstBrace = text.indexOf("{");
  const firstNewline = text.indexOf("\n");
  let cut = text.length;
  if (firstBrace > 0) cut = Math.min(cut, firstBrace);
  if (firstNewline > 0) cut = Math.min(cut, firstNewline);
  return text.slice(0, cut).trim();
}

function collectCalls(node) {
  const calls = new Set();
  node.forEachDescendant((descendant) => {
    if (descendant.getKind() !== SyntaxKind.CallExpression) return;
    const expr = descendant.getExpression();
    if (!expr) return;
    const kind = expr.getKind();
    if (kind === SyntaxKind.Identifier) {
      calls.add(expr.getText());
    } else if (kind === SyntaxKind.PropertyAccessExpression) {
      const name = typeof expr.getName === "function" ? expr.getName() : null;
      if (name) calls.add(name);
    }
  });
  return Array.from(calls);
}

function pushFunctionLike(file, node, container, kind, outputs) {
  const name =
    (typeof node.getName === "function" && node.getName()) ||
    (typeof node.getNameNode === "function" && node.getNameNode()?.getText()) ||
    null;
  if (!name) return;
  const visibility = container ? "public" : hasExportModifier(node) ? "export" : "local";
  outputs.push({
    file,
    name,
    container,
    kind,
    line: lineOf(node),
    signature: shortSignature(node),
    visibility,
    calls: collectCalls(node),
  });
}

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || "[]");
  } catch (e) {
    process.stderr.write(`failed to parse stdin JSON: ${e.message}\n`);
    process.exit(1);
  }
  if (!Array.isArray(input)) {
    process.stderr.write("stdin payload must be a JSON array of file paths\n");
    process.exit(1);
  }

  const project = new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: false,
      jsx: 4, // Preserve = 1, ReactJSX = 4; Preserve avoids needing react types
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 2, // NodeJs
      strict: false,
      noEmit: true,
      isolatedModules: true,
    },
  });

  const outputs = [];
  for (const rel of input) {
    let sourceFile;
    try {
      sourceFile = project.addSourceFileAtPath(rel);
    } catch (e) {
      process.stderr.write(`failed to add ${rel}: ${e.message}\n`);
      continue;
    }

    sourceFile.forEachChild((child) => {
      const kind = child.getKind();

      if (kind === SyntaxKind.FunctionDeclaration) {
        pushFunctionLike(rel, child, null, "function", outputs);
      } else if (kind === SyntaxKind.ClassDeclaration) {
        const className = typeof child.getName === "function" ? child.getName() : null;
        if (!className) return;
        outputs.push({
          file: rel,
          name: className,
          container: null,
          kind: "class",
          line: lineOf(child),
          signature: shortSignature(child),
          visibility: hasExportModifier(child) ? "export" : "local",
          calls: [],
        });
        for (const member of child.getMembers()) {
          const mk = member.getKind();
          if (mk === SyntaxKind.MethodDeclaration) {
            pushFunctionLike(rel, member, className, "method", outputs);
          } else if (mk === SyntaxKind.PropertyDeclaration) {
            const name = typeof member.getName === "function" ? member.getName() : null;
            if (!name) continue;
            outputs.push({
              file: rel,
              name,
              container: className,
              kind: "property",
              line: lineOf(member),
              signature: shortSignature(member),
              visibility: "public",
              calls: collectCalls(member),
            });
          }
        }
      } else if (kind === SyntaxKind.InterfaceDeclaration) {
        const name = typeof child.getName === "function" ? child.getName() : null;
        if (!name) return;
        outputs.push({
          file: rel,
          name,
          container: null,
          kind: "interface",
          line: lineOf(child),
          signature: shortSignature(child),
          visibility: hasExportModifier(child) ? "export" : "local",
          calls: [],
        });
      } else if (kind === SyntaxKind.TypeAliasDeclaration) {
        const name = typeof child.getName === "function" ? child.getName() : null;
        if (!name) return;
        outputs.push({
          file: rel,
          name,
          container: null,
          kind: "type",
          line: lineOf(child),
          signature: shortSignature(child),
          visibility: hasExportModifier(child) ? "export" : "local",
          calls: [],
        });
      } else if (kind === SyntaxKind.EnumDeclaration) {
        const name = typeof child.getName === "function" ? child.getName() : null;
        if (!name) return;
        outputs.push({
          file: rel,
          name,
          container: null,
          kind: "enum",
          line: lineOf(child),
          signature: shortSignature(child),
          visibility: hasExportModifier(child) ? "export" : "local",
          calls: [],
        });
      } else if (kind === SyntaxKind.VariableStatement) {
        const isExported = hasExportModifier(child);
        for (const decl of child.getDeclarationList().getDeclarations()) {
          const init = decl.getInitializer();
          if (!init) continue;
          const ik = init.getKind();
          if (ik !== SyntaxKind.ArrowFunction && ik !== SyntaxKind.FunctionExpression) {
            continue;
          }
          const name = decl.getName();
          if (!name) continue;
          outputs.push({
            file: rel,
            name,
            container: null,
            kind: "function",
            line: lineOf(decl),
            signature: shortSignature(decl),
            visibility: isExported ? "export" : "local",
            calls: collectCalls(init),
          });
        }
      }
    });
  }

  process.stdout.write(JSON.stringify(outputs));
}

main().catch((e) => {
  process.stderr.write(`extractor crashed: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exit(1);
});
