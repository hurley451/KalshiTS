// Generated manual passthrough types; upstream data is deliberately unknown.
export type CfOperationId = "cfbenchmarks.values" | "cfbenchmarks.history-values" | "cfbenchmarks.passthrough";
export type CfQueryPairs = readonly (readonly [string, string])[];
export interface CfEnvelope { data: unknown; [key: string]: unknown }
export interface CfValuesQuery { id?: string; maxResolution?: string; [key: string]: string | undefined }
export interface CfHistoryValuesQuery extends CfValuesQuery { timespan?: string; timestamp?: string }
