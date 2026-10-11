import { KalshiOperationError } from "./errors.js";
import { operationsById, type KalshiOperation, type OperationId } from "./generated/operations.js";
import type { PathParameters, QueryParameters, QueryParameterValue } from "./types.js";

export interface OperationRequestParts {
  readonly operationId: OperationId | string;
  readonly pathParameters?: PathParameters | undefined;
  readonly query?: QueryParameters | undefined;
}

export function getOperation(operationId: OperationId | string): KalshiOperation {
  const operation = operationsById[operationId as OperationId];
  if (!operation) {
    throw new KalshiOperationError(`Unknown Kalshi operation: ${operationId}`);
  }
  return operation;
}

export function buildOperationPath(
  operation: KalshiOperation,
  pathParameters: PathParameters = {},
  query: QueryParameters = {}
): string {
  const replaced = operation.path.replace(/\{([^}]+)}/g, (_match, name: string) => {
    if (!(name in pathParameters)) {
      throw new KalshiOperationError(`Missing path parameter "${name}" for ${operation.operationId}`);
    }
    return encodeURIComponent(String(pathParameters[name]));
  });

  const unused = Object.keys(pathParameters).filter((name) => !operation.path.includes(`{${name}}`));
  if (unused.length > 0) {
    throw new KalshiOperationError(`Unused path parameter(s) for ${operation.operationId}: ${unused.join(", ")}`);
  }

  const queryString = serializeQuery(query);
  return `${replaced}${queryString ? `?${queryString}` : ""}`;
}

export function buildTradeApiPath(pathAndQuery: string): string {
  const normalized = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  return normalized.startsWith("/trade-api/v2/") ? normalized : `/trade-api/v2${normalized}`;
}

export function serializeQuery(query: QueryParameters): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    appendQueryValue(params, name, value);
  }
  return params.toString();
}

function appendQueryValue(params: URLSearchParams, name: string, value: QueryParameterValue): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return;
    }
    params.append(name, value.map((entry) => String(entry)).join(","));
    return;
  }
  params.append(name, String(value));
}
