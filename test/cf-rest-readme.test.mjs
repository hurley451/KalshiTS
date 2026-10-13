import test from "node:test";
import assert from "node:assert/strict";
import { cfReadmeSnippets } from "../scripts/check-cf-readme.mjs";

test("CF README proof fails closed without snippets or with a client overriding its safe transport", () => {
  assert.throws(() => cfReadmeSnippets("# README\n```ts\nawait client.getFills();\n```"), /no executable CF/);
  assert.throws(() => cfReadmeSnippets("```ts\nconst client = new KalshiClient();\nawait client.cf.values();\n```"), /existing client/);
});
test("CF README extraction retains exact typed helper/raw/passthrough examples and ignores unrelated snippets", () => {
  const snippets = cfReadmeSnippets("```ts\nawait client.getFills();\n```\n```ts\nconst data: unknown = (await client.cf.values({id: \"UNLISTED_INDEX\"})).data;\n```\n```ts\nawait client.cf.historyValuesRaw([[\"id\",\"X\"]] as const);\n```\n```ts\nawait client.cf.get(\"values\", [[\"id\",\"X\"]]);\n```");
  assert.deepEqual(snippets.map(s => s.index), [1, 2, 3]);
  assert.match(snippets[0].code, /data: unknown/);
  assert.equal(snippets[1].code, 'await client.cf.historyValuesRaw([["id","X"]] as const);\n');
});
