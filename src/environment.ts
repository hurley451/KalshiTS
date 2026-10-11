export interface KalshiEnvironment {
  readonly name: string;
  readonly restBaseUrl: string;
  readonly websocketUrl: string;
}

export type KalshiEnvironmentName = "production" | "demo";

export const kalshiEnvironments = {
  production: {
    name: "production",
    restBaseUrl: "https://external-api.kalshi.com/trade-api/v2",
    websocketUrl: "wss://external-api-ws.kalshi.com/trade-api/ws/v2"
  },
  demo: {
    name: "demo",
    restBaseUrl: "https://demo-api.kalshi.co/trade-api/v2",
    websocketUrl: "wss://demo-api.kalshi.co/trade-api/ws/v2"
  }
} as const satisfies Record<KalshiEnvironmentName, KalshiEnvironment>;

export function resolveEnvironment(environment: KalshiEnvironmentName | KalshiEnvironment = "production"): KalshiEnvironment {
  if (typeof environment === "string") {
    return kalshiEnvironments[environment];
  }
  return environment;
}
