import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("packed consumers compile complete contracts and execute all named facades", () => {
  const repository = process.cwd();
  const root = mkdtempSync(path.join(tmpdir(), "kalshi-typed-consumer-"));
  const run = (command,args,cwd=root) => execFileSync(command,args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  try {
    const output = run("npm",["pack","--json","--pack-destination",root],repository);
    const pack = JSON.parse(output.slice(output.indexOf("[")))[0];
    assert.ok(pack.files.some(f=>f.path==="dist/src/generated/schema.d.ts"));
    writeFileSync(path.join(root,"package.json"),JSON.stringify({private:true,type:"module"}));
    run("npm",["install","--ignore-scripts","--no-audit","--no-fund",path.join(root,pack.filename)]);
    const proof = readFileSync(path.join(repository,"test/typed-contracts.test.ts"),"utf8").replace('"../src/index.js"','"@hurley451/kalshi-ts"');
    writeFileSync(path.join(root,"consumer.mts"),proof);
    run(process.execPath,[path.join(repository,"node_modules/typescript/lib/tsc.js"),"--strict","--noEmit","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext","--typeRoots",path.join(repository,"node_modules/@types"),"consumer.mts"]);
    run(process.execPath,[path.join(repository,"node_modules/typescript/lib/tsc.js"),"--strict","--exactOptionalPropertyTypes","--noEmit","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext","--typeRoots",path.join(repository,"node_modules/@types"),"consumer.mts"]);
    writeFileSync(path.join(root,"fixtures.json"),readFileSync(path.join(repository,"test/typed-fixtures.json")));
    writeFileSync(path.join(root,"consumer.mjs"),`
import assert from "node:assert/strict";
import fs from "node:fs";
import { KalshiClient, KalshiContractError } from "@hurley451/kalshi-ts";
const {fixtures} = JSON.parse(fs.readFileSync("fixtures.json","utf8"));
for (const fixture of fixtures) {
 const response = fixture.responses.find(r=>r.status<300);
 const client = new KalshiClient({fetch:async()=>response.body===undefined ? new Response(null,{status:response.status}) : Response.json(response.body,{status:response.status})});
 const domain = fixture.domain === "portfolio" ? "portfolioApi" : fixture.domain;
 assert.deepEqual(await client[domain][fixture.methodName](fixture.input,{authenticated:false}),response.body);
 await assert.rejects(client[fixture.methodName]({...fixture.input,query:{__notOfficial:true}},{authenticated:false}),KalshiContractError);
}
console.log("118 packed named facade calls passed");
`);
    assert.match(run(process.execPath,["consumer.mjs"]),/118 packed/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
