import type { StreamHandle } from "./session.js";
const handles = new WeakMap<object, StreamHandle>();
export function internalHandle(value: object): StreamHandle {
  const handle = handles.get(value);
  if (!handle) throw new TypeError("Not a subscription handle created by this library.");
  return handle;
}

export function exposeHandle(handle: StreamHandle) {
  const exposed = Object.freeze({
    get sid() { return handle.sid; }, get generation() { return handle.generation; },
    channel: handle.channel,
    messages: handle.messages.bind(handle), unsubscribe: handle.unsubscribe.bind(handle), update: handle.update.bind(handle),
    getSnapshot: handle.getSnapshot.bind(handle), indexList: handle.indexList.bind(handle),
    subscribeIndices: handle.subscribeIndices.bind(handle), unsubscribeIndices: handle.unsubscribeIndices.bind(handle),
    underlyingList: handle.underlyingList.bind(handle), subscribeUnderlyings: handle.subscribeUnderlyings.bind(handle), unsubscribeUnderlyings: handle.unsubscribeUnderlyings.bind(handle),
    book(ticker: string) {
      const book = handle.book(ticker);
      if (!book || handle.session.contract.product === "predictions") return book;
      const { yes, no, ...metadata } = book;
      return Object.freeze({ ...metadata, bid: yes, ask: no });
    }
  });
  handles.set(exposed, handle);
  return exposed;
}
