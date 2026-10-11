import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
