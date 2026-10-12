import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compareWebsocketOutputs, websocketGeneratedFiles } from "../scripts/check-websocket-generated.mjs";

test("WS gate compares all fourteen outputs without writes and rejects mismatch or missing output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kalshi-ws-gate-test-"));
  const expected = path.join(root,"expected"), actual = path.join(root,"actual");
  const files = ["predictions","perps"].flatMap(websocketGeneratedFiles);
  assert.equal(files.length,14);
  try {
    for (const directory of [expected,actual]) for (const file of files) {
      await mkdir(path.dirname(path.join(directory,file)),{recursive:true});
      await writeFile(path.join(directory,file),`fixture:${file}\n`);
    }
    await compareWebsocketOutputs(expected,actual);
    for (const file of files) {
      await writeFile(path.join(actual,file),"mismatch");
      await assert.rejects(compareWebsocketOutputs(expected,actual),/Generated output differs/);
      await rm(path.join(actual,file));
      await assert.rejects(compareWebsocketOutputs(expected,actual),{code:"ENOENT"});
      await writeFile(path.join(actual,file),`fixture:${file}\n`);
      assert.equal(await readFile(path.join(expected,file),"utf8"),`fixture:${file}\n`);
    }
    await compareWebsocketOutputs(expected,actual);
  } finally { await rm(root,{recursive:true,force:true}); }
});
