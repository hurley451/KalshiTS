import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runPerpsConformance } from "./perps-conformance.js";
import { createHash, constants, generateKeyPairSync, verify } from "node:crypto";
import {
  buildPortfolioFillsPath,
  buildSigningPreimage,
  parseFillsPage,
  parseWebSocketMessage,
  KalshiClient,
  type OrderBookDeltaMessage
} from "../src/index.js";

interface CheckResult {
  id: string;
  passed: boolean;
  message: string;
}

interface Report {
  targetId: string;
  kalshiCoreRoot: string;
  generatedAtUtc: string;
  suiteDigest: string;
  checks: CheckResult[];
  perpsChecks: CheckResult[];
}

const kalshiCoreRoot = resolveOption("--kalshicore-root") ?? process.env.KALSHICORE_ROOT;
if (!kalshiCoreRoot) {
  throw new Error("Set KALSHICORE_ROOT or pass --kalshicore-root <path>.");
}

const resolvedKalshiCoreRoot = path.resolve(kalshiCoreRoot);
const targetManifest = await readJson(path.join(resolvedKalshiCoreRoot, "targets", "typescript", "KalshiTS.json"));
const fixtureIds = readFixtureIds(targetManifest);
if (fixtureIds.length === 0 || new Set(fixtureIds).size !== fixtureIds.length) {
  throw new Error("Conformance requires a nonempty unique fixture list.");
}
const checks: CheckResult[] = [];
const digest = createHash("sha256").update(JSON.stringify(targetManifest));

for (const fixtureId of fixtureIds) {
  try {
    const fixture = await readFixture(resolvedKalshiCoreRoot, fixtureId);
    digest.update(JSON.stringify(fixture));
    checks.push(await runFixture(fixtureId, fixture));
  } catch (error) {
    checks.push(fail(fixtureId, error instanceof Error ? error.message : String(error)));
  }
}

const perpsChecks = await runPerpsConformance(resolvedKalshiCoreRoot).catch(error=>[fail("perps_openapi:source-cases",error instanceof Error ? error.message : String(error))]);
try { digest.update(await readFile(path.join(resolvedKalshiCoreRoot,"fixtures/perps/perps_openapi-cases.json"))); } catch { /* Missing cases are reported above. */ }
const report: Report = {
  targetId: readString(targetManifest, "id", "typescript.KalshiTS"),
  kalshiCoreRoot: resolvedKalshiCoreRoot,
  generatedAtUtc: new Date().toISOString(),
  suiteDigest: digest.digest("hex"),
  checks,
  perpsChecks
};

const reportPath = path.resolve(resolveOption("--report") ?? "artifacts/kalshicore-conformance/report.json");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

