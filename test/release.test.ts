import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const release = YAML.parse(readFileSync(path.join(repository, ".github/workflows/release.yml"), "utf8"));
const conformance = YAML.parse(readFileSync(path.join(repository, ".github/workflows/kalshicore-conformance.yml"), "utf8"));
const steps = release.jobs.publish.steps;
const gate = steps.find((step: { id?: string }) => step.id === "release");

test("PR release and scheduled drift enforce full generation", () => {
  const pkg = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"));
  assert.equal(pkg.kalshiCoreRef, "d898aff6834ddd7862d99ba660da3b7d8bb7013c");
  assert.equal(pkg.scripts["check:generated"], "node scripts/check-generated.mjs");
  assert.ok(conformance.on.pull_request);
  const generation = conformance.jobs.conformance.steps.find((step: { id?: string }) => step.id === "generation");
  assert.match(generation.run, /npm run check:generated -- --kalshicore-root/);
  const install = steps.find((step: { name: string }) => step.name === "Install and verify");
  assert.match(install.run, /npm run check:generated -- --kalshicore-root KalshiCore/);
  assert.doesNotMatch(install.run, /--out\b|cmp src\/generated\/operations/);
  const issue = conformance.jobs.conformance.steps.find((step: { name: string }) => step.name === "File KalshiCore contract gap");
  assert.match(issue.if, /steps\.generation\.outcome == 'failure'/);
  assert.match(issue.if, /steps\.conformance\.outcome == 'failure'/);
  assert.match(issue.if, /github\.event_name == 'schedule'/);
  for (const step of conformance.jobs.conformance.steps.filter((value: { run?: string }) => value.run)) {
    assert.equal(spawnSync("bash", ["-n"], { input: step.run }).status, 0);
  }
});

const generationGate = path.join(repository, "scripts/check-generated.mjs");
const runGenerationFunction = (code: string, ...args: string[]) => spawnSync(process.execPath,
  ["--input-type=module", "-e", `const gate = await import(process.argv[2]); process.argv.splice(1, 1); ${code}`, "generation-test", generationGate, ...args],
  { encoding: "utf8" });
const generatedFiles: string[] = JSON.parse(execFileSync(process.execPath,
  ["--input-type=module", "-e", "const gate = await import(process.argv[2]); console.log(JSON.stringify(gate.generatedFiles));", "generation-test", generationGate],
  { encoding: "utf8" }));

test("generation comparison rejects mismatches and missing outputs for every generated file", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "kalshits-generation-comparison-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const expected = path.join(root, "expected");
  const generated = path.join(root, "generated");
  assert.equal(generatedFiles.length, 11);
  for (const file of generatedFiles) {
    for (const directory of [expected, generated]) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), `bytes for ${file}\n`);
    }
  }
  const compare = () => runGenerationFunction("await gate.compareGenerated(process.argv[2], process.argv[3]);", expected, generated);
  assert.equal(compare().status, 0);
  for (const file of generatedFiles) {
    const output = path.join(generated, file);
    const bytes = readFileSync(output);
    writeFileSync(output, Buffer.concat([bytes, Buffer.from("drift")]));
    const mismatch = compare();
    assert.notEqual(mismatch.status, 0);
    assert.ok(mismatch.stderr.includes(`Generated output differs: ${file}`));
    rmSync(output);
    const missing = compare();
    assert.notEqual(missing.status, 0);
    assert.ok(missing.stderr.includes(`Missing regenerated output: ${file}`));
    writeFileSync(output, bytes);
    rmSync(path.join(expected, file));
    const absent = compare();
    assert.notEqual(absent.status, 0);
    assert.ok(absent.stderr.includes(`Missing checked-in output: ${file}`));
    writeFileSync(path.join(expected, file), bytes);
  }
});

