import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCf, cfGeneratedFiles } from "./generate-cf-rest.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
export async function checkCfGenerated(coreRoot, repository = root) {
  const stage = await mkdtemp(path.join(tmpdir(), "kalshits-cf-stage-"));
  try {
    await generateCf(coreRoot, stage);
    for (const directory of ["src/generated/cf-rest", "test/cf-rest"]) {
      const expected = cfGeneratedFiles.filter(f => f.startsWith(directory + "/")).map(f => path.basename(f)).sort();
      for (const base of [stage, repository]) {
        const actual = (await readdir(path.join(base, directory))).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Missing/extra CF output in ${directory}`);
      }
    }
    for (const file of cfGeneratedFiles) {
      if (!(await readFile(path.join(stage, file))).equals(await readFile(path.join(repository, file)))) throw new Error(`CF generated output differs: ${file}`);
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--kalshicore-root");
  await checkCfGenerated(i < 0 ? process.env.KALSHICORE_ROOT : process.argv[i + 1]);
}
