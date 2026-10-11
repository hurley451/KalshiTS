import { constants, createPrivateKey, type KeyObject, sign } from "node:crypto";

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
  const timestamp = auth.timestampProvider ? auth.timestampProvider() : Date.now();
  const timestampMs = String(timestamp);
  const key = typeof auth.privateKeyPem === "string" || Buffer.isBuffer(auth.privateKeyPem)
    ? createPrivateKey(auth.privateKeyPem)
    : auth.privateKeyPem;
  const signature = sign("sha256", Buffer.from(buildSigningPreimage(timestampMs, method, pathAndQuery), "utf8"), {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST
  }).toString("base64");

  return {
    timestampMs,
    signature,
    headers: {
      "KALSHI-ACCESS-KEY": auth.apiKeyId,
      "KALSHI-ACCESS-TIMESTAMP": timestampMs,
      "KALSHI-ACCESS-SIGNATURE": signature
    }
  };
}
