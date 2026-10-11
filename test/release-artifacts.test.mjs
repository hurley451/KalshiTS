import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createReleaseManifest, inspectNpm, readPreparedArtifact, runCli, verifyNpmDistTag } from "../scripts/release-artifacts.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("../scripts/release-artifacts.mjs", import.meta.url));

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "kalshi-release-artifacts-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bytes = Buffer.from("fixed prepared archive bytes");
  const pack = {
    name: "@hurley451/kalshi-ts", version: "0.1.0-alpha.1", filename: "kalshi-ts-0.1.0-alpha.1.tgz",
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  const archivePath = path.join(cwd, pack.filename);
  const metadataPath = path.join(cwd, "pack.json");
  await writeFile(archivePath, bytes);
  await writeFile(metadataPath, JSON.stringify([pack]));
  return { cwd, bytes, pack, archivePath, metadataPath };
}

const published = (pack) => ({ name: pack.name, version: pack.version, dist: { integrity: pack.integrity } });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("404 alone permits publication after local integrity verification", async (t) => {
  const f = await fixture(t);
  const result = await inspectNpm(f.metadataPath, { cwd: f.cwd, fetch: async (url, init) => {
    assert.equal(url, "https://registry.npmjs.org/%40hurley451%2Fkalshi-ts/0.1.0-alpha.1");
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { accept: "application/json" });
    assert.ok(init.signal instanceof AbortSignal);
    return response({ error: "Not found" }, 404);
  } });
  assert.equal(result.needsPublish, true);
  assert.equal(result.artifact.integrity, f.pack.integrity);
});

test("matching version skips publication, including retry after a prior publish", async (t) => {
  const f = await fixture(t);
  let exists = false;
  let calls = 0;
  const options = { cwd: f.cwd, fetch: async () => {
    calls++;
    return exists ? response(published(f.pack)) : response({}, 404);
  } };
  assert.equal((await inspectNpm(f.metadataPath, options)).needsPublish, true);
  exists = true;
  assert.equal((await inspectNpm(f.metadataPath, options)).needsPublish, false);
  assert.equal((await inspectNpm(f.metadataPath, options)).needsPublish, false);
  assert.equal(calls, 3);
});

test("mismatched and ambiguous registry records fail closed", async (t) => {
  const f = await fixture(t);
  const good = published(f.pack);
  for (const body of [null, [], [good], {}, { ...good, name: "other" }, { ...good, version: "0.2.0" },
    { ...good, dist: {} }, { ...good, dist: { integrity: "sha512-different" } },
    { ...good, dist: { integrity: `${f.pack.integrity} ${f.pack.integrity}` } },
    { versions: { [f.pack.version]: good } }]) {
    await assert.rejects(inspectNpm(f.metadataPath, { cwd: f.cwd, fetch: async () => response(body) }), /does not match/);
  }
});

test("registry failures and malformed responses fail closed without exposing errors", async (t) => {
  const f = await fixture(t);
  for (const status of [201, 204, 301, 401, 403, 429, 500, 503]) {
    await assert.rejects(inspectNpm(f.metadataPath, { cwd: f.cwd,
      fetch: async () => new Response(status === 204 ? null : "secret", { status }),
    }), /unexpected status/);
  }
  await assert.rejects(inspectNpm(f.metadataPath, { cwd: f.cwd,
    fetch: async () => new Response("{broken", { status: 200 }),
  }), /malformed package JSON/);
  await assert.rejects(inspectNpm(f.metadataPath, { cwd: f.cwd,
    fetch: async () => { throw new Error("secret credential"); },
  }), { message: "Registry request failed." });
  await assert.rejects(inspectNpm(f.metadataPath, { cwd: f.cwd, fetch: async () => ({}) }), /Invalid registry response/);
});

test("timeout bounds fetch and body reads even if injected fetch ignores abort", async (t) => {
  const f = await fixture(t);
  for (const fetch of [() => new Promise(() => {}), async () => ({ status: 200, json: () => new Promise(() => {}) })]) {
    await assert.rejects(inspectNpm(f.metadataPath, { cwd: f.cwd, fetch, timeoutMs: 10 }), /timed out/);
  }
  for (const timeoutMs of [0, -1, Infinity, 120001]) {
    await assert.rejects(inspectNpm(f.metadataPath, { cwd: f.cwd, timeoutMs }), /Invalid registry timeout/);
  }
});

