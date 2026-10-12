import AjvModule, { type ValidateFunction } from "ajv-draft-04";
import addFormatsModule from "ajv-formats";
import { contractComponents, operationContracts, type OperationContract, type ParameterContract } from "./generated/contracts.js";
import { KalshiContractError } from "./errors.js";
import type { TypedOperationId } from "./generated/models.js";

// These CommonJS packages expose their callable default through Node's ESM interop.
const Ajv = AjvModule as unknown as typeof AjvModule.default;
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addFormat("int32", { type: "number", validate: n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 });
ajv.addFormat("int64", { type: "number", validate: Number.isSafeInteger });
ajv.addFormat("double", { type: "number", validate: Number.isFinite });
ajv.addSchema({ id: "kalshi-contract", components: relocateRefs(contractComponents) });
const validators = new Map<string, ValidateFunction>();

function relocateRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relocateRefs);
  if (value !== null && typeof value === "object") {
    const record = Object.fromEntries(Object.entries(value).map(([k,v]) =>
      [k, k === "$ref" && typeof v === "string" && v.startsWith("#/") ? `kalshi-contract${v}` : relocateRefs(v)]));
    // OpenAPI nullable also occurs on references and allOf, without a local type.
    if (record.nullable === true) {
      delete record.nullable;
      const restrictions: Record<string, unknown>[] = [];
      for (const key of ["enum", "const"]) {
        if (Object.hasOwn(record, key)) {
          restrictions.push({enum: key === "const" ? [record[key]] : record[key]});
          delete record[key];
        }
      }
      return { allOf: [{anyOf: [record, {type:"null"}]}, ...restrictions] };
    }
    if (Object.hasOwn(record, "const")) {
      record.allOf = [...(record.allOf as unknown[] ?? []), {enum: [record.const]}];
      delete record.const;
    }
    return record;
  }
  return value;
}

export function validateContract(id: string, part: string, schema: Record<string, unknown>, value: unknown): void {
  const key = `${id}:${part}`;
  let validator = validators.get(key);
  if (!validator) {
    validator = ajv.compile(relocateRefs(schema) as Record<string, unknown>);
    validators.set(key, validator);
  }
  if (!validator(value)) throw new KalshiContractError(id, part, ajv.errorsText(validator.errors));
}

export function validateEndpointInput(id: TypedOperationId, input: unknown): void {
  const contract = operationContracts[id]!;
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new KalshiContractError(id,"input","expected an object");
  const parts = input as Record<string, unknown>;
  for (const key of Object.keys(parts)) if (!["pathParameters","query","parameterHeaders","cookies","body"].includes(key)) throw new KalshiContractError(id,"input",`unknown input field ${key}`);
  for (const [location, name] of [["path", "pathParameters"], ["query", "query"], ["header", "parameterHeaders"], ["cookie", "cookies"]]) {
    const parameters = contract.parameters.filter(p => p.in === location);
    validateContract(id, name!, { type: "object", properties: Object.fromEntries(parameters.map(p => [p.name,p.schema ?? {}])),
      ...(parameters.some(p => p.required) ? {required: parameters.filter(p => p.required).map(p => p.name)} : {}), additionalProperties: false }, parts[name!] === undefined ? {} : parts[name!]);
  }
  const body = contract.requestBody;
  if (parts.body === undefined) {
    if (body?.required) throw new KalshiContractError(id, "body", "required request body is missing");
  } else {
    if (!body) throw new KalshiContractError(id, "body", "operation has no request body");
    const schema = body.content["application/json"]?.schema;
    if (!schema) throw new KalshiContractError(id, "body", "unsupported request media type");
    validateContract(id, "body", schema, parts.body);
  }
}

export function validateEndpointResponse(id: TypedOperationId, status: number, value: unknown): boolean {
  const responses = operationContracts[id]!.responses;
  const declared = responses[String(status)] ?? responses[`${Math.floor(status / 100)}XX`] ?? responses.default;
  if (!declared) return false;
  const content = declared.content;
  if (!content || Object.keys(content).length === 0) {
    // Omitted content is unspecified; HTTP 204 alone guarantees an empty body.
    if (status === 204 && value !== undefined) throw new KalshiContractError(id, `response:${status}`, "expected an empty response");
  } else {
    const schema = content["application/json"]?.schema;
    if (!schema) throw new KalshiContractError(id, `response:${status}`, "unsupported response media type");
    validateContract(id, `response:${status}`, schema, value);
  }
  return true;
}

export function endpointPath(contract: OperationContract, input: Record<string, unknown>): string {
  const paths = (input.pathParameters ?? {}) as Record<string, unknown>;
  const path = contract.path.replace(/\{([^}]+)}/g, (_, name: string) => {
    const parameter = contract.parameters.find(p => p.in === "path" && p.name === name)!;
    return serializePathParameter(parameter, paths[name]);
  });
  const query = (input.query ?? {}) as Record<string, unknown>;
  const values: string[] = [];
  const encode = (v: unknown) => encodeURIComponent(String(v));
  for (const parameter of contract.parameters.filter(p => p.in === "query")) {
    const value = query[parameter.name];
    if (value === undefined) continue;
    const name = encode(parameter.name);
    const style = parameter.style ?? "form";
    const explode = parameter.explode ?? style === "form";
    if (Array.isArray(value)) {
      if (explode && style === "form") values.push(...value.map(v => `${name}=${encode(v)}`));
      else values.push(`${name}=${value.map(encode).join(style === "spaceDelimited" ? "%20" : style === "pipeDelimited" ? "%7C" : "%2C")}`);
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (style === "deepObject") values.push(...entries.map(([k,v]) => `${name}%5B${encode(k)}%5D=${encode(v)}`));
      else if (explode) values.push(...entries.map(([k,v]) => `${encode(k)}=${encode(v)}`));
      else values.push(`${name}=${entries.flatMap(([k,v])=>[encode(k),encode(v)]).join("%2C")}`);
    } else values.push(`${name}=${encode(value)}`);
  }
  return `${path}${values.length ? `?${values.join("&")}` : ""}`;
}

function serializePathParameter(parameter: ParameterContract, value: unknown): string {
  const encode = (v: unknown) => encodeURIComponent(String(v));
  const style = parameter.style ?? "simple";
  const explode = parameter.explode ?? false;
  let result: string;
  if (Array.isArray(value)) result = value.map(encode).join(explode && style === "label" ? "." : explode && style === "matrix" ? `;${encode(parameter.name)}=` : ",");
  else if (value !== null && typeof value === "object") result = Object.entries(value).map(([k,v]) => `${encode(k)}${explode ? "=" : ","}${encode(v)}`).join(explode && style === "label" ? "." : explode && style === "matrix" ? ";" : ",");
  else result = encode(value);
  return style === "label" ? `.${result}` : style === "matrix" ? `;${encode(parameter.name)}=${result}` : result;
}
