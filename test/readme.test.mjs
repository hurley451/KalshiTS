import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("README TypeScript examples compile against public declarations", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".readme-proof-"));
  try {
    const readme = readFileSync("README.md", "utf8");
    const snippets = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)];
    assert.ok(snippets.length >= 8);
    const files = snippets.map(([, code], index) => {
      const file = path.join(root, `example-${index}.mts`);
      const prelude = /\b(?:const|let)\s+client\b/.test(code) ? "" : 'declare const client: import("../dist/src/index.js").KalshiClient;\n';
      writeFileSync(file, prelude + code.replaceAll('"@hurley451/kalshi-ts"', '"../dist/src/index.js"'));
      return file;
    });
    execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--target", "ES2022", "--module", "NodeNext", "--skipLibCheck", ...files], {stdio: "pipe"});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
