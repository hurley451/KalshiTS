// Generated case bindings; execution uses actual SDK transport, not Core's oracle.
import test from "node:test";
import assert from "node:assert/strict";
import { runCfConformance } from "../../scripts/cf-conformance.js";
test("CF reviewed source cases through SDK", async () => {
 const checks = await runCfConformance();
 assert.equal(checks.length, 74);
 for (const check of checks) assert.equal(check.passed, true, check.id + ": " + check.message);
});
