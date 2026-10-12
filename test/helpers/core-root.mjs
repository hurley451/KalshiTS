import path from "node:path";

export function requireCoreRoot(env = process.env) {
  if (!env.KALSHICORE_ROOT) throw new Error("Set KALSHICORE_ROOT to the pinned KalshiCore checkout before running Perps tests.");
  return path.resolve(env.KALSHICORE_ROOT);
}
