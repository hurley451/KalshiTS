import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { requireCoreRoot } from "./helpers/core-root.mjs";

test("installed NodeNext consumer: all 51 methods, 88 raw/active models, 185 errors, 3 pagers and full signed socket matrix",()=>{
 const repository=process.cwd();const root=mkdtempSync(path.join(tmpdir(),"kalshi-perps-consumer-"));
 const run=(command,args,cwd=root)=>execFileSync(command,args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"],env:{...process.env,npm_config_cache:path.join(root,"npm-cache")}});
 try {
   // npm test builds once; parallel consumers must not rebuild shared output.
   const output=run("npm",["pack","--ignore-scripts","--json","--pack-destination",root],repository);
   const pack=JSON.parse(output.slice(output.indexOf("[")))[0];
   for(const name of ["client","contracts","errors","environment"]) for(const ext of ["js","d.ts"]) assert(pack.files.some(f=>f.path===`dist/src/perps-${name}.${ext}`));
   for(const name of ["coverage","schema-coverage","pagination-coverage","source-gaps","temporal-coverage"]) assert(pack.files.some(f=>f.path===`src/generated/perps-rest/${name}.json`));
   assert(pack.files.every(f=>!/^dist\/(test|scripts)\//.test(f.path)&&!/^test\//.test(f.path)));
   writeFileSync(path.join(root,"package.json"),JSON.stringify({type:"module",private:true}));
   run("npm",["install","--ignore-scripts","--no-audit","--no-fund",path.join(root,pack.filename)]);
   const proofs=["contracts","pagination-contracts"].map(n=>readFileSync(path.join(repository,`test/perps-rest/${n}.test.ts`),"utf8").replace('"../../src/index.js"','"@hurley451/kalshi-ts"'));
   proofs.forEach((proof,i)=>writeFileSync(path.join(root,`consumer${i}.mts`),proof));
   writeFileSync(path.join(root,"negative.mts"),`
import {KalshiPerpsClient,type PerpsModels,type PerpsSourceModels,type PerpsOperationId} from "@hurley451/kalshi-ts";
declare const c:KalshiPerpsClient;declare const m:PerpsModels["MarginMarket"];declare const raw:PerpsSourceModels["MarginMarket"];
// @ts-expect-error Predictions APIs must not leak
c.getFills();
// @ts-expect-error Predictions operation IDs must not leak
const op:PerpsOperationId="GetFills";
// @ts-expect-error future trades ticker
c.getMarginTrades({query:{ticker:"BTC"}});
// @ts-expect-error future market property
m.funding_cap;
raw.funding_cap;
// @ts-expect-error current UUID is required
c.applyMarginSubaccountTransfer({body:{from_subaccount:0,to_subaccount:1,amount:1}});
// @ts-expect-error future intra-exchange client_transfer_id
c.intraExchangeInstanceTransfer({body:{source:"main",destination:"margin",amount:1,client_transfer_id:"uuid"}});
void op;
`);
   const args=[path.join(repository,"node_modules/typescript/lib/tsc.js"),"--strict","--noEmit","--module","NodeNext","--moduleResolution","NodeNext","--target","ES2022","--typeRoots",path.join(repository,"node_modules/@types"),"consumer0.mts","consumer1.mts","negative.mts"];
   run(process.execPath,args);run(process.execPath,[...args,"--exactOptionalPropertyTypes"]);
   writeFileSync(path.join(root,"wire.mjs"),readFileSync(path.join(repository,"test/helpers/perps-wire.mjs")));
   writeFileSync(path.join(root,"fixtures.json"),readFileSync(path.join(repository,"test/perps-rest/fixtures.json")));
   const core=requireCoreRoot();
   writeFileSync(path.join(root,"source.json"),JSON.stringify(YAML.parse(readFileSync(path.join(core,"sources/perps/perps_openapi.yaml"),"utf8"))));
   writeFileSync(path.join(root,"consumer.mjs"),`
import * as sdk from "@hurley451/kalshi-ts";
import fs from "node:fs";
import assert from "node:assert/strict";
import {runPerpsWireProof} from "./wire.mjs";
const data=JSON.parse(fs.readFileSync("fixtures.json"));
const result=await runPerpsWireProof(sdk,data,JSON.parse(fs.readFileSync("source.json")));
const coverage=JSON.parse(fs.readFileSync("node_modules/@hurley451/kalshi-ts/src/generated/perps-rest/coverage.json"));
assert.equal(coverage.sha256,data.sha256);assert.equal(coverage.operationCount,51);assert.equal(coverage.modelCount,88);assert.equal(coverage.paginatorCount,3);
assert.equal(JSON.parse(fs.readFileSync("node_modules/@hurley451/kalshi-ts/package.json")).kalshiCoreRef,"d898aff6834ddd7862d99ba660da3b7d8bb7013c");
console.log(JSON.stringify(result));
`);
   const result=JSON.parse(run(process.execPath,["consumer.mjs"]).trim());
   assert.equal(result.responseDispatches,472);assert.equal(result.signedDispatches,102);assert.equal(result.mutationNoReplay,72);
 } finally {rmSync(root,{recursive:true,force:true});}
});
