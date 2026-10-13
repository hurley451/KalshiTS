#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { checkWebsocketGenerated } from "./check-websocket-generated.mjs";
import { checkCfGenerated } from "./check-cf-generated.mjs";

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
  "test/typed-fixtures.json",
  "src/generated/pagination-coverage.json",
  "test/pagination-contracts.test.ts"
]);
export const perpsGeneratedFiles = Object.freeze([
  ...["schema.ts", "source-schema.ts", "operations.ts", "contracts.ts", "models.ts", "endpoints.ts", "coverage.json", "schema-coverage.json", "pagination-coverage.json", "source-gaps.json", "temporal-coverage.json"].map(f => `src/generated/perps-rest/${f}`),
  ...["fixtures.json", "contracts.test.ts", "pagination-contracts.test.ts"].map(f => `test/perps-rest/${f}`)
]);

export async function compareGenerated(repository, outputRoot, files = generatedFiles) {
  const failures = [];
  for (const file of files) {
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

export async function checkPerpsGenerated({ coreRoot, repository = repositoryRoot }) {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "kalshits-perps-generated-"));
  try {
    const result = spawnSync(process.execPath,[path.join(repositoryRoot,"scripts/generate-client.mjs"),"--product","perps","--kalshicore-root",path.resolve(coreRoot),"--active-date","2026-10-12","--out-dir",outputRoot],{stdio:"inherit"});
    if(result.error) throw result.error;
    if(result.status!==0) throw new Error(`Perps generation failed (exit ${result.status}).`);
    for(const directory of ["src/generated/perps-rest","test/perps-rest"]) {
      for(const root of [repository,outputRoot]) {
        const actual=(await readdir(path.join(root,directory))).map(f=>`${directory}/${f}`).sort();
        const expected=perpsGeneratedFiles.filter(f=>f.startsWith(directory+"/")).sort();
        if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error(`Unexpected/missing Perps outputs in ${directory}`);
      }
    }
    await compareGenerated(repository,outputRoot,perpsGeneratedFiles);
  } finally { await rm(outputRoot,{recursive:true,force:true}); }
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
  if(coreRoot) await checkPerpsGenerated({coreRoot});
  if (coreRoot) await checkWebsocketGenerated(coreRoot, undefined, option("--perps-core-root") ?? coreRoot);
  if (coreRoot) await checkCfGenerated(coreRoot);
  console.log(`All ${generatedFiles.length} Predictions${coreRoot ? `, ${perpsGeneratedFiles.length} Perps REST, 14 WebSocket and 6 CF` : ""} generated outputs are byte-identical.`);
}
