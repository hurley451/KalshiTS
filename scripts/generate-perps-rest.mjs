import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import YAML from "yaml";
import openapiTS, { astToString } from "openapi-typescript";
import { sample } from "openapi-sampler";

const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const core = option("--kalshicore-root") ?? process.env.KALSHICORE_ROOT;
if (!core) throw new Error("Perps generation requires --kalshicore-root.");
const activeDate = option("--active-date") ?? "2026-10-12";
if (activeDate !== "2026-10-12") throw new Error("Unreviewed Perps active date.");
const output = path.resolve(option("--out-dir") ?? ".");
const sourceId = "perps_openapi";
const coreRef = "99abf30c3fc818815e99f015299e2f4bcbf62a00";
const bytes = await readFile(path.join(core, "sources/perps/perps_openapi.yaml"));
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, "27e4b0b76a686f797342f1526a08df5b8f60d8104a81b65c94073d3d89b54308", "Unreviewed Perps source digest");
const raw = YAML.parse(bytes.toString());
const ledger = JSON.parse(await readFile(path.join(core, "sources/perps/perps_openapi-source.json")));
const inventory = JSON.parse(await readFile(path.join(core, "sources/perps/perps_openapi-inventory.json")));
const bundle = JSON.parse(await readFile(path.join(core, "contracts/perps_openapi.json")));
assert.equal(ledger.sha256, sha256);
assert.deepEqual(bundle.counts, ledger.counts);
assert.deepEqual(bundle.sources.openapi.document,raw,"Core bundle document must match raw bytes");
assert.equal(bundle.sources.openapi.sha256,sha256);
assert.deepEqual(inventory.schemas.map(s=>s.pointer),bundle.sources.openapi.schemas);
assert.deepEqual(inventory.references.map(r=>({at:r.at.pointer,target:r.target.pointer})),bundle.sources.openapi.references);
const active = structuredClone(raw);
const temporal = [];
const semanticRefinements = [];
const escape = value => value.replaceAll("~", "~0").replaceAll("/", "~1");
const pointer = (root, p) => p.slice(2).split("/").map(s => s.replaceAll("~1", "/").replaceAll("~0", "~")).reduce((n,k) => n[k], root);
function change(p, transform, effectiveDate, disposition) {
  const before = pointer(raw, p);
  assert.notEqual(before, undefined, `Missing temporal precondition ${p}`);
  temporal.push({identity:{sourceId,pointer:p}, precondition:before, preconditionHash:createHash("sha256").update(JSON.stringify(before)).digest("hex"), effectiveDate, disposition, evidenceUrl:effectiveDate===null ? "https://docs.kalshi.com/perps_openapi.yaml" : "https://docs.kalshi.com/changelog", sourceHash:sha256});
  transform();
}
const market = active.components.schemas.MarginMarket;
for (const field of ["funding_deadband", "funding_cap", "funding_limit_unit", "bid_size_fp", "ask_size_fp"]) {
  change(`#/components/schemas/MarginMarket/properties/${field}`, () => {
    delete market.properties[field];
    market.required = market.required.filter(k => k !== field);
  }, "2026-10-15", "excluded from active typed model");
}
change("#/components/schemas/MarginMarket/required",()=>{},"2026-10-15","remove only funding_deadband, funding_cap, funding_limit_unit requirements alongside their future properties");
change("#/components/schemas/IntraExchangeInstanceTransferRequest/properties/client_transfer_id", () => {
  delete active.components.schemas.IntraExchangeInstanceTransferRequest.properties.client_transfer_id;
}, "2026-10-15", "reject future request field before dispatch");
assert.equal(raw.paths["/margin/trades"].get.parameters[0].name, "ticker");
assert.equal(raw.paths["/margin/trades"].get.parameters[0].in, "query");
change("#/paths/~1margin~1trades/get/parameters/0", () => active.paths["/margin/trades"].get.parameters.shift(), "2026-10-15", "reject future ticker filter");
for (const field of ["leverage_estimate", "leverage_estimates"]) {
  assert.match(market.properties[field].description, /Null when margin config or price data is unavailable/);
  change(`#/components/schemas/MarginMarket/properties/${field}`, () => market.properties[field].nullable = true, null, "approved source-prose null compatibility; map values remain nonnullable");
}
assert(active.components.schemas.ApplySubaccountTransferRequest.required.includes("client_transfer_id"));
assert.equal(active.components.schemas.ApplySubaccountTransferRequest.properties.client_transfer_id.format, "uuid");
function refine(name, rules, transform) {
  const p = `#/components/schemas/${name}`;
  const precondition = pointer(raw,p);
  semanticRefinements.push({identity:{sourceId,pointer:p},precondition,
    preconditionHash:createHash("sha256").update(JSON.stringify(precondition)).digest("hex"),
    sourceHash:sha256,activeDate,evidenceUrl:ledger.url,rules});
  transform(active.components.schemas[name]);
}
for (const name of ["CreateMarginOrderRequest","AmendMarginOrderRequest"]) {
  const schema = raw.components.schemas[name];
  assert.match(schema.properties.ticker.description,/ticker takes precedence when both are provided/);
  assert.equal(schema.properties.ticker["x-oapi-codegen-extra-tags"].validate,"required_without=MarketId");
  assert.equal(schema.properties.market_id["x-oapi-codegen-extra-tags"].validate,"omitempty,uuid");
  refine(name,["nonempty ticker or market UUID; both permitted with ticker precedence","nonempty market_id must be a UUID; empty optional selector is omitted"],s=>{
    s.properties.market_id.anyOf = [{enum:[""]},{type:"string",format:"uuid"}];
    s.allOf = [...(s.allOf??[]),{anyOf:[
      {required:["ticker"],properties:{ticker:{type:"string",minLength:1}}},
      {required:["market_id"],properties:{market_id:{type:"string",format:"uuid"}}}
    ]}];
  });
}
const createOrder = active.components.schemas.CreateMarginOrderRequest;
assert.match(createOrder.properties.reduce_only.description,/immediate_or_cancel or fill_or_kill/);
createOrder.allOf.push({anyOf:[{properties:{reduce_only:{enum:[false]}}},{required:["time_in_force"],properties:{time_in_force:{enum:["immediate_or_cancel","fill_or_kill"]}}}]});
semanticRefinements.find(r=>r.identity.pointer.endsWith("/CreateMarginOrderRequest")).rules.push("reduce_only true requires IOC/FOK");
const decreaseOrder = active.components.schemas.DecreaseMarginOrderRequest;
assert.match(decreaseOrder.properties.reduce_by.description,/Exactly one/);
refine("DecreaseMarginOrderRequest",["exactly one non-null reduce_by/reduce_to"],s=>{
  s.oneOf = [
    {required:["reduce_by"],properties:{reduce_by:{type:"string"},reduce_to:{enum:[null]}}},
    {required:["reduce_to"],properties:{reduce_to:{type:"string"},reduce_by:{enum:[null]}}}
  ];
});
const wholeCount = "^[0-9]+(?:\\.0{1,2})?$";
const positiveWholeCount = "^0*[1-9][0-9]*(?:\\.0{1,2})?$";
const positiveDecimal = "^(?:0*[1-9][0-9]*(?:\\.[0-9]+)?|0*\\.[0-9]*[1-9][0-9]*)$";
const restrictedString = (property,pattern) => ({description:property.description,allOf:[property,{type:"string",pattern}]});
for (const name of ["CreateOrderGroupRequest","UpdateOrderGroupLimitRequest"]) {
  const schema = raw.components.schemas[name];
  assert.match(schema.properties.contracts_limit.description,/Whole contracts only/);
  assert.match(schema.properties.contracts_limit_fp.description,/if both provided they must match/);
  assert.equal(schema.properties.contracts_limit.minimum,1);
  refine(name,["at least one non-null limit","fixed-point limit represents positive whole contracts with 0-2 decimal places","both limit representations must match exactly (runtime decimal comparison)"],s=>{
    s.properties.contracts_limit_fp = {description:s.properties.contracts_limit_fp.description,
      nullable:true,allOf:[{$ref:"#/components/schemas/FixedPointCount"},{type:"string",pattern:positiveWholeCount}]};
    s.allOf = [...(s.allOf??[]),{anyOf:[
      {required:["contracts_limit"],properties:{contracts_limit:{type:"integer"}}},
      {required:["contracts_limit_fp"],properties:{contracts_limit_fp:{type:"string",pattern:positiveWholeCount}}}
    ]}];
  });
}
assert.match(raw.components.schemas.FixedPointCount.description,/Requests accept 0-2 decimal places/);
for (const name of ["UpdateExitTriggerRequest","SetCrossExitTriggerRequest","SetIsolatedExitTriggerRequest"]) {
  const schema = raw.components.schemas[name];
  for(const field of ["stop_loss_price","take_profit_price"]) assert.match(schema.properties[field].description,/strictly positive when supplied/);
  refine(name,["at least one bracket leg; supplied legs strictly positive","set requests select bracket (default) or trailing; reject the other family's fields","trailing requires exactly one distance"],s=>{
    for(const field of ["stop_loss_price","take_profit_price"]) s.properties[field] = restrictedString(s.properties[field],positiveDecimal);
    const legs = {anyOf:[
      {required:["stop_loss_price"],properties:{stop_loss_price:s.properties.stop_loss_price}},
      {required:["take_profit_price"],properties:{take_profit_price:s.properties.take_profit_price}}
    ]};
    if(name==="UpdateExitTriggerRequest") {
      assert.match(schema.description,/At least one leg is required/);
      s.allOf = [...(s.allOf??[]),legs];
      semanticRefinements.at(-1).rules = ["at least one leg; supplied legs strictly positive; omitted leg cleared"];
    } else {
      assert.match(schema.description,/supply exactly one of `trail_amount` or `trail_bps`/);
      assert.match(schema.description,/Fields belonging to the other kind are rejected/);
      s.oneOf = [
        {properties:{kind:{enum:["bracket"]},trail_amount:{enum:[null]},trail_bps:{enum:[null]}},allOf:[legs,{not:{anyOf:[{required:["trail_amount"]},{required:["trail_bps"]}]}}]},
        {required:["kind"],properties:{kind:{enum:["trailing"]},stop_loss_price:{enum:[null]},take_profit_price:{enum:[null]},...(name==="SetCrossExitTriggerRequest"?{anchor_order_id:{enum:[null]}}:{})},allOf:[
          {oneOf:[
            {required:["trail_amount"],properties:{trail_amount:s.properties.trail_amount,trail_bps:{enum:[null]}}},
            {required:["trail_bps"],properties:{trail_bps:s.properties.trail_bps,trail_amount:{enum:[null]}}}
          ]},
          {not:{anyOf:[{required:["stop_loss_price"]},{required:["take_profit_price"]},...(name==="SetCrossExitTriggerRequest"?[{required:["anchor_order_id"]}]:[])]}}
        ]}
      ];
    }
    if(name==="SetCrossExitTriggerRequest") {
      assert.match(schema.properties.count.description,/must be a whole number of contracts/);
      assert.match(schema.properties.anchor_order_id.description,/Bracket only; mutually exclusive with `count`/);
      assert.match(schema.properties.client_trigger_id.description,/required on a `count` or `anchor_order_id` create/);
      assert.match(schema.properties.client_trigger_id.description,/rejected on every other write/);
      s.properties.count = restrictedString(s.properties.count,wholeCount);
      s.allOf = [...(s.allOf??[]),{not:{required:["count","anchor_order_id"]}},{oneOf:[
        {required:["client_trigger_id"],properties:{client_trigger_id:{type:"string",minLength:1}},oneOf:[
          {required:["count"],properties:{count:s.properties.count,anchor_order_id:{enum:[null]}}},
          {required:["anchor_order_id"],properties:{anchor_order_id:s.properties.anchor_order_id,count:{enum:[null]}}}
        ]},
        {properties:{count:{enum:[null]},anchor_order_id:{enum:[null]},client_trigger_id:{enum:[null]}},not:{anyOf:[{required:["count"]},{required:["anchor_order_id"]},{required:["client_trigger_id"]}]}}
      ]}];
      semanticRefinements.at(-1).rules.push("whole count; count and anchor mutually exclusive; anchor bracket-only","client_trigger_id required for count/anchor creates and rejected otherwise");
    }
  });
}
const resolve = value => value?.$ref ? resolve(pointer(active, value.$ref)) : value;
const domain = tag => ({account:"account",portfolio:"portfolio",exit_triggers:"exitTriggers",exchange:"exchange",fcm:"fcm",fees:"fees",funding:"funding",market:"markets",markets:"markets",risk:"risk",order_groups:"orderGroups",orders:"orders"})[tag] ?? tag.replace(/[-_]([a-z])/g,(_,c)=>c.toUpperCase());
const entries = [];
for (const [route,item] of Object.entries(active.paths)) for (const [verb,op] of Object.entries(item)) {
  if (!op.operationId) continue;
  const identity = {sourceId,pointer:`#/paths/${escape(route)}/${verb}`};
  const original = pointer(raw, identity.pointer);
  const imported = bundle.rest.find(e => e.id === op.operationId);
  assert(imported, `Missing Core operation ${op.operationId}`);
  assert.equal(imported.source, identity.pointer);
  assert.equal(imported.method, verb.toUpperCase());
  assert.deepEqual(imported.security, original.security ?? raw.security ?? []);
  assert.deepEqual(imported.responses.map(r => r.status), Object.keys(original.responses));
  assert.deepEqual(imported.parameters,[...(item.parameters??[]),...(original.parameters??[])].map(p=>p.$ref?pointer(raw,p.$ref):p));
  entries.push({identity, operationId:op.operationId,method:verb.toUpperCase(),path:route,domain:domain(op.tags[0]),methodName:op.operationId[0].toLowerCase()+op.operationId.slice(1),parameters:[...(item.parameters??[]),...(op.parameters??[])].map(resolve),requestBody:resolve(op.requestBody),responses:Object.fromEntries(Object.entries(op.responses).map(([s,r])=>[s,resolve(r)])),security:original.security??raw.security??[],description:original.description,authenticated:(original.security??raw.security??[]).length>0});
}
entries.sort((a,b)=>a.operationId.localeCompare(b.operationId));
assert.equal(entries.length,51);
assert.equal(Object.keys(raw.components.schemas).length,88);
assert.equal(entries.reduce((n,e)=>n+Object.keys(e.responses).length,0),236);
assert.equal(new Set(entries.map(e=>e.domain)).size,11);
assert.deepEqual(entries.map(e=>e.identity.pointer).sort(),inventory.entries.map(e=>e.identity.pointer).sort());
const pagers = entries.filter(e=>e.parameters.some(p=>p.in==="query"&&p.name==="cursor"));
assert.deepEqual(pagers.map(e=>e.operationId),["GetMarginFills","GetMarginOrders","GetMarginTrades"]);
for (const e of pagers) {
  e.collection = ({GetMarginFills:"fills",GetMarginOrders:"orders",GetMarginTrades:"trades"})[e.operationId];
  const schema = resolve(e.responses["200"].content["application/json"].schema);
  assert(schema.required.includes("cursor") && schema.required.includes(e.collection));
  assert.equal(schema.properties.cursor.type,"string");
  assert.equal(schema.properties[e.collection].type,"array");
}
const info = {sourceId,url:ledger.url,sha256,coreRef,activeDate,operationCount:51,modelCount:88,schemaRootCount:213,referenceCount:457,responseBindingCount:236,domainCount:11,paginatorCount:3};
for(const rule of semanticRefinements) rule.affectedOperations = entries.filter(e=>e.requestBody?.content?.["application/json"]?.schema?.$ref===rule.identity.pointer).map(e=>e.identity);
for(const rule of temporal) rule.affectedOperations = entries.filter(e=>
  rule.identity.pointer.includes("MarginMarket/") ? ["GetMarginMarkets","GetMarginMarket"].includes(e.operationId)
  : rule.identity.pointer.includes("IntraExchangeInstanceTransferRequest") ? e.operationId==="IntraExchangeInstanceTransfer"
  : rule.identity.pointer.startsWith("#/paths/~1margin~1trades/") ? e.operationId==="GetMarginTrades" : false
).map(e=>e.identity);
const banner = `// Generated by scripts/generate-client.mjs --product perps; do not edit.\n// Source ${sourceId} SHA-256: ${sha256}; active ${activeDate}.\n`;
const root = "src/generated/perps-rest";
async function write(file,text) { const target=path.join(output,file); await mkdir(path.dirname(target),{recursive:true}); await writeFile(target,text); }
const json = (file,value) => write(file,JSON.stringify(value,null,2)+"\n");
function nullableUnions(value) {
  if(Array.isArray(value)) return value.map(nullableUnions);
  if(!value||typeof value!=="object") return value;
  const n=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,["example","examples","default","enum"].includes(k)?v:nullableUnions(v)]));
  if(n.nullable===true) {delete n.nullable; if(n.enum&&!n.enum.includes(null)) return n; return {anyOf:[n,{type:"null"}]};} return n;
}
await write(`${root}/source-schema.ts`,banner+astToString(await openapiTS(nullableUnions(raw),{defaultNonNullable:false})));
await write(`${root}/schema.ts`,banner+astToString(await openapiTS(nullableUnions(active),{defaultNonNullable:false})));
await write(`${root}/operations.ts`,banner+`export const perpsOperationSource = ${JSON.stringify(info)} as const;\nexport const perpsOperations = ${JSON.stringify(entries.map(({identity,operationId,method,path,domain,methodName,security,description})=>({identity,operationId,method,path,domain,methodName,security,description})))} as const;\nexport type PerpsOperationId = typeof perpsOperations[number]["operationId"];\n`);
await write(`${root}/contracts.ts`,banner+`import type { OperationContract } from "../contracts.js";\nexport const perpsContractComponents: Record<string, unknown> = ${JSON.stringify(active.components)};\nexport const perpsSourceComponents: Record<string, unknown> = ${JSON.stringify(raw.components)};\nexport const perpsOperationContracts: Record<string, OperationContract> = ${JSON.stringify(Object.fromEntries(entries.map(e=>[e.operationId,e])))};\n`);
let models=banner+`import type { components, operations } from "./schema.js";
import type { components as SourceComponents } from "./source-schema.js";
import type { EndpointOptions } from "../../endpoint-options.js";
export type { PerpsOperationId } from "./operations.js";
export type PerpsModels = components["schemas"];
export type PerpsSourceModels = SourceComponents["schemas"];
type Id = keyof operations;
type Content<T> = T extends {content: infer C} ? C[keyof C] : undefined;
type ResponseBody<T,S> = S extends 204 ? undefined : T extends {content:infer C} ? C[keyof C] : unknown;
type Success<T> = { [K in keyof T]: K extends number ? \`\${K}\` extends \`2\${string}\` ? K : never : never }[keyof T];
type Responses<I extends Id> = operations[I]["responses"];
export type PerpsOperationResponse<I extends Id> = { [S in Success<Responses<I>>]: ResponseBody<Responses<I>[S],S> }[Success<Responses<I>>];
export type PerpsOperationError<I extends Id> = { [S in Exclude<keyof Responses<I>,Success<Responses<I>>>]: {status:S;body:ResponseBody<Responses<I>[S],S>} }[Exclude<keyof Responses<I>,Success<Responses<I>>>];
type Params<I extends Id> = operations[I]["parameters"];
type Part<I extends Id,K extends string,N extends string> = K extends keyof Params<I> ? [NonNullable<Params<I>[K]>] extends [never] ? {[P in N]?:never} : {} extends NonNullable<Params<I>[K]> ? {[P in N]?:NonNullable<Params<I>[K]>} : {[P in N]:NonNullable<Params<I>[K]>} : {[P in N]?:never};
type Body<I extends Id> = "requestBody" extends keyof operations[I] ? [NonNullable<operations[I]["requestBody"]>] extends [never] ? {body?:never} : operations[I] extends {requestBody:unknown} ? {body:Content<NonNullable<operations[I]["requestBody"]>>} : {body?:Content<NonNullable<operations[I]["requestBody"]>>} : {body?:never};
export type PerpsOperationInput<I extends Id> = Part<I,"path","pathParameters"> & Part<I,"query","query"> & Part<I,"header","parameterHeaders"> & Part<I,"cookie","cookies"> & Body<I>;
export type PerpsEndpointArguments<I extends Id> = {} extends PerpsOperationInput<I> ? [input?:PerpsOperationInput<I>,options?:EndpointOptions] : [input:PerpsOperationInput<I>,options?:EndpointOptions];
export type PerpsPaginatedOperationId = "GetMarginFills" | "GetMarginOrders" | "GetMarginTrades";
export type PerpsPaginationArguments<I extends PerpsPaginatedOperationId> = [input?:PerpsOperationInput<I>,options?:EndpointOptions,pagination?:import("../../pagination.js").PaginationOptions];
`;
for(const e of entries) for(const [suffix,type] of [["Input","PerpsOperationInput"],["Result","PerpsOperationResponse"],["Error","PerpsOperationError"]]) models+=`export type Perps${e.operationId}${suffix} = ${type}<${JSON.stringify(e.operationId)}>;\n`;
await write(`${root}/models.ts`,models);
let endpoints=banner+`import type { PerpsOperationId, PerpsEndpointArguments, PerpsOperationInput, PerpsOperationResponse, PerpsPaginationArguments } from "./models.js";\nimport type { EndpointOptions } from "../../endpoint-options.js";\nimport { paginatePages } from "../../pagination.js";\nexport abstract class PerpsTypedEndpoints {\n protected abstract executeTyped(id:PerpsOperationId,input?:unknown,options?:EndpointOptions):Promise<unknown>;\n`;
for(const e of entries) endpoints+=` ${e.methodName}(...args:PerpsEndpointArguments<"${e.operationId}">):Promise<PerpsOperationResponse<"${e.operationId}">> { return this.executeTyped("${e.operationId}",...args) as Promise<PerpsOperationResponse<"${e.operationId}">>; }\n`;
for(const e of pagers) endpoints+=` ${e.methodName}Pages(...args:PerpsPaginationArguments<"${e.operationId}">):AsyncGenerator<PerpsOperationResponse<"${e.operationId}">,void,unknown> { return paginatePages("perps_openapi:${e.operationId}",(input:PerpsOperationInput<"${e.operationId}">,options)=>this.${e.methodName}(input,options),args[0]??{},"cursor",args[1],args[2]); }\n`;
for(const d of new Set(entries.map(e=>e.domain))) {const names=entries.filter(e=>e.domain===d).flatMap(e=>[e.methodName,...(pagers.includes(e)?[e.methodName+"Pages"]:[])]);endpoints+=` readonly ${d}:Pick<PerpsTypedEndpoints,${names.map(JSON.stringify).join("|")}> = {${names.map(n=>`${n}:this.${n}.bind(this)`).join(",")}};\n`;}
await write(`${root}/endpoints.ts`,endpoints+"}\n");
// Material prose constraints need independent canonical inputs, not sampler guesses.
const semanticModelFixtures = {
  CreateOrderGroupRequest:{contracts_limit:1},
  UpdateOrderGroupLimitRequest:{contracts_limit:1},
  UpdateExitTriggerRequest:{stop_loss_price:"1.0000"},
  SetCrossExitTriggerRequest:{stop_loss_price:"1.0000"},
  SetIsolatedExitTriggerRequest:{stop_loss_price:"1.0000"}
};
function sampleActive(schema) {
  const name = schema.$ref?.split("/").at(-1);
  return name && semanticModelFixtures[name] ? structuredClone(semanticModelFixtures[name]) : sample(schema,{skipNonRequired:true},active);
}
const fixtures=entries.map(e=>{
 const input={};for(const p of e.parameters) (input[{path:"pathParameters",query:"query",header:"parameterHeaders",cookie:"cookies"}[p.in]]??={})[p.name]=p.in==="path"&&p.name==="ticker" ? "BTC /?&" : p.in==="query"&&p.name==="cursor" ? "next /?&" : sample(p.schema??{}, {},active);
 if(e.requestBody) input.body=sampleActive(e.requestBody.content["application/json"].schema);
 if(e.operationId==="CreateMarginOrder") input.body.ticker="BTC";
 if(e.operationId==="DecreaseMarginOrder") {delete input.body.reduce_to;input.body.reduce_by="1.00";}
 return {...e,input,responses:Object.entries(e.responses).map(([status,r])=>({status:Number(status),...(r.content?.["application/json"]?.schema?{body:sample(r.content["application/json"].schema,{skipNonRequired:true},active)}:{})}))};
});
const schemaFixtures=Object.entries(active.components.schemas).map(([name,s])=>({name,value:semanticModelFixtures[name]??sample(s,{skipNonRequired:true},active),sourceValue:sample(raw.components.schemas[name],{skipNonRequired:true},raw)}));
await json("test/perps-rest/fixtures.json",{...info,fixtures,schemaFixtures});
let proof=banner+`import type {KalshiPerpsClient,PerpsModels,PerpsSourceModels,PerpsOperationError,PerpsOperationResponse} from "../../src/index.js";\nfunction proof(client:KalshiPerpsClient) {\n`;
for(const f of fixtures) {
 proof+=` client.${f.methodName}(${JSON.stringify(f.input)}); client.${f.domain}.${f.methodName}(${JSON.stringify(f.input)});\n // @ts-expect-error wrong query member\n client.${f.methodName}(${JSON.stringify({...f.input,query:{__invalid:true}})});\n`;
 for(const r of f.responses) {
   if(r.status>=300) proof+=` const e${f.operationId}${r.status}:PerpsOperationError<"${f.operationId}">={status:${r.status},body:${JSON.stringify(r.body)??"undefined"}};void e${f.operationId}${r.status};\n`;
   else proof+=` const r${f.operationId}${r.status}:PerpsOperationResponse<"${f.operationId}">=${JSON.stringify(r.body)??"undefined"};void r${f.operationId}${r.status};\n`;
 }
 proof+=` // @ts-expect-error undeclared status cannot narrow\n const badStatus${f.operationId}:PerpsOperationError<"${f.operationId}">={status:-1,body:undefined};void badStatus${f.operationId};\n`;
 for(const p of f.parameters) {const key={path:"pathParameters",query:"query",header:"parameterHeaders",cookie:"cookies"}[p.in];proof+=` // @ts-expect-error wrong parameter primitive\n client.${f.methodName}(${JSON.stringify({...f.input,[key]:{...f.input[key],[p.name]:{wrong:true}}})});\n`;}
 if(f.parameters.some(p=>p.required)||f.requestBody?.required) proof+=` // @ts-expect-error required inputs\n client.${f.methodName}();\n`;
}
for(const f of schemaFixtures) {
 proof+=` const m${f.name}:PerpsModels["${f.name}"]=${JSON.stringify(f.value)};void m${f.name};\n const s${f.name}:PerpsSourceModels["${f.name}"]=${JSON.stringify(f.sourceValue)};void s${f.name};\n`;
 for(const [map,value,schema] of [["PerpsModels",f.value,active.components.schemas[f.name]],["PerpsSourceModels",f.sourceValue,raw.components.schemas[f.name]]]) {
   const bad=schema.type==="string"?42:schema.type==="integer"||schema.type==="number"?"wrong":42;
   proof+=` // @ts-expect-error incompatible model primitive\n const bad${map}${f.name}:${map}["${f.name}"]=${JSON.stringify(bad)};void bad${map}${f.name};\n`;
   for(const key of schema.required??[]) {const v={...value};delete v[key];proof+=` // @ts-expect-error required model member\n const missing${map}${f.name}${key}:${map}["${f.name}"]=${JSON.stringify(v)};void missing${map}${f.name}${key};\n`;}
   for(const [key,p] of Object.entries(schema.properties??{})) {
     const resolved=p.$ref?pointer(map==="PerpsModels"?active:raw,p.$ref):p;
     if(resolved.enum) proof+=` // @ts-expect-error enum outlier\n const enum${map}${f.name}${key}:${map}["${f.name}"]=${JSON.stringify({...value,[key]:"__outside_enum__"})};void enum${map}${f.name}${key};\n`;
     if(p.nullable===true||resolved.nullable===true) {
       const nullValue={...value,[key]:null};
       if(map==="PerpsModels"&&f.name==="DecreaseMarginOrderRequest") nullValue[key==="reduce_by"?"reduce_to":"reduce_by"]="1.00";
       proof+=` const null${map}${f.name}${key}:${map}["${f.name}"]=${JSON.stringify(nullValue)};void null${map}${f.name}${key};\n`;
     }
   }
 }
}
await write("test/perps-rest/contracts.test.ts",proof+"}\nvoid proof;\n");
await write("test/perps-rest/pagination-contracts.test.ts",banner+`import type {KalshiPerpsClient,PerpsOperationResponse} from "../../src/index.js";\nfunction proof(c:KalshiPerpsClient) {\n`+pagers.map(e=>` const ${e.methodName}:AsyncIterableIterator<PerpsOperationResponse<"${e.operationId}">>=c.${e.domain}.${e.methodName}Pages({},undefined,{maxPages:3});void ${e.methodName};\n`).join("")+"}\nvoid proof;\n");
await json(`${root}/coverage.json`,{...info,operations:entries});
const nodes=[];
function visit(node,pointer) {
 if(!node||typeof node!=="object") return;
 const keys=["$ref","type","enum","nullable","required","allOf","oneOf","anyOf","minimum","maximum","exclusiveMinimum","exclusiveMaximum","multipleOf","minLength","maxLength","pattern","minItems","maxItems","uniqueItems","minProperties","maxProperties","additionalProperties","format"];
 const keywords=Object.fromEntries(keys.filter(k=>Object.hasOwn(node,k)).map(k=>[k,node[k]]));
 if(Object.keys(keywords).length) nodes.push({identity:{sourceId,pointer},keywords});
 for(const [k,v] of Object.entries(node)) if(v&&typeof v==="object") visit(v,`${pointer}/${escape(k)}`);
}
visit(raw,"#");
const responseBindings=bundle.rest.flatMap(e=>e.responses.map(r=>({identity:{sourceId,pointer:`${e.source}/responses/${escape(r.status)}`},operation:e.identity,operationId:e.id,status:r.status,bodyDeclaration:r.bodyDeclaration})));
await json(`${root}/schema-coverage.json`,{...info,models:Object.keys(raw.components.schemas),schemas:inventory.schemas,references:inventory.references,nodes,responseBindings});
await json(`${root}/pagination-coverage.json`,{...info,operations:pagers.map(e=>({identity:e.identity,operationId:e.operationId,pageMethod:e.methodName+"Pages",collection:e.collection,query:e.parameters,response:e.responses["200"]}))});
await json(`${root}/source-gaps.json`,{...info,gaps:ledger.gaps.map((g,i)=>({...g,coreLedger:`sources/perps/perps_openapi-source.json#/gaps/${i}`,sdkDisposition:"Preserve raw security alternatives; existing trading-key signer emits all three signing headers."})),compatibility:temporal.filter(t=>t.effectiveDate===null),refinements:semanticRefinements});
await json(`${root}/temporal-coverage.json`,{...info,rules:temporal,restrictedKeyNotice:"Preserved source descriptions; no early access policy or OAuth implementation."});
console.log(`Perps: 51 operations, 88 models, 236 response bindings, 3 pagers; ${sha256}.`);
