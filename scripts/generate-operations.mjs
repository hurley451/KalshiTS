#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const coreRoot = option("--kalshicore-root") ?? process.env.KALSHICORE_ROOT;
const source = option("--source") ?? process.env.KALSHI_OPENAPI ?? (coreRoot ? path.join(coreRoot,"sources/official/openapi.yaml") : undefined);
if (!source) throw new Error("Pass --source <official openapi.yaml> or --kalshicore-root <path>.");
if (option("--out")) throw new Error("Partial registry generation is unsafe: generate the full typed client together.");
const outputRoot = option("--out-dir");
if (outputRoot) mkdirSync(path.join(outputRoot, "test"), { recursive: true });
const script = fileURLToPath(new URL("./generate-client.mjs",import.meta.url));
const result = spawnSync(process.execPath,[script,"--source",path.resolve(source)],{
  stdio:"inherit", ...(outputRoot ? { cwd: path.resolve(outputRoot) } : {})
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
