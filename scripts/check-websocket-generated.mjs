#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
export const websocketGeneratedFiles = product => [
  `src/generated/${product}-ws.ts`, `src/generated/${product}-ws-contracts.ts`,
  `src/generated/${product}-ws-client.ts`, `src/generated/${product}-ws-coverage.json`,
  `src/generated/${product}-ws-source-gaps.json`, `test/${product}-ws-fixtures.json`, `test/${product}-ws-types.test.ts`
];
export async function compareWebsocketOutputs(expectedRoot, generatedRoot, products = ["predictions", "perps"]) {
  for (const product of products) for (const file of websocketGeneratedFiles(product)) {
    const [expected, actual] = await Promise.all([readFile(path.join(expectedRoot,file)), readFile(path.join(generatedRoot,file))]);
    if (!expected.equals(actual)) throw new Error(`Generated output differs: ${file}`);
  }
}
export async function checkWebsocketGenerated(coreRoot, products = ["predictions", "perps"], perpsCoreRoot = coreRoot) {
  const output = await mkdtemp(path.join(tmpdir(), "kalshi-ws-generated-"));
  try {
    for (const product of products) {
      const result = spawnSync(process.execPath, [path.join(repository,"scripts/generate-websocket.mjs"),
        "--kalshicore-root", path.resolve(coreRoot), "--perps-core-root", path.resolve(perpsCoreRoot), "--product", product, "--out-dir", output], { stdio:"inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${product} generation failed.`);
      await compareWebsocketOutputs(repository, output, [product]);
    }
    console.log(`All ${products.length * 7} generated WebSocket outputs are byte-identical.`);
  } finally { await rm(output, { recursive:true, force:true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--kalshicore-root");
  const root = (index < 0 ? undefined : process.argv[index + 1]) ?? process.env.KALSHICORE_ROOT;
  if (!root || root.startsWith("--")) throw new Error("Pass --kalshicore-root <path>.");
  const perpsIndex = process.argv.indexOf("--perps-core-root");
  await checkWebsocketGenerated(root, undefined, perpsIndex < 0 ? root : process.argv[perpsIndex + 1]);
}
