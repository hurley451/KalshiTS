import { readFileSync } from "node:fs";
import { KalshiClient } from "../src/index.js";

const [scenario = "status", ticker] = process.argv.slice(2);
const isPrivate = scenario === "fills";
const apiKeyId = process.env.KALSHI_API_KEY_ID;
const keyFile = process.env.KALSHI_PRIVATE_KEY_FILE;
if (isPrivate && (!apiKeyId || !keyFile)) {
  throw new Error("Fills requires KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_FILE.");
}
const client = new KalshiClient({
  environment: "demo",
  ...(isPrivate ? { auth: { apiKeyId: apiKeyId!, privateKeyPem: readFileSync(keyFile!) } } : {})
});

switch (scenario) {
  case "status":
    console.log(await client.exchange.getExchangeStatus());
    break;
  case "markets":
    console.log(await client.markets.getMarkets({
      query: { limit: 5, status: "open" }
    }));
    break;
  case "orderbook":
    if (!ticker) throw new Error("Pass a demo market ticker after orderbook.");
    console.log(await client.markets.getMarketOrderbook({
      pathParameters: { ticker },
      query: { depth: 5 }
    }));
    break;
  case "fills":
    console.log(await client.portfolio.getFills({ limit: 5 }));
    break;
  default:
    throw new Error("Choose status, markets, orderbook, or fills.");
}
