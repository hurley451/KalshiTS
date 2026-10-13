import { KalshiContractError } from "./errors.js";
import { cfContracts } from "./generated/cf-rest/contracts.js";
import type { CfOperationId, CfQueryPairs } from "./generated/cf-rest/models.js";

export { cfContracts };
export const cfReadTokenCost = 50;
export function isCfOperation(id: string): id is CfOperationId {
  return Object.hasOwn(cfContracts, id);
}
export function cfOperationCost(id: string): number {
  return isCfOperation(id) || id.startsWith("cfbenchmarks-rest-manual:cfbenchmarks.") ? cfReadTokenCost : 1;
}

// ES2022 has no String.isWellFormed; validate paired UTF-16 without coercion.
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function cfPath(id: CfOperationId, providerPath: unknown, queryPairs: unknown = []): string {
  const fail = (part: string): never => { throw new KalshiContractError(`cfbenchmarks-rest-manual:${id}`, part, "invalid CF request"); };
  if (typeof providerPath !== "string" || !providerPath || !wellFormed(providerPath)
    || /[\\%?#\u0000-\u001f\u007f-\u009f]/.test(providerPath)
    || /^[a-z][a-z0-9+.-]*:/i.test(providerPath)
    || providerPath.split("/").some(segment => !segment || segment === "." || segment === "..")) fail("providerPath");
  const fixed = cfContracts[id].request.passthrough.providerPath;
  if (fixed !== "decoded-relative-segments" && fixed !== providerPath) fail("providerPath");
  if (!Array.isArray(queryPairs)) fail("queryPairs");
  const pairs: [string, string][] = [];
  const input = queryPairs as unknown[];
  for (let i = 0; i < input.length; i++) {
    if (!Object.hasOwn(input, i)) fail("queryPairs");
    const pair = input[i];
    if (!Array.isArray(pair) || pair.length !== 2 || !Object.hasOwn(pair, 0) || !Object.hasOwn(pair, 1)) return fail("queryPairs");
    const key: unknown = pair[0];
    const value: unknown = pair[1];
    if (typeof key !== "string" || typeof value !== "string" || !wellFormed(key) || !wellFormed(value)) return fail("queryPairs");
    if (key !== "includeVerification") pairs.push([key, value]);
  }
  const pathname = cfContracts[id].request.passthrough.prefix + (providerPath as string).split("/").map(encodeURIComponent).join("/");
  const check = new URL(pathname, "https://cf.invalid");
  if (check.origin !== "https://cf.invalid" || check.pathname !== pathname) fail("providerPath");
  const query = new URLSearchParams(pairs).toString();
  return pathname + (query ? `?${query}` : "");
}

export function cfQueryRecord(query: unknown): CfQueryPairs {
  if (Array.isArray(query)) return query as CfQueryPairs;
  if (query === null || typeof query !== "object") throw new KalshiContractError("cfbenchmarks-rest-manual", "query", "expected string record or ordered pairs");
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (typeof value !== "string") throw new KalshiContractError("cfbenchmarks-rest-manual", "query", "expected string values");
    pairs.push([key, value]);
  }
  return pairs;
}
