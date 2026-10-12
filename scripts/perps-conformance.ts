import { readFile } from "node:fs/promises";
import path from "node:path";
import { validatePerpsSourceContract } from "../src/perps-contracts.js";
import { perpsOperations } from "../src/generated/perps-rest/operations.js";

export async function runPerpsConformance(coreRoot: string): Promise<Array<{id:string;passed:boolean;message:string}>> {
  const fixture = JSON.parse(await readFile(path.join(coreRoot,"fixtures/perps/perps_openapi-cases.json"),"utf8")) as {
    sourceId:string; input:{cases:Array<{caseId:string;identity:{sourceId:string;pointer:string};operation:{sourceId:string;pointer:string};value:unknown;valid:boolean}>};
  };
  const expected = ["composed-order", "required-order", "error", "fills-pagination", "fills-terminal"].flatMap(n=>[`${n}-positive`,`${n}-negative`]).map(n=>`perps_openapi:${n}`);
  if(fixture.sourceId!=="perps_openapi" || JSON.stringify(fixture.input.cases.map(c=>c.caseId).sort())!==JSON.stringify(expected.sort())) throw new Error("Unexpected source-qualified Core Perps case set.");
  return fixture.input.cases.map(c=>{
    if(c.identity.sourceId!=="perps_openapi" || c.operation.sourceId!=="perps_openapi" || !perpsOperations.some(o=>o.identity.pointer===c.operation.pointer)) return {id:c.caseId,passed:false,message:"Invalid source operation identity."};
    let valid=true;
    try {validatePerpsSourceContract(c.caseId,"Core case",{$ref:c.identity.pointer},c.value);} catch {valid=false;}
    return {id:c.caseId,passed:valid===c.valid,message:`Source validation ${valid ? "accepted" : "rejected"}; expected ${c.valid}.`};
  });
}
