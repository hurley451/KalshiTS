import AjvModule, { type ValidateFunction } from "ajv-draft-04";
import addFormatsModule from "ajv-formats";
import { KalshiContractError } from "../errors.js";

export type Schema = Record<string, any>;
export interface StreamingContract {
  product: string;
  sha256: string;
  sourceSnapshot?: string;
  compatibilityRules?: readonly {pointer:string;raw:unknown}[];
  servers?: Record<string, { host: string; pathname: string; protocol: string }>;
  components: { schemas: Record<string, Schema>; messages: Record<string, { payload: Schema }> };
  channels: Record<string, readonly string[]>;
}

export class StreamingValidator {
  private readonly ajv;
  private readonly validators = new Map<string, ValidateFunction>();
  constructor(readonly contract: StreamingContract) {
    const Ajv = AjvModule as unknown as typeof AjvModule.default;
    const formats = addFormatsModule as unknown as typeof addFormatsModule.default;
    this.ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
    formats(this.ajv);
    this.ajv.addFormat("int64", { type: "number", validate: Number.isSafeInteger });
    const components = this.normalize(contract.components);
    if (components.schemas.subscriptionId) components.schemas.subscriptionId.allOf = [
      ...(components.schemas.subscriptionId.allOf ?? []), {type:"integer",minimum:1,maximum:Number.MAX_SAFE_INTEGER}
    ];
    this.ajv.addSchema({ id: "ws-contract", components });
  }
  private normalize(value: any): any {
    if (Array.isArray(value)) return value.map(v => this.normalize(v));
    if (!value || typeof value !== "object") return value;
    const result: Schema = Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      k === "$ref" && typeof v === "string" ? `ws-contract${v}` : this.normalize(v)]));
    if (Object.hasOwn(result, "const")) { result.enum = [result.const]; delete result.const; }
    return result;
  }
  schema(name: string): Schema {
    const payload = this.contract.components.messages[name]?.payload;
    if (!payload) throw new KalshiContractError(name, "websocket", "unknown component");
    return payload.$ref ? this.contract.components.schemas[payload.$ref.split("/").at(-1)]! : payload;
  }
  validate(name: string, value: unknown): void {
    let validator = this.validators.get(name);
    if (!validator) {
      validator = this.ajv.compile(this.normalize(this.contract.components.messages[name]!.payload));
      this.validators.set(name, validator);
    }
    if (!validator(value)) throw new KalshiContractError(name, "websocket", this.ajv.errorsText(validator.errors));
    if (value && typeof value === "object") {
      const body = value as Schema;
      for (const field of ["id", "sid", "seq", "sending_ts_ms"]) {
        if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || (field !== "sending_ts_ms" && body[field] < (field === "id" ? 0 : 1)))) {
          throw new KalshiContractError(name, field, "invalid integer metadata");
        }
      }
    }
  }
  validateSchema(name: string, value: unknown): void {
    const key = `schema:${name}`;
    let validator = this.validators.get(key);
    if (!validator) { validator = this.ajv.compile({ $ref: `ws-contract#/components/schemas/${name}` }); this.validators.set(key, validator); }
    if (!validator(value)) throw new KalshiContractError(name, "websocket-schema", this.ajv.errorsText(validator.errors));
  }
  validateControl(name: string, payload: Uint8Array, receivedPing?: Uint8Array): void {
    const pong = this.contract.components.messages.incomingPong?.payload;
    const ping = this.contract.components.messages.outgoingPing?.payload;
    // Core #12: this exact source pointer contradicts the RFC-required echo.
    if (name === "outgoingPing" && payload.length === 0 && ping?.const === "heartbeat"
      && this.contract.components.messages.incomingPing?.payload.const === "" && this.contract.components.messages.outgoingPong?.payload.const === ""
      && this.controlRule("#/components/messages/outgoingPing/payload/const","heartbeat")) return;
    if (name === "incomingPong" && receivedPing !== undefined && pong?.const === "" && ping?.const === "heartbeat"
      && this.controlRule("#/components/messages/incomingPong/payload/const","")) {
      if (!Buffer.from(payload).equals(Buffer.from(receivedPing))) throw new KalshiContractError(name, "control-frame", "Pong must echo the received Ping byte-for-byte");
      return;
    }
    this.validate(name, Buffer.from(payload).toString("utf8"));
  }
  private controlRule(pointer:string, raw:string): boolean {
    const qualified = this.contract.product === "predictions" && this.contract.sourceSnapshot === "sources/official/asyncapi.yaml"
      || this.contract.product === "perps" && this.contract.sourceSnapshot === "sources/perps/perps_asyncapi.yaml";
    return qualified && this.contract.compatibilityRules?.some(rule=>rule.pointer === pointer && rule.raw === raw) === true;
  }
  dispatch(channel: string, value: Schema): string {
    const candidates = this.contract.channels[channel]?.filter(name => this.schema(name).properties?.type?.const === value.type) ?? [];
    for (const name of candidates) {
      try { this.validate(name, value); return name; } catch { /* Other source-defined variant may match. */ }
    }
    throw new KalshiContractError(channel, "websocket", "invalid or undeclared message type");
  }
}