test("modified or missing archive is rejected before querying npm", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const options = { cwd: f.cwd, fetch: async () => { calls++; return response({}, 404); } };
  await writeFile(f.archivePath, "modified");
  await assert.rejects(inspectNpm(f.metadataPath, options), /archive integrity/);
  await rm(f.archivePath);
  await assert.rejects(inspectNpm(f.metadataPath, options), /Cannot read prepared archive/);
  assert.equal(calls, 0);
});

test("pack metadata must describe one unambiguous archive", async (t) => {
  const f = await fixture(t);
  for (const metadata of [[], [f.pack, f.pack], {}, [null], [{ ...f.pack, filename: "../archive.tgz" }],
    [{ ...f.pack, name: "bad\nname" }], [{ ...f.pack, version: "latest" }],
    [{ ...f.pack, integrity: `${f.pack.integrity} sha256-extra` }]]) {
    await writeFile(f.metadataPath, JSON.stringify(metadata));
    await assert.rejects(readPreparedArtifact(f.metadataPath, { cwd: f.cwd }));
  }
  await writeFile(f.metadataPath, "invalid");
  await assert.rejects(readPreparedArtifact(f.metadataPath, { cwd: f.cwd }), /valid npm pack metadata JSON/);
});

test("manifest is stable and records current git HEAD, package pin, and archive digests", async (t) => {
  const f = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
  await writeFile(f.metadataPath, JSON.stringify([{ ...f.pack, name: pkg.name, version: pkg.version }]));
  const options = { cwd: repository, archivePath: f.archivePath };
  const manifest = await createReleaseManifest(f.metadataPath, options);
  assert.deepEqual(await createReleaseManifest(f.metadataPath, options), manifest);
  assert.deepEqual(manifest, {
    name: pkg.name, version: pkg.version,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    kalshiCoreRef: pkg.kalshiCoreRef, archive: f.pack.filename, integrity: f.pack.integrity,
  });
  await writeFile(path.join(f.cwd, "package.json"), JSON.stringify(pkg));
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: repository, encoding: "utf8" }).trim();
  await writeFile(path.join(f.cwd, ".git"), `gitdir: ${gitDir}\n`);
  const outputPath = path.join(f.cwd, "manifest.json");
  const cli = spawnSync(process.execPath, [script, "manifest", f.metadataPath, outputPath], { cwd: f.cwd, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, "");
  const firstBytes = await readFile(outputPath, "utf8");
  assert.deepEqual(JSON.parse(firstBytes), manifest);
  await runCli(["manifest", f.metadataPath, outputPath], { cwd: f.cwd });
  assert.equal(await readFile(outputPath, "utf8"), firstBytes);
  await writeFile(f.archivePath, "modified");
  await assert.rejects(createReleaseManifest(f.metadataPath, options), /archive integrity/);
});

test("manifest rejects package mismatch, unpinned core, and missing git HEAD", async (t) => {
  const f = await fixture(t);
  const pkg = { name: f.pack.name, version: f.pack.version, kalshiCoreRef: "a".repeat(40) };
  for (const bad of [{ ...pkg, version: "9.0.0" }, { ...pkg, kalshiCoreRef: "main" }, pkg]) {
    await writeFile(path.join(f.cwd, "package.json"), JSON.stringify(bad));
    await assert.rejects(createReleaseManifest(f.metadataPath, { cwd: f.cwd }));
  }
});

