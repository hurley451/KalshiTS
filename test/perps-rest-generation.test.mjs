import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, cp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { checkPerpsGenerated, perpsGeneratedFiles, generatedFiles, compareGenerated } from "../scripts/check-generated.mjs";
import { requireCoreRoot } from "./helpers/core-root.mjs";
const core=requireCoreRoot();
const repo=process.cwd();
const source="sources/perps/perps_openapi.yaml";
const script=path.join(repo,"scripts/generate-client.mjs");
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
async function snapshot() {
 const files=[...perpsGeneratedFiles,...generatedFiles];
 const digests=await Promise.all(files.map(async f=>[f,hash(await readFile(path.join(repo,f)))]));
 digests.push([source,hash(await readFile(path.join(core,source)))]);
 return digests;
}
test("all 14 explicit outputs regenerate byte-identically without mutating any 25 source outputs",async()=>{
 assert.equal(perpsGeneratedFiles.length,14);const before=await snapshot();await checkPerpsGenerated({coreRoot:core});assert.deepEqual(await snapshot(),before);
});
test("each generated output mismatch/missing and unexpected output is rejected",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"perps-outputs-"));
 try {
  for(const file of perpsGeneratedFiles) {await mkdir(path.dirname(path.join(root,file)),{recursive:true});await cp(path.join(repo,file),path.join(root,file));}
  for(const file of perpsGeneratedFiles) {
   const target=path.join(root,file);const original=await readFile(target);
   await writeFile(target,Buffer.concat([original,Buffer.from("changed")]));await assert.rejects(compareGenerated(repo,root,perpsGeneratedFiles),/differs/);
   await rm(target);await assert.rejects(compareGenerated(repo,root,perpsGeneratedFiles),/Missing regenerated/);await writeFile(target,original);
  }
  await writeFile(path.join(root,"src/generated/perps-rest/unexpected.ts"),"unexpected");
  await assert.rejects(checkPerpsGenerated({coreRoot:core,repository:root}),/Unexpected\/missing/);
 } finally {await rm(root,{recursive:true,force:true});}
});
test("source and ledger mutations fail generation; same-count identities, all temporal preconditions and no clock-driven profile",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"perps-mutations-"));
 const before=await snapshot();
 try {
  for(const file of [source,"sources/perps/perps_openapi-source.json","sources/perps/perps_openapi-inventory.json","contracts/perps_openapi.json"]) {await mkdir(path.dirname(path.join(root,file)),{recursive:true});await cp(path.join(core,file),path.join(root,file));}
  const original=await readFile(path.join(root,source));const raw=YAML.parse(original.toString());
  const mutations=[
   s=>{s.paths["/margin/orders"].patch=s.paths["/margin/orders"].post;delete s.paths["/margin/orders"].post;},
   s=>{s.paths["/margin/renamed"]=s.paths["/margin/orders"];delete s.paths["/margin/orders"];},
   s=>s.components.schemas.CreateMarginOrderRequest.required.pop(),
   s=>delete s.paths["/margin/orders"].post.responses["409"],
   s=>s.components.schemas.CreateMarginOrderRequest.properties.self_trade_prevention_type.allOf[0].$ref="#/components/schemas/ExchangeInstance",
   s=>s.components.schemas.DecreaseMarginOrderRequest.properties.reduce_by.nullable=false,
   s=>s.components.schemas.IntraExchangeInstanceTransferRequest.properties.amount.format="int32",
   s=>s.components.schemas.GetMarginFillsResponse.required.pop(),
   s=>{s.components.schemas.GetMarginOrdersResponse.properties.orders=s.components.schemas.GetMarginOrdersResponse.properties.cursor;},
   s=>s.paths["/margin/fills"].get.security.pop(),
   s=>s.servers[0].url="https://wrong.invalid/trade-api/v2",
   ...["funding_deadband","funding_cap","funding_limit_unit","bid_size_fp","ask_size_fp","leverage_estimate","leverage_estimates"].map(k=>s=>delete s.components.schemas.MarginMarket.properties[k]),
   s=>delete s.components.schemas.IntraExchangeInstanceTransferRequest.properties.client_transfer_id,
   s=>s.paths["/margin/trades"].get.parameters[0].name="renamed_ticker"
  ];
  for(const mutation of mutations) {
   const changed=structuredClone(raw);mutation(changed);await writeFile(path.join(root,source),YAML.stringify(changed));
   const result=spawnSync(process.execPath,[script,"--product","perps","--kalshicore-root",root,"--out-dir",path.join(root,"output")],{encoding:"utf8"});
   assert.notEqual(result.status,0);assert.match(result.stderr,/Unreviewed Perps source digest/);
  }
  await writeFile(path.join(root,source),original);
  for(const file of ["sources/perps/perps_openapi-inventory.json","contracts/perps_openapi.json","sources/perps/perps_openapi-source.json"]) {
   const original=await readFile(path.join(root,file));const value=JSON.parse(original);
   if(value.entries) value.entries[0].identity.pointer+="changed";
   else if(value.rest) value.rest[0].method="POST";
   else value.sha256="changed";
   await writeFile(path.join(root,file),JSON.stringify(value));
   const result=spawnSync(process.execPath,[script,"--product","perps","--kalshicore-root",root,"--out-dir",path.join(root,"output")],{encoding:"utf8"});
   assert.notEqual(result.status,0);await writeFile(path.join(root,file),original);
  }
  const unapproved=spawnSync(process.execPath,[script,"--product","perps","--kalshicore-root",root,"--active-date","2026-10-15"],{encoding:"utf8"});assert.notEqual(unapproved.status,0);
 } finally {await rm(root,{recursive:true,force:true});assert.deepEqual(await snapshot(),before);}
});
