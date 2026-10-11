import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const adapter = fileURLToPath(new URL("../scripts/conformance.js", import.meta.url));

test("adapter fails closed for empty and duplicate fixture lists", () => {
  for (const fixtureIds of [[], ["auth.signing.fixture", "auth.signing.fixture"]]) {
    const root = mkdtempSync(path.join(tmpdir(), "kalshits-conformance-"));
    try {
      mkdirSync(path.join(root, "targets/typescript"), { recursive: true });
      writeFileSync(path.join(root, "targets/typescript/KalshiTS.json"), JSON.stringify({
        id: "typescript.KalshiTS", conformance: { fixtureIds }
      }));
      const result = spawnSync(process.execPath, [adapter, "--kalshicore-root", root, "--report", path.join(root, "report.json")], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /nonempty unique fixture list/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("adapter reports missing fixtures as failures instead of losing the report", () => {
  const root = mkdtempSync(path.join(tmpdir(), "kalshits-conformance-"));
  try {
    mkdirSync(path.join(root, "targets/typescript"), { recursive: true });
    writeFileSync(path.join(root, "targets/typescript/KalshiTS.json"), JSON.stringify({
      id: "typescript.KalshiTS", conformance: { fixtureIds: ["rest.response.missing"] }
    }));
    const reportPath = path.join(root, "report.json");
    const result = spawnSync(process.execPath, [adapter, "--kalshicore-root", root, "--report", reportPath], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].passed, false);
    assert.match(report.suiteDigest, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("request conformance rejects mismatched method path body and bypassed transport", () => {
  for (const defect of ["method", "path", "body", "transport"]) {
    const root = mkdtempSync(path.join(tmpdir(), "kalshits-conformance-"));
    try {
      mkdirSync(path.join(root, "targets/typescript"), { recursive: true });
      mkdirSync(path.join(root, "fixtures/rest/request-serialization"), { recursive: true });
      writeFileSync(path.join(root, "targets/typescript/KalshiTS.json"), JSON.stringify({
        id: "typescript.KalshiTS", conformance: { fixtureIds: ["rest.request.portfolio-fills-query"] }
      }));
      writeFileSync(path.join(root, "fixtures/rest/request-serialization/portfolio-fills-query.json"), JSON.stringify({
        id: "rest.request.portfolio-fills-query", kind: "rest-request-serialization",
        input: { method: defect === "method" ? "POST" : "GET", path: defect === "path" ? "/wrong" : "/trade-api/v2/portfolio/fills",
          query: { tickers: ["A", "B"], limit: 2, cursor: "opaque" } },
        expected: { method: "GET", pathAndQuery: "/trade-api/v2/portfolio/fills?limit=2&cursor=opaque&ticker=A%2CB",
          body: defect === "body" ? "unexpected" : null }
      }));
      const reportPath = path.join(root, "report.json");
      const args = [adapter, "--kalshicore-root", root, "--report", reportPath];
      if (defect === "transport") {
        const clientUrl = new URL("../src/client.js", import.meta.url).href;
        const preload = path.join(root, "bypass.mjs");
        writeFileSync(preload, `import { KalshiClient } from ${JSON.stringify(clientUrl)}; KalshiClient.prototype.request = async () => ({ fills: [], cursor: "" });`);
        args.unshift("--import", preload);
      }
      const result = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.equal(result.status, 1, `${defect}: ${result.stdout} ${result.stderr}`);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(report.checks[0].passed, false);
      assert.match(report.checks[0].message, /mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
