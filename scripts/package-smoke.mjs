import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(tmpdir(), "kalshits-package-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

try {
  const specification = process.argv[2];
  if (specification?.startsWith("-")) throw new Error("Expected a package path or exact registry package version, not an option.");
  let packageInput;
  if (specification) {
    packageInput = specification;
  } else {
    const output = run(npm, ["pack", "--json", "--pack-destination", root], repository);
    const pack = JSON.parse(output.slice(output.indexOf("[")))[0];
    assert.ok(pack.files.some((entry) => entry.path === "LICENSE"));
    assert.ok(pack.files.every((entry) => !/^dist\/(test|scripts|examples)\//.test(entry.path)));
    packageInput = path.join(root, pack.filename);
  }
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", packageInput]);
  const consumer = `
import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { KalshiClient, KalshiApiError, KalshiAuthError, getOperation, parseFillsPage } from "@hurley451/kalshi-ts";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const client = new KalshiClient({ environment: "demo", auth: { apiKeyId: "consumer", privateKeyPem: privateKey, timestampProvider: () => "1790000000000" },
  fetch: async (url, init) => {
    assert.equal(String(url), "https://demo-api.kalshi.co/trade-api/v2/markets/orderbooks?tickers=A&tickers=B");
    assert.equal(init.method, "GET");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("kalshi-access-key"), "consumer");
    assert.equal(verify("sha256", Buffer.from("1790000000000GET/trade-api/v2/markets/orderbooks"), {
      key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
    }, Buffer.from(headers.get("kalshi-access-signature"), "base64")), true);
    return new Response(null, { status: 204 });
  }});
assert.equal(await client.request("GetMarketOrderbooks", { query: { tickers: ["A", "B"] } }), undefined);
for (const algorithm of ["rsa", "ed25519"]) {
  const keys = algorithm === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ed25519");
  const pem = keys.privateKey.export({ type: algorithm === "rsa" ? "pkcs1" : "pkcs8", format: "pem" });
  const signedClient = new KalshiClient({ auth: { apiKeyId: "consumer", privateKeyPem: pem, timestampProvider: () => "1790000000000" },
    fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, "/trade-api/v2/exchange/status");
      const headers = new Headers(init.headers);
      const key = algorithm === "rsa" ? { key: keys.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : keys.publicKey;
      assert.equal(verify(algorithm === "rsa" ? "sha256" : null, Buffer.from("1790000000000GET/trade-api/v2/exchange/status"), key,
        Buffer.from(headers.get("kalshi-access-signature"), "base64")), true);
      return new Response(JSON.stringify({ exchange_active: true, trading_active: true }), { headers: { "content-type": "application/json" } });
    }});
  assert.equal((await signedClient.exchange.getExchangeStatus()).exchange_active, true);
}
const invalidKeyClient = new KalshiClient({ auth: { apiKeyId: "consumer", privateKeyPem: "private-test-secret" },
  fetch: async () => { throw new Error("Invalid key must not dispatch."); } });
await assert.rejects(invalidKeyClient.getExchangeStatus(), e => e instanceof KalshiAuthError && !String(e.stack).includes("private-test-secret"));
assert.deepEqual(parseFillsPage({ fills: [], cursor: "" }), { fills: [], cursor: "" });
assert.throws(() => getOperation("toString"));
const failing = new KalshiClient({ fetch: async () => new Response("{broken", { status: 429, headers: { "content-type": "application/json", "retry-after": "5" } }) });
await assert.rejects(failing.request("GetMarkets", { authenticated: false }), e => e instanceof KalshiApiError && e.status === 429 && e.headers.get("retry-after") === "5");
console.log("Packed consumer runtime checks passed.");
`;
  writeFileSync(path.join(root, "consumer.mjs"), consumer);
  console.log(run(process.execPath, ["consumer.mjs"]).trim());
  writeFileSync(path.join(root, "consumer.mts"), `
import { KalshiClient, type Fill, type FillsPage } from "@hurley451/kalshi-ts";
const client = new KalshiClient({ environment: "demo" });
const page: FillsPage = await client.portfolio.getFills();
const fill: Fill | undefined = page.fills[0];
const cursor: string = page.cursor;
const amount: string | undefined = fill?.countFp;
const side: "yes" | "no" | undefined = fill?.side;
const subaccount: number | null | undefined = fill?.subaccountNumber;
void [cursor, amount, side, subaccount];
`);
  run(process.execPath, [path.join(repository, "node_modules/typescript/lib/tsc.js"), "--strict", "--noEmit",
    "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots",
    path.join(repository, "node_modules/@types"), "consumer.mts"]);
  const metadata = JSON.parse(readFileSync(path.join(root, "node_modules/@hurley451/kalshi-ts/package.json"), "utf8"));
  assert.equal(metadata.name, "@hurley451/kalshi-ts");
  console.log(`Consumer declarations and package metadata passed (${metadata.version}).`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
