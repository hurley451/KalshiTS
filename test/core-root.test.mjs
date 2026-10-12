import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { requireCoreRoot } from "./helpers/core-root.mjs";

test("Perps fixtures require an explicit, relocatable Core input", () => {
  assert.throws(() => requireCoreRoot({}), /Set KALSHICORE_ROOT/);
  assert.throws(() => requireCoreRoot({ KALSHICORE_ROOT: "" }), /Set KALSHICORE_ROOT/);
  for (const input of ["../Core input", "/tmp/relocated-source-checkout"]) {
    assert.equal(requireCoreRoot({ KALSHICORE_ROOT: input }), path.resolve(input));
  }
});

test("CI and release tests receive the checked-out Core location", () => {
  for (const [file, job] of [["kalshicore-conformance.yml", "conformance"], ["release.yml", "publish"]]) {
    const workflow = YAML.parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    const config = workflow.jobs[job];
    assert.equal(config.env.KALSHICORE_ROOT, "${{ github.workspace }}/KalshiCore");
    const checkout = config.steps.find(step => step.with?.repository === "hurley451/KalshiCore");
    assert.equal(checkout.with.path, "KalshiCore");
  }
});
