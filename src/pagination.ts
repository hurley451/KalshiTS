import type { EndpointOptions } from "./endpoint-options.js";

export interface PaginationOptions {
  /** Maximum HTTP pages, default 1000. Zero produces an empty iterator. */
  readonly maxPages?: number;
}

export class KalshiPaginationError extends Error {
  constructor(readonly operationId: string, readonly cursor: string) {
    super(`${operationId} pagination returned a previously used cursor.`);
    this.name = "KalshiPaginationError";
  }
}

// Snapshot once; request each page only when the consumer advances the iterator.
export function paginatePages<Input extends object, Page>(
  operationId: string,
  fetchPage: (input: Input, options?: EndpointOptions) => Promise<Page>,
  input: Input,
  cursorField: string,
  options?: EndpointOptions,
  pagination: PaginationOptions = {}
): AsyncGenerator<Page, void, unknown> {
  const maxPages = pagination.maxPages ?? 1000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 0) {
    throw new RangeError("maxPages must be a nonnegative safe integer.");
  }
  const initialInput = structuredClone(input);
  const endpointOptions = options === undefined ? undefined : {
    ...options, ...(options.headers === undefined ? {} : { headers: { ...options.headers } })
  };
  return (async function* () {
    const initialQuery = (initialInput as { query?: Record<string, unknown> } | null)?.query;
    let cursor = initialQuery?.cursor;
    const seen = new Set<string>();
    if (typeof cursor === "string" && cursor !== "") seen.add(cursor);
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const request = pageIndex === 0 ? structuredClone(initialInput)
        : { ...structuredClone(initialInput), query: { ...structuredClone(initialQuery), cursor } };
      const page = await fetchPage(request, endpointOptions);
      const nextCursor = (page as Record<string, unknown>)[cursorField];
      yield page;
      if (pageIndex + 1 === maxPages) return;
      if (nextCursor === undefined || nextCursor === "") return;
      if (typeof nextCursor !== "string") throw new TypeError(`${operationId} response cursor must be a string.`);
      if (seen.has(nextCursor)) throw new KalshiPaginationError(operationId, nextCursor);
      seen.add(nextCursor);
      cursor = nextCursor;
    }
  })();
}
