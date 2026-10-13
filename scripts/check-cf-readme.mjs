import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { generateKeyPairSync, verify, createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
export function cfReadmeSnippets(markdown) {
  const snippets = [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((match, index) => ({ index, code: match[1] }))
    .filter(({ code }) => /\bclient\.cf\.(?:get|values|historyValues)(?:Raw)?\s*\(/.test(code));
  if (!snippets.length) throw new Error("Parent README has no executable CF TypeScript snippets yet.");
  if (snippets.some(({ code }) => /\b(?:const|let|var)\s+client\b/.test(code))) throw new Error("CF README snippets must use the existing client; the proof supplies synthetic keys and a loopback root.");
  return snippets;
}
function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env }); let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`README consumer exit ${code}: ${stderr}\n${stdout}`)));
  });
}

export async function proveCfReadme({ readme, packagePath, report }) {
  const markdown = await readFile(readme, "utf8"); const snippets = cfReadmeSnippets(markdown);
  if (!packagePath) throw new Error("Pass an already-built --package archive; this proof never runs prepack/build.");
  const root = await mkdtemp(path.join(tmpdir(), "cf-readme-installed-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"); const captures = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    captures.push({ url: req.url, method: req.method, headers: req.headers, bytes: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json", "x-readme-proof": "retained" });
    res.end('{"data":{"opaque":"1.230000"},"extra":true}');
  });
  const env = { ...process.env, npm_config_cache: path.join(root, "npm-cache") };
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.resolve(packagePath)], root, env);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const environment = { name: "cf-readme", restBaseUrl: `http://127.0.0.1:${server.address().port}/trade-api/v2`, websocketUrl: "ws://127.0.0.1" };
    const sources = [];
    for (const { index, code } of snippets) {
      const source = `example-${index}.mts`; sources.push(source);
      const setup = `import { KalshiClient as ReadmeKalshiClient } from "@hurley451/kalshi-ts";\nconst client = new ReadmeKalshiClient({ environment: ${JSON.stringify(environment)}, auth: { apiKeyId: "readme-synthetic", privateKeyPem: ${JSON.stringify(privateKey.export({ type: "pkcs8", format: "pem" }))}, timestampProvider: () => "1791806400000" } });\n`;
      await writeFile(path.join(root, source), setup + code);
    }
    execFileSync(process.execPath, [path.join(repository, "node_modules/typescript/lib/tsc.js"), "--strict", "--exactOptionalPropertyTypes", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots", path.join(repository, "node_modules/@types"), "--outDir", "compiled", ...sources], { cwd: root, stdio: "pipe" });
    for (const source of sources) {
      const before = captures.length;
      await run(process.execPath, [path.join("compiled", source.replace(/\.mts$/, ".mjs"))], root, env);
      assert.ok(captures.length > before, `${source} did not execute HTTP`);
    }
    for (const capture of captures) {
      const url = new URL(capture.url, environment.restBaseUrl);
      assert.equal(capture.method, "GET"); assert.equal(capture.bytes.length, 0);
      assert.ok(url.pathname.startsWith("/trade-api/v2/cfbenchmarks/"));
      assert.equal(url.searchParams.has("includeVerification"), false);
      assert.equal(capture.headers["kalshi-access-key"], "readme-synthetic");
      assert.ok(verify(null, Buffer.from(`1791806400000GET${url.pathname}`), publicKey, Buffer.from(capture.headers["kalshi-access-signature"], "base64")));
    }
    const result = { readme: path.resolve(readme), readmeSha256: createHash("sha256").update(markdown).digest("hex"),
      packagePath: path.resolve(packagePath), packageSha256: createHash("sha256").update(await readFile(packagePath)).digest("hex"),
      snippetIndexes: snippets.map(s => s.index), signedDispatches: captures.length, snippetsExecuted: snippets.length };
    if (report) await writeFile(report, JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const i = process.argv.indexOf(name); if (i < 0) return undefined; const value = process.argv[i + 1]; if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`); return value; };
  console.log(JSON.stringify(await proveCfReadme({ readme: option("--readme") ?? path.join(repository, "README.md"), packagePath: option("--package"), report: option("--report") }), null, 2));
}