test("CLI appends only the boolean decision and writes nothing on failed inspection", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.cwd, "github-output");
  await writeFile(output, "existing=value\n");
  let stdout = "";
  const options = { cwd: f.cwd, env: { GITHUB_OUTPUT: output, NODE_AUTH_TOKEN: "secret" },
    stdout: { write: (value) => { stdout += value; } } };
  await runCli(["inspect-npm", f.metadataPath], { ...options, fetch: async () => response({}, 404) });
  await runCli(["inspect-npm", f.metadataPath], { ...options, fetch: async () => response(published(f.pack)) });
  const expected = "needs-publish=true\nneeds-publish=false\n";
  assert.equal(stdout, expected);
  assert.equal(await readFile(output, "utf8"), `existing=value\n${expected}`);
  await assert.rejects(runCli(["inspect-npm", f.metadataPath], { ...options, fetch: async () => response({}, 401) }));
  assert.equal(await readFile(output, "utf8"), `existing=value\n${expected}`);
  const cli = spawnSync(process.execPath, [script, "inspect-npm", "missing.json"], {
    cwd: f.cwd, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, NODE_AUTH_TOKEN: "secret" },
  });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.doesNotMatch(cli.stderr, /secret/);
  await assert.rejects(runCli(["unknown", f.metadataPath], options), /Usage:/);
});

test("dist-tag verification accepts exact next and latest after checking the published version", async (t) => {
  const f = await fixture(t);
  for (const distTag of ["next", "latest"]) {
    const pack = { ...f.pack, version: distTag === "latest" ? "0.1.0" : f.pack.version };
    await writeFile(f.metadataPath, JSON.stringify([pack]));
    const urls = [];
    const result = await verifyNpmDistTag(f.metadataPath, distTag, { cwd: f.cwd, fetch: async (url, init) => {
      urls.push(url);
      assert.equal(init.method, "GET");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.deepEqual(init.headers, { accept: "application/json" });
      return response(urls.length === 1 ? published(pack) : {
        name: pack.name, "dist-tags": { latest: "0.0.1", [distTag]: pack.version },
      });
    } });
    assert.deepEqual(urls, [
      `https://registry.npmjs.org/%40hurley451%2Fkalshi-ts/${pack.version}`,
      "https://registry.npmjs.org/%40hurley451%2Fkalshi-ts",
    ]);
    assert.equal(result.distTag, distTag);
    assert.equal(result.artifact.version, pack.version);
    assert.equal(result.artifact.integrity, pack.integrity);
  }
});

test("prerelease gate rejects latest pointing to the same alpha even when next is correct", async (t) => {
  const f = await fixture(t);
  for (const distTag of ["next", "latest"]) {
    let calls = 0;
    await assert.rejects(verifyNpmDistTag(f.metadataPath, distTag, { cwd: f.cwd, fetch: async (_, init) => {
      calls++;
      assert.equal(init.method, "GET");
      return response(calls === 1 ? published(f.pack) : {
        name: f.pack.name, "dist-tags": { next: f.pack.version, latest: f.pack.version },
      });
    } }), (error) => {
      assert.match(error.message, /latest must not point to the prepared prerelease artifact/);
      assert.match(error.message, /Stop recovery and review the current npm dist-tags/);
      assert.match(error.message, /not move an established tag backward/);
      return true;
    });
    assert.equal(calls, 2);
  }
});

test("missing or wrong dist-tags stop recovery without moving an established tag backward", async (t) => {
  const f = await fixture(t);
  for (const distTag of ["next", "latest"]) {
    for (const tags of [undefined, null, [], {}, { [distTag]: "9.0.0" }, { [distTag]: "0.0.1" },
      { [distTag]: [f.pack.version] }]) {
      let calls = 0;
      await assert.rejects(verifyNpmDistTag(f.metadataPath, distTag, { cwd: f.cwd, fetch: async () => {
        calls++;
        return response(calls === 1 ? published(f.pack) : { name: f.pack.name, "dist-tags": tags });
      } }), (error) => {
        assert.match(error.message, /dist-tag is missing or does not match/);
        assert.match(error.message, /review the current npm dist-tags and release order/);
        assert.match(error.message, /manually.*not move an established tag backward/);
        assert.match(error.message, /never changes dist-tags/);
        return true;
      });
      assert.equal(calls, 2);
    }
  }
});

