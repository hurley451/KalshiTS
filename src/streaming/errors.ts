import { inspect } from "node:util";

export class KalshiWebSocketError extends Error {
  constructor(message: string, readonly generation: number, readonly commandId?: number) { super(message); this.name = "KalshiWebSocketError"; }
  [inspect.custom](): string { return `${this.name}: ${this.message}`; }
  toJSON() { return {name:this.name,message:this.message,generation:this.generation,commandId:this.commandId}; }
}
export class KalshiWebSocketCommandError extends KalshiWebSocketError {
  constructor(generation: number, readonly response: Record<string, any>) {
    super(`WebSocket command failed with code ${response.msg.code}.`, generation, response.id);
    this.name = "KalshiWebSocketCommandError";
  }
}
export class KalshiWebSocketBackpressureError extends KalshiWebSocketError {
  constructor(generation: number) { super("WebSocket queue or buffer limit exceeded.", generation); this.name = "KalshiWebSocketBackpressureError"; }
}
export class KalshiWebSocketPartialSubscriptionError extends KalshiWebSocketError {
  readonly cleanup = "session-reset";
  constructor(generation: number, readonly acknowledgedChannels: readonly string[], readonly cause: unknown) {
    super("Multi-channel subscription failed; its session was fenced to remove every provisional subscription.", generation);
    this.name = "KalshiWebSocketPartialSubscriptionError";
  }
}
