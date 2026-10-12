import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { reconcileRelease } from "../scripts/github-release.mjs";

test("release recovery creates absent releases and uploads only missing matching assets", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "kalshits-github-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [path.join(root, "sdk.tgz"), path.join(root, "report.json")];
  writeFileSync(files[0], "archive");
  const report = { targetId: "typescript.KalshiTS", suiteDigest: "a".repeat(64), checks: [{ id: "fixture", passed: true }], generatedAtUtc: "earlier" };
  writeFileSync(files[1], JSON.stringify(report));
  const calls = [];
  const options = { repository: "hurley451/KalshiTS", tag: "v0.1.0-alpha.1", files, prerelease: true, token: "test-only", run: (args) => calls.push(args) };
  assert.equal(await reconcileRelease({ ...options, fetchImplementation: async () => new Response(null, { status: 404 }) }), "created");
  assert.ok(calls[0].includes("--verify-tag"));
  assert.ok(calls[0].includes("--prerelease"));
  calls.length = 0;
  const lookup = (assets, archive = "archive") => async (url) => {
    if (url.includes("/releases/tags/")) return Response.json({ id: 1, tag_name: options.tag, draft: false, prerelease: true });
    if (url.includes("?per_page=")) return Response.json(assets);
    if (url.endsWith("/assets/2")) return new Response(archive);
    return Response.json({ ...report, generatedAtUtc: "later", kalshiCoreRoot: "/different-runner" });
  };
  assert.equal(await reconcileRelease({ ...options, fetchImplementation: lookup([{ id: 2, name: "sdk.tgz" }]) }), "resumed");
  assert.deepEqual(calls[0], ["release", "upload", options.tag, files[1], "--repo", options.repository]);
  assert.ok(!calls[0].includes("--clobber"));
  calls.length = 0;
  assert.equal(await reconcileRelease({ ...options, fetchImplementation: lookup([{ id: 2, name: "sdk.tgz" }, { id: 3, name: "report.json" }]) }), "verified");
  assert.equal(calls.length, 0);
  await assert.rejects(reconcileRelease({ ...options, fetchImplementation: lookup([{ id: 2, name: "sdk.tgz" }], "different") }), /Refusing to overwrite/);
  assert.equal(calls.length, 0);
  for (const status of [401, 403, 500]) {
    await assert.rejects(reconcileRelease({ ...options, fetchImplementation: async () => new Response(null, { status }) }), /lookup failed/);
  }
});

test("release evidence includes every declared conformance group before action and recovery", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "kalshits-release-groups-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "report.json");
  const report = { targetId: "typescript.KalshiTS", suiteDigest: "a".repeat(64),
    checks: [{ id: "legacy", passed: true }], perpsChecks: [{ id: "perps-case", passed: true }] };
  let actions = 0;
  const options = { repository: "hurley451/KalshiTS", tag: "v0.1.0-alpha.1", files: [file],
    prerelease: true, token: "test-only", run: () => { actions++; } };
  for (const perpsChecks of [[{ id: "perps-case", passed: false }], [], null,
    [{ id: "same", passed: true }, { id: "same", passed: true }], [{ passed: true }]]) {
    writeFileSync(file, JSON.stringify({ ...report, perpsChecks }));
    await assert.rejects(reconcileRelease({ ...options, fetchImplementation: async () => assert.fail("must not look up invalid evidence") }), /successful checks/);
  }
  writeFileSync(file, JSON.stringify({ ...report, cfChecks: [{ id: "cf-case", passed: false }] }));
  await assert.rejects(reconcileRelease({ ...options, fetchImplementation: async () => assert.fail("must validate additional groups") }), /successful checks/);
  writeFileSync(file, JSON.stringify(report));
  const remote = evidence => async url => {
    if (url.includes("/releases/tags/")) return Response.json({ id: 1, tag_name: options.tag, draft: false, prerelease: true });
    if (url.includes("?per_page=")) return Response.json([{ id: 2, name: "report.json" }]);
    return Response.json(evidence);
  };
  await assert.rejects(reconcileRelease({ ...options, fetchImplementation: remote({ ...report, perpsChecks: [{ id: "perps-case", passed: false }] }) }), /successful checks/);
  await assert.rejects(reconcileRelease({ ...options, fetchImplementation: remote({ ...report, perpsChecks: [{ id: "different-case", passed: true }] }) }), /Refusing to overwrite/);
  const { perpsChecks: omitted, ...legacy } = report;
  void omitted;
  await assert.rejects(reconcileRelease({ ...options, fetchImplementation: remote(legacy) }), /Refusing to overwrite/);
  assert.equal(await reconcileRelease({ ...options, fetchImplementation: remote({ ...report, generatedAtUtc: "later" }) }), "verified");
  assert.equal(actions, 0);
  assert.equal(await reconcileRelease({ ...options, fetchImplementation: async () => new Response(null, { status: 404 }) }), "created");
  assert.equal(actions, 1);
});

test("release recovery rejects wrong identity and failed conformance", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "kalshits-github-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "report.json");
  const options = { repository: "hurley451/KalshiTS", tag: "v0.1.0-alpha.1", files: [file], prerelease: true, token: "test-only", run: () => assert.fail("must not write") };
  writeFileSync(file, JSON.stringify({ targetId: "typescript.KalshiTS", suiteDigest: "a".repeat(64), checks: [{ id: "fixture", passed: true }] }));
  await assert.rejects(reconcileRelease({ ...options, fetchImplementation: async () => Response.json({ id: 1, tag_name: "v0.2.0", draft: false, prerelease: true }) }), /identity\/state/);
  writeFileSync(file, JSON.stringify({ targetId: "typescript.KalshiTS", suiteDigest: "a".repeat(64), checks: [{ id: "fixture", passed: false }] }));
  await assert.rejects(reconcileRelease({ ...options, fetchImplementation: async () => assert.fail("must not look up") }), /successful checks/);
});
