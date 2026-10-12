#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const generatedFiles = Object.freeze([
  "src/generated/schema.ts",
  "src/generated/operations.ts",
  "src/generated/contracts.ts",
  "src/generated/models.ts",
  "src/generated/endpoints.ts",
  "src/generated/coverage.json",
  "src/generated/schema-coverage.json",
  "test/typed-contracts.test.ts",
  "test/typed-fixtures.json"
]);

export async function compareGenerated(repository, outputRoot) {
  const failures = [];
  for (const file of generatedFiles) {
    const contents = [];
    for (const [label, root] of [["checked-in", repository], ["regenerated", outputRoot]]) {
      try {
        contents.push(await readFile(path.join(root, file)));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        failures.push(`Missing ${label} output: ${file}`);
        contents.push(undefined);
      }
    }
    if (contents[0] && contents[1] && !contents[0].equals(contents[1])) {
      failures.push(`Generated output differs: ${file}`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

export async function checkGenerated({ source, repository = repositoryRoot }) {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "kalshits-generated-"));
  try {
    const result = spawnSync(process.execPath, [
      path.join(repositoryRoot, "scripts/generate-operations.mjs"),
      "--source", path.resolve(source), "--out-dir", outputRoot
    ], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Full client generation failed (exit ${result.status}).`);
    await compareGenerated(repository, outputRoot);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
    return value;
  };
  const coreRoot = option("--kalshicore-root") ?? process.env.KALSHICORE_ROOT;
  const source = option("--source") ?? process.env.KALSHI_OPENAPI
    ?? (coreRoot ? path.join(coreRoot, "sources/official/openapi.yaml") : undefined);
  if (!source) throw new Error("Pass --source <official openapi.yaml> or --kalshicore-root <path>.");
  await checkGenerated({ source });
  console.log(`All ${generatedFiles.length} generated outputs are byte-identical.`);
}
