import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { generateCf, cfCorePin, cfGeneratedFiles } from "../scripts/generate-cf-rest.mjs";
import { checkCfGenerated } from "../scripts/check-cf-generated.mjs";
import { requireCoreRoot } from "./helpers/core-root.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const fingerprint = async root => Object.fromEntries(await Promise.all(cfGeneratedFiles.map(async file => [file, sha(await readFile(path.join(root, file)))])));
test("CF explicit portable generation is byte-identical and preserves old outputs on all source mutations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cf generation with spaces "));
  const core = path.join(root, "Core immutable input"); const output = path.join(root, "Output with spaces");
  try {
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", requireCoreRoot(), core]);
    execFileSync("git", ["-C", core, "checkout", "--quiet", "--detach", cfCorePin]);
    await generateCf(core, output); const before = await fingerprint(output);
    await checkCfGenerated(core, output); assert.deepEqual(await fingerprint(output), before);
    const mutations = [
      ["contracts/endpoints/cfbenchmarks.passthrough.json", c => { c.method = "POST"; }],
      ["contracts/endpoints/cfbenchmarks.values.json", c => { c.auth = "none"; }],
      ["contracts/endpoints/cfbenchmarks.history-values.json", c => { c.rateCost.tokens = 10; }],
      ["contracts/endpoints/cfbenchmarks.passthrough.json", c => { c.request.passthrough.prefix = "/escape/"; }],
      ["contracts/endpoints/cfbenchmarks.passthrough.json", c => { c.request.passthrough.query.ignoredKeys = []; }],
      ["contracts/endpoints/cfbenchmarks.values.json", c => { c.responses[0].bodySchema.required = []; }],
      ["contracts/endpoints/cfbenchmarks.values.json", c => { c.responses[1].status = 418; }],
      ["contracts/endpoints/cfbenchmarks.values.json", c => { c.source.sourceId = "invented"; }],
      ["sources/manual/index.json", c => { c.sources[0].rawSha256 = "0".repeat(64); }],
      ["sources/manual/cfbenchmarks-rest.json", c => { c.facts.readTokens = 10; }],
      ["fixtures/cfbenchmarks/rest-cases.json", c => { c.input.cases[0].caseId += "-substitution"; }],
      ["contracts/manual-coverage.json", c => { c.entries[0].caseIds[0] += "-substitution"; }]
    ];
    for (const [file, mutate] of mutations) {
      const target = path.join(core, file); const original = await readFile(target); const value = JSON.parse(original);
      mutate(value); await writeFile(target, JSON.stringify(value));
      await assert.rejects(generateCf(core, output), /differs from reviewed pin/);
      assert.deepEqual(await fingerprint(output), before); await writeFile(target, original);
    }
    await assert.rejects(generateCf(undefined, output), /KALSHICORE_ROOT/);
    execFileSync("git", ["-C", core, "checkout", "--quiet", "--detach", "HEAD~1"]);
    await assert.rejects(generateCf(core, output), /immutable Core pin/);
    assert.deepEqual(await fingerprint(output), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CF gate rejects missing/extra/different artifacts without modifying the repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cf outputs "));
  try {
    await generateCf(requireCoreRoot(), root); const before = await fingerprint(root);
    const file = path.join(root, cfGeneratedFiles[0]); const contents = await readFile(file);
    await writeFile(file, "different"); await assert.rejects(checkCfGenerated(requireCoreRoot(), root), /differs/);
    assert.equal((await readFile(file)).toString(), "different"); await writeFile(file, contents);
    await rm(file); await assert.rejects(checkCfGenerated(requireCoreRoot(), root), /Missing\/extra/); await writeFile(file, contents);
    const extra = path.join(root, "src/generated/cf-rest/extra.ts"); await writeFile(extra, "extra");
    await assert.rejects(checkCfGenerated(requireCoreRoot(), root), /Missing\/extra/); await rm(extra);
    assert.deepEqual(await fingerprint(root), before);
    const fixtures = JSON.parse(await readFile(path.join(root, "test/cf-rest/fixtures.json")));
    const coverage = JSON.parse(await readFile(path.join(root, "src/generated/cf-rest/coverage.json")));
    assert.equal(coverage.corePin, cfCorePin); assert.equal(coverage.manualEntries.length, 3); assert.equal(coverage.caseCount, 74);
    assert.deepEqual(coverage.caseIds, fixtures.input.cases.map(c => c.caseId));
    assert.deepEqual(coverage.manualEntries.flatMap(e => e.cases).sort(), [...coverage.caseIds].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