test("full generation check uses portable temporary output without changing repository bytes", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "kalshits-generation-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "openapi.json");
  writeFileSync(source, JSON.stringify({
    openapi: "3.0.3", info: { title: "Generation fixture", version: "1" },
    paths: { "/fixture": { get: { operationId: "GetFixture", tags: ["market"],
      responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Fixture" } } } } } } } },
    components: { schemas: { Fixture: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } }
  }));
  const seed = spawnSync(process.execPath, [path.join(repository, "scripts/generate-operations.mjs"),
    "--source", "openapi.json", "--out-dir", "expected"], { cwd: root, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  const expected = path.join(root, "expected");
  const before = generatedFiles.map(file => readFileSync(path.join(expected, file)));
  const check = (input = source) => runGenerationFunction(
    "await gate.checkGenerated({ source: process.argv[2], repository: process.argv[3] });", input, expected);
  assert.equal(check().status, 0);
  generatedFiles.forEach((file, index) => assert.deepEqual(readFileSync(path.join(expected, file)), before[index]));
  const mismatched = path.join(expected, generatedFiles[0]!);
  writeFileSync(mismatched, "stale\n");
  assert.notEqual(check().status, 0);
  assert.equal(readFileSync(mismatched, "utf8"), "stale\n");
  assert.notEqual(check(path.join(root, "missing-source.yaml")).status, 0);
});

test("release workflow uses exact tags immutable suite pins and OIDC", () => {
  assert.match(steps[0].with.ref, /inputs.tag/);
  assert.equal(release.jobs.publish.permissions["id-token"], "write");
  assert.equal(release.concurrency["cancel-in-progress"], false);
  const pkg = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(repository, "package-lock.json"), "utf8"));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.match(pkg.kalshiCoreRef, /^[a-f0-9]{40}$/);
  const coreCheckout = conformance.jobs.conformance.steps.find((step: { name: string }) => step.name === "Check out KalshiCore");
  assert.ok(coreCheckout.with.ref.includes(pkg.kalshiCoreRef));
  assert.match(coreCheckout.with.ref, /schedule/);
  assert.ok(pkg.files.includes("docs/RELEASES.md"));
  const publishIndex = steps.findIndex((step: { name: string }) => step.name === "Publish to npm");
  const persistIndex = steps.findIndex((step: { name: string }) => step.name === "Persist prepared release evidence");
  const registryIndex = steps.findIndex((step: { name: string }) => step.name === "Inspect existing npm artifact");
  const consumerIndex = steps.findIndex((step: { name: string }) => step.name === "Verify published consumer");
  const githubIndex = steps.findIndex((step: { name: string }) => step.name === "Create matching GitHub release");
  assert.ok(publishIndex > 0 && consumerIndex > publishIndex && githubIndex > consumerIndex);
  assert.ok(persistIndex < registryIndex && registryIndex < publishIndex);
  assert.equal(steps[persistIndex].with["if-no-files-found"], "error");
  assert.match(steps[publishIndex].if, /needs-publish == 'true'/);
  assert.match(steps[consumerIndex].run, /verify-dist-tag/);
  assert.equal(steps[consumerIndex].env.DIST_TAG, "${{ steps.release.outputs.dist-tag }}");
  assert.match(steps.find((step: { name: string }) => step.name === "Pack exact artifact").run, /test:package/);
  for (const step of steps.filter((value: { run?: string }) => value.run)) {
    assert.equal(spawnSync("bash", ["-n"], { input: step.run }).status, 0);
    assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./);
  }
});

test("release gate validates tagged source version suite pin and dist-tag", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "kalshits-release-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  const pkg = { version: "0.1.0-alpha.1", kalshiCoreRef: "a".repeat(40) };
  const writePackage = () => writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  writePackage();
  git("add", "package.json");
  git("commit", "-qm", "test fixture");
  git("tag", "v0.1.0-alpha.1");
  const output = path.join(root, "output");
  const check = (tag: string) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", gate.run], {
    cwd: root, env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: output }, encoding: "utf8"
  });
  assert.equal(check("v0.1.0-alpha.1").status, 0);
  assert.match(readFileSync(output, "utf8"), /dist-tag=next/);
  for (const tag of ["main", "v0.1.0-alpha.1; touch injected", "v0.1.0", "v01.0.0"]) assert.notEqual(check(tag).status, 0);
  pkg.kalshiCoreRef = "main";
  writePackage();
  assert.notEqual(check("v0.1.0-alpha.1").status, 0);
  pkg.kalshiCoreRef = "a".repeat(40);
  pkg.version = "0.1.0";
  writePackage();
  git("add", "package.json");
  git("commit", "-qm", "stable fixture");
  git("tag", "v0.1.0");
  assert.equal(check("v0.1.0").status, 0);
  assert.match(readFileSync(output, "utf8"), /dist-tag=latest/);
  assert.notEqual(check("v0.1.0-alpha.1").status, 0);
});
