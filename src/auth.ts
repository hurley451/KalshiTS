import { constants, createPrivateKey, type KeyObject, sign } from "node:crypto";
import { KalshiAuthError } from "./errors.js";

export interface KalshiAuthOptions {
  readonly apiKeyId: string;
  readonly privateKeyPem: string | Buffer | KeyObject;
  readonly timestampProvider?: () => string | number;
}

export interface SignedKalshiRequest {
  readonly timestampMs: string;
  readonly signature: string;
  readonly headers: Record<string, string>;
}

export function buildSigningPreimage(timestampMs: string, method: string, pathAndQuery: string): string {
  const canonicalPath = pathAndQuery.split("?", 1)[0] ?? pathAndQuery;
  return `${timestampMs}${method.toUpperCase()}${canonicalPath}`;
}

export function signKalshiRequest(
  auth: KalshiAuthOptions,
  method: string,
  pathAndQuery: string
): SignedKalshiRequest {
  let failure = "Invalid Kalshi API key ID.";
  try {
    const apiKeyId = auth.apiKeyId;
    if (typeof apiKeyId !== "string" || !/^[\x21-\x7e]+$/.test(apiKeyId)) throw new Error();
    failure = "Invalid Kalshi signing timestamp.";
    const timestamp = auth.timestampProvider ? auth.timestampProvider() : Date.now();
    const timestampMs = String(timestamp);
    if (!/^\d+$/.test(timestampMs) || typeof timestamp === "number" && !Number.isSafeInteger(timestamp)) throw new Error();
    failure = "Invalid Kalshi private key.";
    const key = typeof auth.privateKeyPem === "string" || Buffer.isBuffer(auth.privateKeyPem)
      ? createPrivateKey(auth.privateKeyPem)
      : auth.privateKeyPem;
    failure = "Unsupported Kalshi private key type.";
    if (!key || key.type !== "private" || !["rsa", "ed25519"].includes(key.asymmetricKeyType ?? "")) throw new Error();
    failure = "Kalshi request signing failed.";
    const message = Buffer.from(buildSigningPreimage(timestampMs, method, pathAndQuery), "utf8");
    const signature = (key.asymmetricKeyType === "ed25519" ? sign(null, message, key) : sign("sha256", message, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST
    })).toString("base64");
    return {
      timestampMs,
      signature,
      headers: {
        "KALSHI-ACCESS-KEY": apiKeyId,
        "KALSHI-ACCESS-TIMESTAMP": timestampMs,
        "KALSHI-ACCESS-SIGNATURE": signature
      }
    };
  } catch {
    throw new KalshiAuthError(failure);
  }
}
