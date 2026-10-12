export interface KalshiPerpsEnvironment {
  readonly name: string;
  readonly restBaseUrl: string;
}
export type KalshiPerpsEnvironmentName = "production" | "demo";
export const kalshiPerpsEnvironments = {
  production: { name: "production", restBaseUrl: "https://external-api.kalshi.com/trade-api/v2" },
  demo: { name: "demo", restBaseUrl: "https://external-api.demo.kalshi.co/trade-api/v2" }
} as const satisfies Record<KalshiPerpsEnvironmentName, KalshiPerpsEnvironment>;
export function resolvePerpsEnvironment(environment: KalshiPerpsEnvironmentName | KalshiPerpsEnvironment = "production"): KalshiPerpsEnvironment {
  return typeof environment === "string" ? kalshiPerpsEnvironments[environment] : environment;
}