test("dist-tag gate refuses absent or mismatched versions and modified local bytes", async (t) => {
  const f = await fixture(t);
  for (const firstResponse of [() => response({}, 404),
    () => response({ ...published(f.pack), version: "9.0.0" }),
    () => response({ ...published(f.pack), name: "other" }),
    () => response({ ...published(f.pack), dist: { integrity: "wrong" } })]) {
    let calls = 0;
    await assert.rejects(verifyNpmDistTag(f.metadataPath, "next", { cwd: f.cwd, fetch: async () => {
      calls++;
      return firstResponse();
    } }), /absent|does not match/);
    assert.equal(calls, 1);
  }
  await writeFile(f.archivePath, "modified");
  await assert.rejects(verifyNpmDistTag(f.metadataPath, "next", { cwd: f.cwd, fetch: async () => {
    assert.fail("Modified local bytes must prevent all registry requests");
  } }), /archive integrity/);
});

test("dist-tag registry and network failures fail closed with no secret error text", async (t) => {
  const f = await fixture(t);
  const failures = [
    ...[404, 401, 403, 429, 500, 503].map((status) => async () => response({ secret: "credential" }, status)),
    async () => { throw new Error("secret credential"); },
    async () => new Response("{secret credential", { status: 200 }),
    async () => ({}),
    ...[null, [], {}, { name: "other", "dist-tags": { next: f.pack.version } }].map((body) => async () => response(body)),
  ];
  for (const failure of failures) {
    let calls = 0;
    await assert.rejects(verifyNpmDistTag(f.metadataPath, "next", { cwd: f.cwd, fetch: async () => {
      calls++;
      return calls === 1 ? response(published(f.pack)) : failure();
    } }), (error) => {
      assert.doesNotMatch(error.message, /secret|credential/);
      return true;
    });
    assert.equal(calls, 2);
  }
  await assert.rejects(verifyNpmDistTag(f.metadataPath, "next", { cwd: f.cwd,
    fetch: async () => { throw new Error("secret credential"); },
  }), { message: "Registry request failed." });
});

test("dist-tag package fetch and body reads have bounded timeouts", async (t) => {
  const f = await fixture(t);
  for (const stalled of [() => new Promise(() => {}),
    async () => ({ status: 200, json: () => new Promise(() => {}) })]) {
    let calls = 0;
    let packageSignal;
    await assert.rejects(verifyNpmDistTag(f.metadataPath, "next", { cwd: f.cwd, timeoutMs: 10,
      fetch: async (_, init) => {
        calls++;
        if (calls === 1) return response(published(f.pack));
        packageSignal = init.signal;
        return stalled();
      },
    }), /timed out/);
    assert.equal(calls, 2);
    assert.equal(packageSignal.aborted, true);
  }
});

test("verify-dist-tag CLI is read-only, restricts tags, and prints safe recovery guidance on failure", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.cwd, "github-output");
  await writeFile(output, "existing=value\n");
  let stdout = "";
  let calls = 0;
  const options = { cwd: f.cwd, env: { GITHUB_OUTPUT: output, NODE_AUTH_TOKEN: "secret" },
    stdout: { write: (value) => { stdout += value; } },
    fetch: async () => response(++calls % 2 === 1 ? published(f.pack) : {
      name: f.pack.name, "dist-tags": { next: f.pack.version },
    }),
  };
  await runCli(["verify-dist-tag", f.metadataPath, "next"], options);
  assert.equal(stdout, "");
  assert.equal(await readFile(output, "utf8"), "existing=value\n");
  await assert.rejects(verifyNpmDistTag(f.metadataPath, "other", options), /next or latest/);
  for (const args of [["verify-dist-tag", f.metadataPath], ["verify-dist-tag", f.metadataPath, "other"],
    ["verify-dist-tag", f.metadataPath, "next", "extra"]]) {
    await assert.rejects(runCli(args, options), /Usage:/);
  }
  assert.equal(calls, 2);
  const cli = spawnSync(process.execPath, [script, "verify-dist-tag", "missing.json", "next"], {
    cwd: f.cwd, encoding: "utf8", env: { ...process.env, NODE_AUTH_TOKEN: "secret" },
  });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.match(cli.stderr, /Inspect npm tags and release state before recovery/);
  assert.match(cli.stderr, /review the current npm dist-tags and release order/);
  assert.match(cli.stderr, /not move an established tag backward/);
  assert.doesNotMatch(cli.stderr, /secret/);
});
