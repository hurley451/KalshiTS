import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("packed consumer compiles and executes typed pagination for all 28 source operations", () => {
  const repository = process.cwd();
  const root = mkdtempSync(path.join(tmpdir(), "kalshi-pagination-consumer-"));
  const run = (command, args, cwd = root) => execFileSync(command, args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_cache: path.join(root, "npm-cache") }
  });
  try {
    // npm test builds once; parallel consumers must not rebuild shared output.
    const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], repository);
    const pack = JSON.parse(output.slice(output.indexOf("[")))[0];
    for (const file of ["dist/src/pagination.js", "dist/src/pagination.d.ts", "dist/src/generated/endpoints.d.ts", "src/generated/pagination-coverage.json"]) {
      assert.ok(pack.files.some(f => f.path === file), `missing packed ${file}`);
    }
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(root, pack.filename)]);
    const proof = readFileSync(path.join(repository, "test/pagination-contracts.test.ts"), "utf8");
    assert.equal((proof.match(/const domainGet/g) ?? []).length, 28);
    writeFileSync(path.join(root, "consumer.mts"), proof.replace('"../src/index.js"', '"@hurley451/kalshi-ts"'));
    const tsc = path.join(repository, "node_modules/typescript/lib/tsc.js");
    const args = [tsc, "--strict", "--noEmit", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", path.join(repository, "node_modules/@types"), "consumer.mts"];
    run(process.execPath, args);
    run(process.execPath, [...args, "--exactOptionalPropertyTypes"]);
    for (const [target, source] of [["coverage.json", "src/generated/pagination-coverage.json"], ["fixtures.json", "test/typed-fixtures.json"]]) {
      writeFileSync(path.join(root, target), readFileSync(path.join(repository, source)));
    }
    writeFileSync(path.join(root, "consumer.mjs"), `
import assert from "node:assert/strict";
import fs from "node:fs";
import { KalshiClient, KalshiPaginationError } from "@hurley451/kalshi-ts";
const {operations} = JSON.parse(fs.readFileSync("coverage.json", "utf8"));
const {fixtures} = JSON.parse(fs.readFileSync("fixtures.json", "utf8"));
assert.equal(operations.length, 28);
assert.equal(typeof KalshiPaginationError, "function");
for (const entry of operations) {
  const fixture = fixtures.find(f => f.operationId === entry.operationId);
  const contract = entry.responses[0];
  const sourceBody = fixture.responses.find(r => r.status === contract.status).body;
  const input = structuredClone(fixture.input);
  delete input.query.cursor;
  const before = structuredClone(input);
  let calls = 0;
  const bodies = ["next /?&", ""].map(cursor => ({...structuredClone(sourceBody), [contract.cursorField]:cursor}));
  const client = new KalshiClient({fetch: async (url, init) => {
    assert.equal(new URL(url).searchParams.get("cursor"), calls === 0 ? null : "next /?&");
    assert.equal(new Headers(init.headers).get("X-Consumer"), "pages");
    assert.equal(new Headers(init.headers).has("kalshi-access-key"), false);
    assert.ok(calls < 2);
    return Response.json(bodies[calls++], {status:contract.status});
  }});
  const domain = entry.domain === "portfolioApi" ? "portfolio" : entry.domain;
  const iterator = client[domain][entry.pageMethod](input, {authenticated:false, headers:{"X-Consumer":"pages"}});
  assert.equal(calls, 0);
  const actual = [];
  for await (const page of iterator) actual.push(page);
  assert.deepEqual(actual, bodies);
  assert.equal(calls, 2);
  assert.deepEqual(input, before);
  calls = 0;
  const flat = client[entry.pageMethod](input, {authenticated:false, headers:{"X-Consumer":"pages"}}, {maxPages:1});
  assert.equal((await flat.next()).done, false);
  assert.equal((await flat.next()).done, true);
  assert.equal(calls, 1);
}
console.log("28 packed typed pagination operations passed");
`);
    assert.match(run(process.execPath, ["consumer.mjs"]), /28 packed typed pagination operations passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
