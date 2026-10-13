import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("installed native ESM/strict NodeNext CF consumers prove helpers/registry/crypto/bytes/negative/options", () => {
  const repository = process.cwd(); const root = mkdtempSync(path.join(tmpdir(), "kalshi-cf-installed-"));
  const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, npm_config_cache: path.join(root, "npm-cache") } });
  try {
    const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], repository);
    const pack = JSON.parse(output.slice(output.indexOf("[")))[0];
    for (const file of ["dist/src/cfbenchmarks.js", "dist/src/cfbenchmarks.d.ts", "dist/src/cf-contracts.js", "dist/src/generated/cf-rest/contracts.js", "dist/src/generated/cf-rest/models.d.ts", "src/generated/cf-rest/coverage.json", "src/generated/cf-rest/source-facts.json"]) assert.ok(pack.files.some(f => f.path === file), file);
    assert.ok(pack.files.every(f => !/^dist\/(test|scripts|examples)\//.test(f.path) && !/^test\//.test(f.path)));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(root, pack.filename)]);
    writeFileSync(path.join(root, "consumer.mts"), `
import { KalshiClient, cfContracts, cfReadTokenCost, cfOperationCost, type CfEnvelope, type CfOperationId, type CfQueryPairs, type CfValuesQuery, type CfHistoryValuesQuery, type CfRequestOptions } from "@hurley451/kalshi-ts";
declare const client: KalshiClient;
const pairs = [["id", "UNLISTED_INDEX"], ["id", "SECOND"], ["future", "opaque"]] as const satisfies CfQueryPairs;
const values: CfValuesQuery = {id:"X", maxResolution:"1m", future:"anything"};
const history: CfHistoryValuesQuery = {id:"X", timespan:"1h", timestamp:"opaque", future:"anything"};
const id: CfOperationId = "cfbenchmarks.passthrough";
const options: CfRequestOptions = {providerPath:"safe/future", queryPairs:pairs, headers:{"x-test":"yes"}, timeoutMs:30000};
const envelope: CfEnvelope = await client.cf.values(values);
const data: unknown = envelope.data;
await client.cf.historyValues(history);
await client.cf.get("safe/future", pairs);
const raw = await client.rawRequest(id, options);
const bytes: Uint8Array = raw.rawBody;
const registered: CfEnvelope = await client.request("cfbenchmarks.values", {queryPairs:pairs});
// @ts-expect-error canonical generic helper requires pairs, not a record
client.cf.get("values", {id:"X"});
// @ts-expect-error query values are decoded strings, not coerced numbers
client.cf.values({id:1});
// @ts-expect-error tuples have exactly two string entries
client.cf.get("values", [["id","X","third"]]);
// @ts-expect-error CF response data is unknown
const price: number = envelope.data;
// @ts-expect-error CF options forbid request bodies
const bodyOptions: CfRequestOptions = {body:{}};
// @ts-expect-error no source-defined CF paginator
client.cf.historyValuesPages();
// @ts-expect-error manual IDs are separately typed
const wrong: CfOperationId = "GetFills";
void [data, bytes, registered, cfContracts, cfReadTokenCost, cfOperationCost, price, bodyOptions, wrong];
`);
    const args = [path.join(repository, "node_modules/typescript/lib/tsc.js"), "--strict", "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--typeRoots", path.join(repository, "node_modules/@types"), "consumer.mts"];
    run(process.execPath, args); run(process.execPath, [...args, "--exactOptionalPropertyTypes"]);
    writeFileSync(path.join(root, "wire.mjs"), readFileSync(path.join(repository, "test/helpers/cf-wire.mjs")));
    writeFileSync(path.join(root, "consumer.mjs"), `
import * as sdk from "@hurley451/kalshi-ts";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {proveCfWire, proveCfNegatives, proveCfErrors, proveCfOptions} from "./wire.mjs";
await proveCfWire(sdk); await proveCfNegatives(sdk); await proveCfErrors(sdk); await proveCfOptions(sdk);
const coverage=JSON.parse(readFileSync("node_modules/@hurley451/kalshi-ts/src/generated/cf-rest/coverage.json"));
const source=JSON.parse(readFileSync("node_modules/@hurley451/kalshi-ts/src/generated/cf-rest/source-facts.json"));
assert.equal(coverage.manualEntries.length,3); assert.equal(coverage.caseCount,74);
assert.equal(source.corePin,"d898aff6834ddd7862d99ba660da3b7d8bb7013c");
assert.equal(source.source.rawSha256,"bf0ef09aae3c97542090c17bce999e04441f830e6db390c6d392e67929996b51");
assert.equal(sdk.cfReadTokenCost,50); assert.equal(sdk.cfOperationCost("GetFills"),1);
console.log("Installed CF strict/native consumer: signed sockets, zero-dispatch negatives, exact bytes/errors/options passed.");
`);
    assert.match(run(process.execPath, ["consumer.mjs"]), /Installed CF strict\/native consumer/);
    // This is a proof-tool fixture, not a claim about parent-owned README text.
    writeFileSync(path.join(root, "readme-fixture.md"), `# CF proof-tool fixture\n\n\`\`\`ts\nconst current: unknown = (await client.cf.values({id:"UNLISTED_INDEX"})).data;\nvoid current;\n\`\`\`\n\n\`\`\`ts\nconst history = await client.cf.historyValuesRaw({id:"X",timespan:"opaque"});\nvoid history.rawBody;\n\`\`\`\n\n\`\`\`ts\nawait client.cf.get("safe/future", [["id","X"],["includeVerification","anything"],["id","Y"]] as const);\n\`\`\`\n`);
    const readmeProof = JSON.parse(run(process.execPath, [path.join(repository, "scripts/check-cf-readme.mjs"), "--readme", path.join(root, "readme-fixture.md"), "--package", path.join(root, pack.filename)]));
    assert.equal(readmeProof.snippetsExecuted, 3); assert.equal(readmeProof.signedDispatches, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