for (const check of checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.id}: ${check.message}`);
}
for (const check of report.perpsChecks) console.log(`${check.passed ? "PASS" : "FAIL"} ${check.id}: ${check.message}`);
console.log(`Report: ${reportPath}`);

if ([...checks,...report.perpsChecks].some((check) => !check.passed)) {
  process.exitCode = 1;
}

async function runFixture(fixtureId: string, fixture: Record<string, unknown>): Promise<CheckResult> {
  try {
    switch (readString(fixture, "kind")) {
      case "auth-signing":
        return runAuthSigningFixture(fixtureId, fixture);
      case "rest-request-serialization":
        return await runRestRequestFixture(fixtureId, fixture);
      case "rest-response-shape":
        return runRestResponseFixture(fixtureId, fixture);
      case "websocket-replay":
        return runWebSocketReplayFixture(fixtureId, fixture);
      default:
        return fail(fixtureId, `Unsupported fixture kind ${String(fixture.kind)}.`);
    }
  } catch (error) {
    return fail(fixtureId, error instanceof Error ? error.message : String(error));
  }
}

function runAuthSigningFixture(fixtureId: string, fixture: Record<string, unknown>): CheckResult {
  const input = readRecord(fixture, "input");
  const expected = readRecord(fixture, "expected");
  const message = buildSigningPreimage(
    readString(input, "timestampMs"),
    readString(input, "method"),
    readString(input, "path")
  );
  expectEqual(readString(expected, "signatureMessage"), message, "signature message");
  expectEqual(readString(expected, "canonicalPath"), readString(input, "path").split("?", 1)[0], "canonical path");
  return pass(fixtureId, "Signing canonical message matched.");
}

async function runRestRequestFixture(fixtureId: string, fixture: Record<string, unknown>): Promise<CheckResult> {
  const input = readRecord(fixture, "input");
  const query = readRecord(input, "query");
  const expected = readRecord(fixture, "expected");
  const pathAndQuery = buildPortfolioFillsPath({
    tickers: readStringArray(query, "tickers"),
    limit: readOptionalNumber(query, "limit"),
    cursor: readOptionalString(query, "cursor")
  });
  expectEqual(readString(expected, "pathAndQuery"), pathAndQuery, "path and query");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const timestamp = "1790000000000";
  let requests = 0;
  let validateEmission: (() => void) | undefined;
  const client = new KalshiClient({ environment: "demo", auth: {
    apiKeyId: "conformance-key", privateKeyPem: privateKey, timestampProvider: () => timestamp
  }, fetch: async (url, init) => {
    requests++;
    const requestUrl = new URL(url);
    // Keep fixture diagnostics outside the sanitized HTTP error boundary.
    validateEmission = () => {
      expectEqual(readString(input, "method"), init?.method, "input HTTP method");
      expectEqual(readString(input, "path"), requestUrl.pathname, "input path");
      expectEqual(readString(expected, "method"), init?.method, "emitted HTTP method");
      expectEqual(readString(expected, "pathAndQuery"), `${requestUrl.pathname}${requestUrl.search}`, "emitted path and query");
      expectEqual(expected.body, init?.body === undefined ? null : JSON.parse(String(init.body)), "emitted body");
      const headers = new Headers(init?.headers);
      expectEqual("conformance-key", headers.get("KALSHI-ACCESS-KEY"), "emitted API key");
      expectEqual(timestamp, headers.get("KALSHI-ACCESS-TIMESTAMP"), "emitted timestamp");
      const signature = Buffer.from(headers.get("KALSHI-ACCESS-SIGNATURE") ?? "", "base64");
      expectEqual(true, verify("sha256", Buffer.from(`${timestamp}${readString(expected, "method")}${requestUrl.pathname}`), {
        key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
      }, signature), "emitted RSA-PSS signature");
    };
    return new Response(JSON.stringify({ fills: [], cursor: "" }), { headers: { "content-type": "application/json" } });
  }});
  await client.portfolio.getFills({ tickers: readStringArray(query, "tickers"),
    limit: readOptionalNumber(query, "limit"), cursor: readOptionalString(query, "cursor") });
  expectEqual(1, requests, "emitted request count");
  validateEmission!();
  return pass(fixtureId, "Portfolio fills emitted method, URL, headers and RSA-PSS signature matched.");
}

function runRestResponseFixture(fixtureId: string, fixture: Record<string, unknown>): CheckResult {
  const input = readRecord(fixture, "input");
  const expected = readRecord(fixture, "expected");
  const page = parseFillsPage(readRecord(input, "body"));
  const firstFill = page.fills[0];
  if (!firstFill) {
    throw new Error("Fills response did not contain a first fill.");
  }

  const expectedFirstFill = readRecord(expected, "firstFill");
  expectEqual(readNumber(expected, "fillsCount"), page.fills.length, "fills count");
  expectEqual(readString(expectedFirstFill, "fillId"), firstFill.fillId, "fill id");
  expectEqual(readNumber(expectedFirstFill, "exchangeIndex"), firstFill.exchangeIndex, "exchange index");
  expectEqual(readString(expectedFirstFill, "tradeId"), firstFill.tradeId, "trade id");
  expectEqual(readString(expectedFirstFill, "orderId"), firstFill.orderId, "order id");
  expectEqual(readString(expectedFirstFill, "ticker"), firstFill.ticker, "ticker");
  expectEqual(readString(expectedFirstFill, "marketTicker"), firstFill.marketTicker, "market ticker");
  expectEqual(readString(expectedFirstFill, "outcomeSide"), firstFill.outcomeSide, "outcome side");
  expectEqual(readString(expectedFirstFill, "bookSide"), firstFill.bookSide, "book side");
  expectEqual(readString(expectedFirstFill, "countFp"), firstFill.countFp, "count fp");
  expectEqual(readString(expectedFirstFill, "yesPriceDollars"), firstFill.yesPriceDollars, "yes price dollars");
  expectEqual(readString(expectedFirstFill, "noPriceDollars"), firstFill.noPriceDollars, "no price dollars");
  expectEqual(readString(expectedFirstFill, "feeCost"), firstFill.feeCost, "fee cost");
  expectEqual(readString(expectedFirstFill, "side"), firstFill.side, "side");
  expectEqual(readString(expectedFirstFill, "action"), firstFill.action, "action");
  expectEqual(readBoolean(expectedFirstFill, "isTaker"), firstFill.isTaker, "is taker");
  expectEqual(readNumber(expectedFirstFill, "subaccountNumber"), firstFill.subaccountNumber, "subaccount number");
  expectEqual(readNumber(expectedFirstFill, "ts"), firstFill.ts, "ts");
  expectEqual(readString(expected, "cursor"), page.cursor, "cursor");
  return pass(fixtureId, "Portfolio fills response shape parsed.");
}

function runWebSocketReplayFixture(fixtureId: string, fixture: Record<string, unknown>): CheckResult {
  const input = readRecord(fixture, "input");
  const expected = readRecord(fixture, "expected");
  const messages = readArray(input, "messages");
  const dispatchedTypes: string[] = [];
  let lastDelta: OrderBookDeltaMessage | undefined;

  for (const rawMessage of messages) {
    const message = parseWebSocketMessage(rawMessage);
    dispatchedTypes.push(message.type);
    if (message.type === "orderbook_delta") {
      lastDelta = message.msg as OrderBookDeltaMessage;
    }
  }

  expectEqual(readStringArray(expected, "dispatchedTypes").join(","), dispatchedTypes.join(","), "dispatched types");
  if (!lastDelta) {
    throw new Error("Replay did not dispatch an orderbook_delta message.");
  }

  const patch = readRecord(expected, "finalBookPatch");
  const yes = readRecord(patch, "yes");
  const [price, delta] = Object.entries(yes)[0] ?? [];
  expectEqual(readString(patch, "ticker"), lastDelta.market_ticker, "order book ticker");
  expectEqual(Number(price), lastDelta.price, "order book price");
  expectEqual(delta, lastDelta.delta, "order book delta");
  expectEqual("yes", lastDelta.side, "order book side");
  return pass(fixtureId, "WebSocket replay dispatched expected messages.");
}

async function readFixture(root: string, fixtureId: string): Promise<Record<string, unknown>> {
  const manifest = await readJson(path.join(root, "fixtures", "inventory.json")).catch(() => null);
  if (manifest) {
    const fixturePath = findFixturePath(manifest, fixtureId);
    if (fixturePath) {
      return readJson(path.join(root, fixturePath));
    }
  }

  const candidateRoots = [
    "fixtures/auth/signing",
    "fixtures/rest/request-serialization",
    "fixtures/rest/response-shape",
    "fixtures/websocket/replay"
  ];
  for (const candidateRoot of candidateRoots) {
    const candidate = path.join(root, candidateRoot, `${fixtureId.split(".").slice(-1)[0]}.json`);
    try {
      const fixture = await readJson(candidate);
      if (readString(fixture, "id") === fixtureId) {
        return fixture;
      }
    } catch {
      // Try the explicit fallback names below.
    }
  }

  const knownFixturePaths: Record<string, string> = {
    "auth.signing.rest-get-portfolio-fills": "fixtures/auth/signing/rest-get-portfolio-fills.json",
    "rest.request.portfolio-fills-query": "fixtures/rest/request-serialization/portfolio-fills-query.json",
    "rest.response.portfolio-fills-page": "fixtures/rest/response-shape/portfolio-fills-page.json",
    "websocket.replay.orderbook-delta": "fixtures/websocket/replay/orderbook-delta.json"
  };
  const fixturePath = knownFixturePaths[fixtureId];
  if (!fixturePath) {
    throw new Error(`Fixture ${fixtureId} was not found.`);
  }
  return readJson(path.join(root, fixturePath));
}

function findFixturePath(manifest: Record<string, unknown>, fixtureId: string): string | undefined {
  const fixtures = Array.isArray(manifest.fixtures) ? manifest.fixtures : [];
  for (const fixture of fixtures) {
    if (typeof fixture === "object" && fixture !== null && "id" in fixture && "path" in fixture) {
      const record = fixture as Record<string, unknown>;
      if (record.id === fixtureId && typeof record.path === "string") {
        return record.path;
      }
    }
  }
  return undefined;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

function readFixtureIds(manifest: Record<string, unknown>): string[] {
  const conformance = readRecord(manifest, "conformance");
  return readStringArray(conformance, "fixtureIds");
}

function resolveOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function pass(id: string, message: string): CheckResult {
  return { id, passed: true, message };
}

function fail(id: string, message: string): CheckResult {
  return { id, passed: false, message };
}

function expectEqual<T>(expected: T, actual: T, name: string): void {
  if (expected !== actual) {
    throw new Error(`${name} mismatch. Expected ${String(expected)}, got ${String(actual)}.`);
  }
}

function readRecord(body: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = body[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, name: string, fallback?: string): string {
  const value = body[name];
  if (typeof value === "string") {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`${name} must be a string.`);
}

function readOptionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" ? value : undefined;
}

function readNumber(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number") {
    throw new Error(`${name} must be a number.`);
  }
  return value;
}

function readOptionalNumber(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function readArray(body: Record<string, unknown>, name: string): unknown[] {
  const value = body[name];
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return value;
}

function readStringArray(body: Record<string, unknown>, name: string): string[] {
  return readArray(body, name).map((value) => {
    if (typeof value !== "string") {
      throw new Error(`${name} must contain only strings.`);
    }
    return value;
  });
}
