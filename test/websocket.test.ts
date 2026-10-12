import assert from "node:assert/strict";
import test from "node:test";
import { parseWebSocketMessage } from "../src/websocket.js";

test("preserves acknowledgement and error command correlation and timestamps", () => {
  for (const type of ["subscribed", "error", "ok"]) {
    const input = { type, id: 123, sending_ts_ms: 1669149841234, sid: 1, seq: 2,
      msg: { code: 7, message: "result" } };
    assert.deepEqual(parseWebSocketMessage(input), input);
  }
  assert.deepEqual(parseWebSocketMessage({ type: "heartbeat" }), { type: "heartbeat" });
});

test("rejects malformed envelope integer metadata and empty types", () => {
  for (const field of ["id", "sending_ts_ms", "sid", "seq"]) {
    for (const value of [null, "123", 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => parseWebSocketMessage({ type: "error", [field]: value }), /safe integer/);
    }
  }
  assert.throws(() => parseWebSocketMessage({ type: "" }), /non-empty/);
  for (const value of [null, [], "raw JSON"]) {
    assert.throws(() => parseWebSocketMessage(value), /object/);
  }
});
