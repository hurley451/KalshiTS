import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPortfolioFillsPath,
  buildSigningPreimage,
  parseFillsPage,
  parseWebSocketMessage,
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
  checks: CheckResult[];
}

const kalshiCoreRoot = resolveOption("--kalshicore-root") ?? process.env.KALSHICORE_ROOT;
if (!kalshiCoreRoot) {
  throw new Error("Set KALSHICORE_ROOT or pass --kalshicore-root <path>.");
}

const resolvedKalshiCoreRoot = path.resolve(kalshiCoreRoot);
const targetManifest = await readJson(path.join(resolvedKalshiCoreRoot, "targets", "typescript", "KalshiTS.json"));
const fixtureIds = readFixtureIds(targetManifest);
const checks: CheckResult[] = [];

for (const fixtureId of fixtureIds) {
  const fixture = await readFixture(resolvedKalshiCoreRoot, fixtureId);
  checks.push(runFixture(fixtureId, fixture));
}

const report: Report = {
  targetId: readString(targetManifest, "id", "typescript.KalshiTS"),
  kalshiCoreRoot: resolvedKalshiCoreRoot,
  generatedAtUtc: new Date().toISOString(),
  checks
};

const reportPath = path.resolve(resolveOption("--report") ?? "artifacts/kalshicore-conformance/report.json");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

for (const check of checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.id}: ${check.message}`);
}
console.log(`Report: ${reportPath}`);

if (checks.some((check) => !check.passed)) {
  process.exitCode = 1;
}

function runFixture(fixtureId: string, fixture: Record<string, unknown>): CheckResult {
  try {
    switch (readString(fixture, "kind")) {
      case "auth-signing":
        return runAuthSigningFixture(fixtureId, fixture);
      case "rest-request-serialization":
        return runRestRequestFixture(fixtureId, fixture);
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

function runRestRequestFixture(fixtureId: string, fixture: Record<string, unknown>): CheckResult {
  const input = readRecord(fixture, "input");
  const query = readRecord(input, "query");
  const expected = readRecord(fixture, "expected");
  const pathAndQuery = buildPortfolioFillsPath({
    tickers: readStringArray(query, "tickers"),
    limit: readOptionalNumber(query, "limit"),
    cursor: readOptionalString(query, "cursor")
  });
  expectEqual(readString(expected, "method"), readString(input, "method"), "HTTP method");
  expectEqual(readString(expected, "pathAndQuery"), pathAndQuery, "path and query");
  return pass(fixtureId, "Portfolio fills request serialization matched.");
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
