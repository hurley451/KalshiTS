import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const cfCorePin = "d898aff6834ddd7862d99ba660da3b7d8bb7013c";
export const cfGeneratedFiles = ["src/generated/cf-rest/contracts.ts", "src/generated/cf-rest/models.ts",
  "src/generated/cf-rest/coverage.json", "src/generated/cf-rest/source-facts.json",
  "test/cf-rest/fixtures.json", "test/cf-rest/contracts.test.ts"];
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export async function generateCf(coreRoot, outputRoot = root) {
  if (!coreRoot) throw new Error("Set KALSHICORE_ROOT or pass --kalshicore-root.");
  const head = execFileSync("git", ["-C", coreRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== cfCorePin) throw new Error("CF generation requires the reviewed immutable Core pin.");
  const digests = {};
  const read = async file => {
    const bytes = await readFile(path.join(coreRoot, file));
    const pinned = execFileSync("git", ["-C", coreRoot, "show", `${cfCorePin}:${file}`]);
    if (!bytes.equals(pinned)) throw new Error(`Core CF input differs from reviewed pin: ${file}`);
    digests[file] = hash(bytes);
    return JSON.parse(bytes);
  };
  const index = await read("sources/manual/index.json");
  const facts = await read("sources/manual/cfbenchmarks-rest.json");
  const coverage = await read("contracts/manual-coverage.json");
  const fixture = await read("fixtures/cfbenchmarks/rest-cases.json");
  const source = index.sources.find(s => s.id === "cfbenchmarks-rest-manual");
  if (!source || source.factsSha256 !== digests[source.factsPath] || source.rawSha256 !== facts.retrieval.sha256) throw new Error("CF source hashes disagree.");
  const contracts = {};
  for (const id of source.entryIds) contracts[id] = await read(`contracts/endpoints/${id}.json`);
  const cases = fixture.input.cases;
  if (new Set(cases.map(c => c.caseId)).size !== cases.length
    || cases.some(c => c.identity.sourceId !== source.id || !Object.hasOwn(contracts, c.identity.manualEntryId))) throw new Error("Invalid CF case identities.");
  const bindings = coverage.entries.map(entry => ({ ...entry, cases: cases.filter(c => c.identity.manualEntryId === entry.contractId).map(c => c.caseId) }));
  const json = value => JSON.stringify(value, null, 2) + "\n";
  const outputs = [
    `// Generated from reviewed manual Core contracts; not OAS operations.\nexport const cfContracts = ${JSON.stringify(contracts, null, 2)} as const;\n`,
    `// Generated manual passthrough types; upstream data is deliberately unknown.\nexport type CfOperationId = ${source.entryIds.map(JSON.stringify).join(" | ")};\nexport type CfQueryPairs = readonly (readonly [string, string])[];\nexport interface CfEnvelope { data: unknown; [key: string]: unknown }\nexport interface CfValuesQuery { id?: string; maxResolution?: string; [key: string]: string | undefined }\nexport interface CfHistoryValuesQuery extends CfValuesQuery { timespan?: string; timestamp?: string }\n`,
    json({ sourceId: source.id, corePin: cfCorePin, manualEntries: bindings, caseIds: cases.map(c => c.caseId), caseCount: cases.length, upstreamSchema: "unknown", syntheticHistoryPager: false }),
    json({ corePin: cfCorePin, source, facts, inputDigests: digests }),
    json(fixture),
    `// Generated case bindings; execution uses actual SDK transport, not Core's oracle.\nimport test from "node:test";\nimport assert from "node:assert/strict";\nimport { runCfConformance } from "../../scripts/cf-conformance.js";\ntest("CF reviewed source cases through SDK", async () => {\n const checks = await runCfConformance();\n assert.equal(checks.length, ${cases.length});\n for (const check of checks) assert.equal(check.passed, true, check.id + ": " + check.message);\n});\n`
  ];
  // Validate all inputs before touching the destination.
  for (let i = 0; i < cfGeneratedFiles.length; i++) {
    const target = path.join(outputRoot, cfGeneratedFiles[i]);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, outputs[i]);
  }
  console.log(`Generated ${cfGeneratedFiles.length} CF outputs, ${source.entryIds.length} manual entries, ${cases.length} case bindings at ${cfCorePin}.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const i = process.argv.indexOf(name); if (i < 0) return undefined; const value = process.argv[i + 1]; if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`); return value; };
  await generateCf(option("--kalshicore-root") ?? process.env.KALSHICORE_ROOT, option("--out-dir") ?? root);
}
