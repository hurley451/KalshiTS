import WebSocket from "ws";
import { signKalshiRequest, type KalshiAuthOptions } from "../auth.js";
import { requestContext, delay, withSignal, KalshiAbortError, KalshiTimeoutError } from "../transport.js";
import { StreamingValidator, type Schema, type StreamingContract } from "./contracts.js";
import { BoundedQueue } from "./queue.js";
import { BookStore } from "./orderbook.js";
import { KalshiAuthError, KalshiContractError } from "../errors.js";
import { KalshiWebSocketError, KalshiWebSocketBackpressureError, KalshiWebSocketCommandError, KalshiWebSocketPartialSubscriptionError } from "./errors.js";

export interface StreamingCommandOptions {
  /** Positive safe integer, unique within the current socket generation. */
  readonly id?: number;
  readonly signal?: AbortSignal;
  /** Includes time spent waiting behind earlier handle mutations. */
  readonly timeoutMs?: number;
}
export interface StreamingLimits {
  readonly maxPayloadBytes?: number; readonly queueMessages?: number; readonly queueBytes?: number;
  readonly pendingCommands?: number; readonly outboundBytes?: number; readonly subscriptions?: number;
  readonly decimalLength?: number; readonly bookLevels?: number; readonly sessionCommands?: number;
  readonly marketsPerSubscription?: number;
}
export interface StreamingClientOptions {
  readonly auth: KalshiAuthOptions;
  readonly environment?: "production" | "demo";
  readonly url?: string;
  readonly handshakeTimeoutMs?: number; readonly commandTimeoutMs?: number; readonly closeTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly reconnect?: { readonly maxAttempts?: number; readonly baseDelayMs?: number; readonly maxDelayMs?: number };
  readonly limits?: StreamingLimits;
}
export interface StreamingEvent { readonly kind: "message" | "ping" | "pong" | "state" | "gap" | "error"; readonly generation: number; readonly value: unknown }
interface Pending {
  generation: number; id: number; kind: string; sent: boolean; params: Schema;
  channels: Set<string>; sids: Set<number>; markets: Set<string>; values: Schema[];
  handles: StreamHandle[]; resolve: (value: any) => void; reject: (reason: unknown) => void;
  valueBytes: number;
  cleanup: () => void;
}
const positive = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new RangeError(`${name} must be a positive bounded integer.`);
  return value;
};
const marketFields = ["market_ticker", "market_tickers", "market_id", "market_ids"];

export class StreamHandle {
  sid = 0;
  generation = 0;
  desired = true;
  ending = false;
  private tail: Promise<unknown> = Promise.resolve();
  private queuedMutations = 0;
  recovering: number | undefined;
  recoveryAttempts = 0;
  initialFilters: Schema;
  readonly acknowledgedUpdates: Schema[] = [];
  private updateBytes = 0;
  replayUpdates: boolean;
  readonly queue: BoundedQueue<Schema>;
  readonly books: BookStore;
  constructor(readonly session: StreamingSession, readonly channel: string, public filters: Schema) {
    this.initialFilters = structuredClone(filters);
    const selector = channel.startsWith("cfbenchmarks") ? "index_ids" : channel === "pyth_value" ? "underlying_tickers" : "market_tickers";
    this.replayUpdates = channel !== "orderbook_delta" && (filters[selector]?.includes("all") || selector === "market_tickers" && !marketFields.some(key => filters[key] !== undefined));
    this.queue = new BoundedQueue(session.limits.queueMessages, session.limits.queueBytes, () => session.generation,
      () => { void this.unsubscribe().catch(error => session.observe("error", error)); }, session.queueBudget);
    this.books = new BookStore(session.contract.product, filters.use_yes_price === true, session.limits.decimalLength, session.limits.bookLevels, session.limits.marketsPerSubscription);
  }
  messages(): AsyncIterableIterator<Schema> { return this.queue; }
  book(ticker: string) { return this.books.get(ticker, this.generation, this.sid); }
  private serial<T>(options: StreamingCommandOptions, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.queuedMutations >= this.session.limits.pendingCommands) return Promise.reject(new KalshiWebSocketBackpressureError(this.generation));
    const context = requestContext(options.signal, options.timeoutMs ?? this.session.commandTimeout);
    this.queuedMutations++;
    const result = this.tail.then(() => {
      if (context.signal.aborted) throw context.signal.reason;
      return action(context.signal);
    });
    this.tail = result.catch(() => {});
    void result.then(()=>{this.queuedMutations--;},()=>{this.queuedMutations--;});
    return withSignal(result, context.signal).finally(() => context.dispose());
  }
  update(params: Schema, options: StreamingCommandOptions = {}): Promise<Schema> {
    if (this.ending) return Promise.reject(new KalshiWebSocketError("Subscription is closing.", this.generation));
    const input = structuredClone(params);
    return this.serial(options, async signal => {
      this.session.validateUpdate(this.channel, input);
      if (input.action === "get_snapshot") throw new KalshiContractError("update", "action", "use getSnapshot for its snapshot completion semantics");
      const filters = this.session.updatedFilters(this.filters, input);
      const discovery = ["indexlist","underlying_list"].includes(input.action);
      const becomesAll = input.index_ids?.includes("all") || input.underlying_tickers?.includes("all");
      const becomesEmpty = ["market_tickers","market_ids","index_ids","underlying_tickers"].some(key=>Array.isArray(filters[key])&&filters[key].length===0);
      const mixedSelectors = this.channel === "ticker" && (filters.market_ticker !== undefined || filters.market_tickers !== undefined)
        && (filters.market_id !== undefined || filters.market_ids !== undefined);
      const activateReplay = !this.replayUpdates && !discovery && (becomesAll || becomesEmpty || mixedSelectors);
      const record = !discovery && (this.replayUpdates || activateReplay);
      const bytes = record ? Buffer.byteLength(JSON.stringify(input)) : 0;
      if (record && (this.acknowledgedUpdates.length >= this.session.limits.sessionCommands || this.updateBytes + bytes > this.session.limits.queueBytes)) throw new KalshiWebSocketBackpressureError(this.generation);
      const response = await this.session.command("update", { ...input, sid: this.currentSid() }, { ...options, signal }, [this]);
      if (activateReplay) { this.initialFilters = structuredClone(this.filters); this.replayUpdates = true; }
      this.filters = filters;
      if (record) { this.acknowledgedUpdates.push(input); this.updateBytes += bytes; }
      if (this.channel === "orderbook_delta") this.books.retain(this.session.markets(filters));
      return response;
    });
  }
  getSnapshot(markets: readonly string[], options: StreamingCommandOptions = {}): Promise<readonly Schema[]> {
    if (this.channel !== "orderbook_delta" || this.ending) return Promise.reject(new KalshiWebSocketError("Snapshot requests require an active orderbook subscription.", this.generation));
    const requested = [...markets];
    if (!requested.length || new Set(requested).size !== requested.length) {
      return Promise.reject(new KalshiContractError("get_snapshot", "markets", "request unique markets from the acknowledged subscription"));
    }
    return this.serial(options, signal => {
      if (requested.some(t=>!this.session.markets(this.filters).includes(t))) throw new KalshiContractError("get_snapshot","markets","request markets from the acknowledged subscription");
      return this.session.command("snapshot", { sid: this.currentSid(), market_tickers: requested, action: "get_snapshot" }, { ...options, signal }, [this]);
    });
  }
  unsubscribe(options: StreamingCommandOptions = {}): Promise<void> {
    if (this.ending) return this.tail.then(() => undefined);
    this.ending = true; this.desired = false;
    return this.finishClose(this.serial(options, async signal => {
      if (this.generation === this.session.generation && this.session.isOpen) await this.session.command("unsubscribe", { sids: [this.sid] }, { ...options, signal }, [this]);
    }));
  }
  batchClose(options: StreamingCommandOptions, ready: () => Promise<Schema[]>): Promise<Schema[]> {
    if (this.ending) return Promise.reject(new KalshiWebSocketError("Subscription is already closing.", this.generation));
    this.ending = true; this.desired = false;
    return this.finishClose(this.serial(options, ready));
  }
  private finishClose<T>(closing: Promise<T>): Promise<T> {
    return closing.catch(error => { this.session.abandon(this, error); throw error; })
      .finally(() => { this.session.remove(this); this.queue.end(); this.books.clear(); });
  }
  indexList(options?: StreamingCommandOptions) { return this.update({ action: "indexlist" }, options); }
  subscribeIndices(index_ids: readonly string[], options?: StreamingCommandOptions) { return this.update({ action: "subscribe_indices", index_ids: [...index_ids] }, options); }
  unsubscribeIndices(index_ids: readonly string[], options?: StreamingCommandOptions) { return this.update({ action: "unsubscribe_indices", index_ids: [...index_ids] }, options); }
  underlyingList(options?: StreamingCommandOptions) { return this.update({ action: "underlying_list" }, options); }
  subscribeUnderlyings(underlying_tickers: readonly string[], options?: StreamingCommandOptions) { return this.update({ action: "subscribe_underlyings", underlying_tickers: [...underlying_tickers] }, options); }
  unsubscribeUnderlyings(underlying_tickers: readonly string[], options?: StreamingCommandOptions) { return this.update({ action: "unsubscribe_underlyings", underlying_tickers: [...underlying_tickers] }, options); }
  private currentSid(): number {
    if (!this.session.isOpen || this.session.state !== "open" || this.generation !== this.session.generation || !this.sid) throw new KalshiWebSocketError("Subscription has no binding in the current open session.", this.session.generation);
    return this.sid;
  }
}

export class StreamingSession {
  generation = 0;
  state: "idle" | "connecting" | "open" | "reconnecting" | "closing" | "closed" = "idle";
  readonly limits: Required<StreamingLimits>;
  readonly commandTimeout: number;
  readonly queueBudget: { used: number; max: number };
  private readonly validator: StreamingValidator;
  private socket: WebSocket | undefined;
  private opening: Promise<void> | undefined;
  private readonly lifetime = new AbortController();
  private readonly handles = new Set<StreamHandle>();
  private readonly bindings = new Map<number, StreamHandle>();
  private readonly sequences = new Map<number, number>();
  private readonly pending = new Map<number, Pending>();
  private readonly usedIds = new Set<number>();
  private readonly orphans = new Map<number, Schema[]>();
  private orphanBytes = 0;
  private nextId = 1;
  private outgoing: Promise<unknown> = Promise.resolve();
  private queuedBytes = 0;
  private readonly eventsQueue: BoundedQueue<StreamingEvent>;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private reconnecting: Promise<void> | undefined;
  private reconnectFailures = 0;
  private closePromise: Promise<void> | undefined;
  private readonly probes = new Set<{ generation: number; resolve: () => void; reject: (error: unknown) => void; cleanup: () => void }>();
  constructor(readonly contract: StreamingContract, readonly options: StreamingClientOptions) {
    if (!options.auth) throw new TypeError("WebSocket handshake requires RSA authentication.");
    this.validator = new StreamingValidator(contract);
    const defaults = { maxPayloadBytes: 1048576, queueMessages: 1024, queueBytes: 8388608, pendingCommands: 128,
      outboundBytes: 1048576, subscriptions: 128, decimalLength: 128, bookLevels: 100000, sessionCommands: 65536, marketsPerSubscription: 1024 };
    this.limits = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, positive(options.limits?.[key as keyof StreamingLimits] ?? value, key)])) as unknown as Required<StreamingLimits>;
    this.commandTimeout = positive(options.commandTimeoutMs ?? 10000, "commandTimeoutMs");
    for (const [name, value] of Object.entries({ handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10000, closeTimeoutMs: options.closeTimeoutMs ?? 3000, heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 30000 })) positive(value, name);
    const reconnect = options.reconnect;
    if (reconnect?.maxAttempts !== undefined && (!Number.isSafeInteger(reconnect.maxAttempts) || reconnect.maxAttempts < 0 || reconnect.maxAttempts > 100)) throw new RangeError("maxAttempts must be 0 to 100.");
    for (const value of [reconnect?.baseDelayMs ?? 250, reconnect?.maxDelayMs ?? 30000]) if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new RangeError("Invalid reconnect delay.");
    this.queueBudget = { used: 0, max: this.limits.queueBytes };
    this.eventsQueue = new BoundedQueue(this.limits.queueMessages, this.limits.queueBytes, () => this.generation, () => {}, this.queueBudget);
  }
  get isOpen(): boolean { return !this.lifetime.signal.aborted && this.socket?.readyState === WebSocket.OPEN; }
  events(): AsyncIterableIterator<StreamingEvent> { return this.eventsQueue; }
  ping(options: Omit<StreamingCommandOptions, "id"> = {}): Promise<void> {
    if (!this.isOpen || this.probes.size > 0) return Promise.reject(new KalshiWebSocketBackpressureError(this.generation));
    const generation = this.generation, context = requestContext(options.signal, options.timeoutMs ?? this.commandTimeout);
    return new Promise<void>((resolve, reject) => {
      const probe = { generation, resolve, reject, cleanup: () => {} };
      let sent = false;
      const fail = (reason: unknown) => {
        if (!this.probes.delete(probe)) return;
        probe.cleanup(); reject(reason);
        if (sent && this.generation === generation) this.fence(reason, true);
      };
      const cancel = () => fail(context.signal.reason);
      probe.cleanup = () => { context.signal.removeEventListener("abort", cancel); context.dispose(); };
      this.probes.add(probe);
      if (context.signal.aborted) { cancel(); return; }
      context.signal.addEventListener("abort", cancel, { once: true });
      this.validator.validateControl("incomingPing", new Uint8Array());
      sent = true;
      this.socket!.ping("", true, (error?: Error) => { if (error && this.generation === generation) fail(new KalshiWebSocketError("WebSocket Ping send failed.", generation)); });
    });
  }
  observe(kind: StreamingEvent["kind"], value: unknown): void {
    try { this.eventsQueue.push({ kind, generation: this.generation, value }, Buffer.byteLength(JSON.stringify(value) ?? "")); }
    catch { this.eventsQueue.end(new KalshiWebSocketBackpressureError(this.generation)); }
  }
  private transition(state: StreamingSession["state"]): void { this.state = state; this.observe("state", state); }
  connect(options: Omit<StreamingCommandOptions, "id"> = {}): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new KalshiWebSocketError("Client is closed.", this.generation));
    if (this.reconnecting) {
      const context = requestContext(options.signal, options.timeoutMs ?? this.options.handshakeTimeoutMs ?? 10000);
      return withSignal(this.reconnecting.then(() => { if (this.state !== "open") throw new KalshiWebSocketError("WebSocket restoration failed.", this.generation); }), context.signal).finally(() => context.dispose());
    }
    if (this.isOpen) return Promise.resolve();
    const context = requestContext(options.signal, options.timeoutMs ?? this.options.handshakeTimeoutMs ?? 10000);
    if (context.signal.aborted) { context.dispose(); return Promise.reject(context.signal.reason); }
    if (!this.opening) this.opening = Promise.resolve().then(() => {
      if (context.signal.aborted || this.lifetime.signal.aborted) throw context.signal.reason ?? this.lifetime.signal.reason;
      return this.open();
    }).catch(error => { const safe = this.safeError(error); this.fence(safe, false); throw safe; }).finally(() => { this.opening = undefined; });
    return new Promise<void>((resolve, reject) => {
      const cancel = () => { const reason = context.signal.reason; this.fence(reason, false); reject(reason); };
      if (context.signal.aborted) cancel();
      else context.signal.addEventListener("abort", cancel, { once: true });
      this.opening!.then(resolve, reject).finally(() => { context.signal.removeEventListener("abort", cancel); context.dispose(); });
    });
  }
  private open(restoring = false): Promise<void> {
    const generation = ++this.generation;
    this.bindings.clear(); this.sequences.clear(); this.orphans.clear(); this.orphanBytes = 0; this.usedIds.clear();
    this.transition("connecting");
    const defaultHost = this.contract.product === "predictions" ? this.options.environment === "demo" ? "external-api-ws.demo.kalshi.co" : "external-api-ws.kalshi.com"
      : this.options.environment === "demo" ? "external-api-margin-ws.demo.kalshi.co" : "external-api-margin-ws.kalshi.com";
    const server = this.contract.servers?.[this.options.environment ?? "production"];
    let url: URL;
    try { url = new URL(this.options.url ?? (server ? `${server.protocol}://${server.host}${server.pathname}` : `wss://${defaultHost}/trade-api/ws/v2${this.contract.product === "perps" ? "/margin" : ""}`)); }
    catch { throw new TypeError("Invalid WebSocket URL."); }
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new TypeError("Invalid WebSocket URL.");
    if (url.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new TypeError("Authenticated WebSockets require TLS outside loopback.");
    const signed = signKalshiRequest(this.options.auth, "GET", url.pathname);
    const transportOptions = { headers: signed.headers, followRedirects: false, autoPong: true,
      handshakeTimeout: this.options.handshakeTimeoutMs ?? 10000, closeTimeout: this.options.closeTimeoutMs ?? 3000,
      maxPayload: this.limits.maxPayloadBytes, perMessageDeflate: false };
    let socket: WebSocket;
    try { socket = new WebSocket(url, transportOptions); }
    catch (error) { throw this.safeError(error); }
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      socket.on("open", () => {
        if (this.generation !== generation || this.lifetime.signal.aborted) { socket.terminate(); reject(new KalshiAbortError()); return; }
        opened = true; this.transition(restoring ? "reconnecting" : "open"); this.armHeartbeat(generation); resolve();
      });
      socket.on("unexpected-response", (_request, response) => {
        response.resume(); socket.terminate(); reject(new KalshiWebSocketError(`WebSocket upgrade refused: HTTP ${response.statusCode}.`, generation));
      });
      socket.on("error", () => {
        const safe = new KalshiWebSocketError("WebSocket transport failed.", generation);
        if (!opened) reject(safe);
        if (this.generation === generation) this.observe("error", safe);
      });
      socket.on("ping", data => { if (this.generation === generation) {
        try {
          this.validator.validateControl("outgoingPing", data); this.validator.validateControl("incomingPong", data, data);
          this.reconnectFailures = 0; this.armHeartbeat(generation); this.observe("ping", Buffer.from(data));
        } catch (error) { this.fence(error, true); }
      } });
      socket.on("pong", data => { if (this.generation === generation) {
        try { this.validator.validateControl("outgoingPong", data); } catch (error) { this.fence(error, true); return; }
        this.reconnectFailures = 0; this.armHeartbeat(generation); this.observe("pong", Buffer.from(data));
        if (data.length === 0) for (const probe of this.probes) if (probe.generation === generation) { this.probes.delete(probe); probe.cleanup(); probe.resolve(); break; }
      } });
      socket.on("message", (data, binary) => {
        if (this.generation !== generation) return;
        try {
          if (binary) throw new KalshiContractError("websocket", "frame", "expected a JSON text frame");
          let value: Schema;
          try { value = JSON.parse(data.toString()); }
          catch { throw new KalshiWebSocketError("WebSocket frame contains invalid JSON.",generation); }
          this.receive(value, Buffer.byteLength(data.toString()));
        } catch (error) { this.fence(error, true); }
      });
      socket.on("close", () => {
        if (!opened) reject(new KalshiWebSocketError("WebSocket closed before upgrade completed.", generation));
        if (this.generation === generation && !this.lifetime.signal.aborted) this.fence(new KalshiWebSocketError("WebSocket disconnected.", generation), opened);
      });
    });
  }
  private armHeartbeat(generation: number): void {
    clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => { if (this.generation === generation) this.fence(new KalshiWebSocketError("WebSocket heartbeat deadline exceeded.", generation), true); }, this.options.heartbeatTimeoutMs ?? 30000);
  }
  private safeError(error: unknown): Error {
    if (error instanceof KalshiWebSocketError || error instanceof KalshiContractError || error instanceof KalshiAuthError
      || error instanceof KalshiAbortError || error instanceof KalshiTimeoutError) return error;
    // Preserve our fixed configuration diagnostics, never native parser/request properties.
    if (error instanceof TypeError && ["Invalid WebSocket URL.", "Authenticated WebSockets require TLS outside loopback."].includes(error.message)) return new TypeError(error.message);
    return new KalshiWebSocketError("WebSocket transport failed.", this.generation);
  }
  private fence(error: unknown, reconnect: boolean): void {
    error = this.safeError(error);
    const old = this.socket;
    ++this.generation; this.socket = undefined; clearTimeout(this.heartbeat);
    for (const handle of this.handles) { handle.books.invalidate(); handle.recovering = undefined; handle.queue.reset(); }
    for (const pending of [...this.pending.values()]) this.settle(pending, undefined, error);
    for (const probe of this.probes) { this.probes.delete(probe); probe.cleanup(); probe.reject(error); }
    this.bindings.clear(); this.sequences.clear(); this.orphans.clear(); this.orphanBytes = 0;
    this.outgoing = Promise.resolve(); this.queuedBytes = 0;
    old?.terminate(); this.observe("error", error);
    if (!reconnect || this.lifetime.signal.aborted) { if (!this.lifetime.signal.aborted) this.transition("idle"); return; }
    if (!this.reconnecting) this.reconnecting = this.restore().finally(() => { this.reconnecting = undefined; });
  }
  private async restore(): Promise<void> {
    const attempts = this.options.reconnect?.maxAttempts ?? 5;
    for (let attempt = 0; attempt < attempts && !this.lifetime.signal.aborted; attempt++) {
      if (++this.reconnectFailures > attempts) break;
      this.transition("reconnecting");
      try {
        await delay(Math.min(this.options.reconnect?.maxDelayMs ?? 30000, (this.options.reconnect?.baseDelayMs ?? 250) * 2 ** attempt), this.lifetime.signal);
        await this.open(true);
        const generation = this.generation;
        const current = () => {
          if (this.lifetime.signal.aborted || this.generation !== generation || !this.isOpen) throw new KalshiWebSocketError("Restoration session is no longer current.",generation);
        };
        for (const handle of [...this.handles].filter(h => h.desired && !h.ending)) {
          current();
          if (!handle.desired || handle.ending) continue;
          handle.books.clear(); handle.recoveryAttempts = 0;
          await this.command("subscribe", { ...structuredClone(handle.replayUpdates ? handle.initialFilters : handle.filters), channels: [handle.channel] }, {}, [handle]);
          current();
          for (const update of handle.acknowledgedUpdates) {
            if (!handle.desired || handle.ending) break;
            await this.command("update", {...structuredClone(update),sid:handle.sid}, {}, [handle]);
            current();
          }
          if (handle.channel === "orderbook_delta") handle.books.retain(this.markets(handle.filters));
        }
        current(); this.transition("open"); return;
      } catch (error) { if (this.lifetime.signal.aborted) return; this.fence(error, false); }
    }
    if (!this.lifetime.signal.aborted) {
      const error = new KalshiWebSocketError("WebSocket reconnect attempts exhausted.", this.generation);
      for (const handle of this.handles) { handle.desired = false; handle.queue.end(error); }
      await this.close();
    }
  }
  markets(filters: Schema): string[] { return filters.market_tickers ?? (filters.market_ticker ? [filters.market_ticker] : []); }
  private validateSubscribe(params: Schema): void {
    this.validator.validate("subscribeCommand", { id: 1, cmd: "subscribe", params });
    this.knownParams("subscribeCommand", params);
    if (this.selectionCount(params) > this.limits.marketsPerSubscription) throw new KalshiWebSocketBackpressureError(this.generation);
    if (new Set(params.channels).size !== params.channels.length) throw new KalshiContractError("subscribe", "channels", "duplicate channels");
    if (marketFields.filter(f => params[f] !== undefined).length > 1) throw new KalshiContractError("subscribe", "markets", "market selectors are mutually exclusive");
    for (const channel of params.channels) {
      if (!this.contract.channels[channel] || ["root", "control_frames"].includes(channel)) throw new KalshiContractError("subscribe", "channel", "not subscribable");
      if (channel === "orderbook_delta" && !this.markets(params).length) throw new KalshiContractError("subscribe", "markets", "orderbook requires market tickers");
      if (channel !== "ticker" && (params.market_id !== undefined || params.market_ids !== undefined)) throw new KalshiContractError("subscribe", "markets", "IDs are ticker-only");
      if ((channel.startsWith("cfbenchmarks") || channel === "pyth_value" || channel.includes("lifecycle")) && marketFields.some(f => params[f] !== undefined)) throw new KalshiContractError("subscribe", "markets", "channel does not support market filters");
      if (params.index_ids !== undefined && !channel.startsWith("cfbenchmarks")) throw new KalshiContractError("subscribe", "index_ids", "CF-only filter");
      if (params.underlying_tickers !== undefined && channel !== "pyth_value") throw new KalshiContractError("subscribe", "underlying_tickers", "Pyth-only filter");
      if ((params.send_initial_snapshot !== undefined || params.skip_ticker_ack !== undefined) && channel !== "ticker") throw new KalshiContractError("subscribe", "ticker", "ticker-only options");
      if (params.use_yes_price !== undefined && channel !== "orderbook_delta") throw new KalshiContractError("subscribe", "use_yes_price", "orderbook-only option");
      if (["shard_factor", "shard_key", "user_filter"].some(f => params[f] !== undefined) && channel !== "communications") throw new KalshiContractError("subscribe", "sharding", "communications-only filter");
    }
    if (params.shard_factor !== undefined && !Number.isSafeInteger(params.shard_factor) || params.shard_key !== undefined && (!Number.isSafeInteger(params.shard_key) || params.shard_factor === undefined || params.shard_key >= params.shard_factor)) throw new KalshiContractError("subscribe", "sharding", "invalid shard range");
  }
  validateUpdate(channel: string, params: Schema): void {
    if (params.sid !== undefined || params.sids !== undefined) throw new KalshiContractError("update", "sid", "the handle owns the generation-qualified SID");
    const action = params.action;
    const cf = channel.startsWith("cfbenchmarks"), pyth = channel === "pyth_value";
    const name = cf ? "cfbenchmarksUpdateSubscriptionCommand" : pyth ? "pythUpdateSubscriptionCommand" : "updateSubscriptionCommand";
    if (!cf && !pyth && !["orderbook_delta", "ticker", "fill", "user_orders"].includes(channel)) throw new KalshiContractError("update", "channel", "channel does not support updates");
    this.validator.validate(name, { id: 1, cmd: "update_subscription", params: { ...params, sid: 1 } });
    this.knownParams(name, params);
    if (action === "get_snapshot" && channel !== "orderbook_delta") throw new KalshiContractError("update", "action", "snapshot is orderbook-only");
    if ((action === "subscribe_indices" || action === "unsubscribe_indices") && !params.index_ids?.length) throw new KalshiContractError("update", "index_ids", "indices required");
    if ((action === "subscribe_underlyings" || action === "unsubscribe_underlyings") && !params.underlying_tickers?.length) throw new KalshiContractError("update", "underlying_tickers", "underlyings required");
    if (["add_markets", "delete_markets"].includes(action) && !marketFields.some(f => typeof params[f] === "string" ? params[f].length > 0 : Array.isArray(params[f]) && params[f].length > 0)) throw new KalshiContractError("update", "markets", "markets required");
    if (marketFields.filter(f => params[f] !== undefined).length > 1 || channel !== "ticker" && (params.market_id !== undefined || params.market_ids !== undefined)) throw new KalshiContractError("update", "markets", "invalid market selector");
    if (params.send_initial_snapshot !== undefined && channel !== "ticker") throw new KalshiContractError("update", "send_initial_snapshot", "ticker-only option");
  }
  private knownParams(name: string, params: Schema): void {
    const allowed = this.validator.schema(name).properties.params.properties;
    for (const key of Object.keys(params)) if (!Object.hasOwn(allowed, key)) throw new KalshiContractError(name, "params", `unknown parameter ${key}`);
    if (params.sid !== undefined && params.sids !== undefined) throw new KalshiContractError(name, "params", "sid and sids are mutually exclusive");
  }
  updatedFilters(filters: Schema, params: Schema): Schema {
    const next = structuredClone(filters);
    if (["indexlist", "underlying_list", "get_snapshot"].includes(params.action)) return next;
    const key = params.index_ids ? "index_ids" : params.underlying_tickers ? "underlying_tickers" : params.market_id || params.market_ids ? "market_ids" : "market_tickers";
    const values = params[key] ?? (params.market_ticker ? [params.market_ticker] : params.market_id ? [params.market_id] : []);
    const old = next[key] ?? (key === "market_tickers" && next.market_ticker ? [next.market_ticker] : key === "market_ids" && next.market_id ? [next.market_id] : []);
    const remove = ["delete_markets", "unsubscribe_indices", "unsubscribe_underlyings"].includes(params.action);
    next[key] = remove ? old.filter((v: string) => !values.includes(v)) : [...new Set([...old, ...values])];
    if (key === "market_tickers") delete next.market_ticker;
    if (key === "market_ids") delete next.market_id;
    const count = key === "market_tickers" || key === "market_ids" ? this.selectionCount(next) : next[key].length;
    if (count > this.limits.marketsPerSubscription) throw new KalshiWebSocketBackpressureError(this.generation);
    return next;
  }
  private selectionCount(params: Schema): number {
    return this.markets(params).length + (params.market_ids?.length ?? (params.market_id ? 1 : 0));
  }
  private subscriptionSlots(channels: readonly string[], handles: readonly StreamHandle[] = []): number {
    const remaining = [...this.pending.values()].filter(p=>p.kind === "subscribe").reduce((count,p)=>count + [...p.channels]
      .filter(channel=>!p.handles.some(h=>h.channel === channel && this.handles.has(h))).length,0);
    return this.handles.size + remaining + channels.filter(channel=>!handles.some(h=>h.channel === channel && this.handles.has(h))).length;
  }
  async subscribeMany(params: Schema, options: StreamingCommandOptions = {}): Promise<StreamHandle[]> {
    if (this.state !== "open") throw new KalshiWebSocketError("WebSocket restoration is not complete.",this.generation);
    const input = structuredClone(params); this.validateSubscribe(input);
    if (this.subscriptionSlots(input.channels) > this.limits.subscriptions) throw new KalshiWebSocketBackpressureError(this.generation);
    return this.command("subscribe", input, options);
  }
  listSubscriptions(options: StreamingCommandOptions = {}): Promise<Schema> {
    if (this.state !== "open") return Promise.reject(new KalshiWebSocketError("WebSocket restoration is not complete.",this.generation));
    return this.command("list", {}, options);
  }
  async unsubscribeMany(handles: readonly StreamHandle[], options: StreamingCommandOptions = {}): Promise<Schema[]> {
    if (!handles.length || new Set(handles).size !== handles.length || handles.some(h => h.session !== this || h.ending)) throw new KalshiContractError("unsubscribe", "handles", "require unique active handles from this client");
    let resolve!: (value: Schema[]) => void, reject!: (error: unknown) => void;
    const shared = new Promise<Schema[]>((done, failed) => { resolve = done; reject = failed; });
    let ready = 0;
    const jobs = handles.map(handle => handle.batchClose(options, async () => {
      if (++ready === handles.length) {
        if (handles.some(h => h.generation !== this.generation)) reject(new KalshiWebSocketError("Unsubscribe bindings changed generation.", this.generation));
        else void this.command("unsubscribe", { sids: handles.map(h => h.sid) }, options, [...handles]).then(resolve, reject);
      }
      return shared;
    }).catch(error => { reject(error); throw error; }));
    void shared.catch(() => {});
    return (await Promise.all(jobs))[0]!;
  }
  abandon(handle: StreamHandle, error: unknown): void {
    if (handle.generation === this.generation && this.isOpen) this.fence(error, true);
  }
  remove(handle: StreamHandle): void {
    this.handles.delete(handle);
    if (handle.generation === this.generation && this.bindings.get(handle.sid) === handle) {
      this.bindings.delete(handle.sid); this.sequences.delete(handle.sid);
    }
  }
  command(kind: string, params: Schema, options: StreamingCommandOptions = {}, handles: StreamHandle[] = []): Promise<any> {
    if (!this.isOpen) return Promise.reject(new KalshiWebSocketError("WebSocket is not open.", this.generation));
    if (this.pending.size >= this.limits.pendingCommands || this.usedIds.size >= this.limits.sessionCommands) return Promise.reject(new KalshiWebSocketBackpressureError(this.generation));
    const id = options.id ?? this.nextId++;
    if (!Number.isSafeInteger(id) || id < 1 || this.usedIds.has(id)) return Promise.reject(new KalshiContractError("command", "id", "require an unused positive safe integer in this session"));
    this.nextId = Math.max(this.nextId, id + 1); this.usedIds.add(id);
    const generation = this.generation;
    const context = requestContext(options.signal, options.timeoutMs ?? this.commandTimeout);
    const cmd = kind === "subscribe" ? "subscribe" : kind === "unsubscribe" ? "unsubscribe" : kind === "list" ? "list_subscriptions" : "update_subscription";
    const wire = { id, cmd, ...(kind === "list" ? {} : { params }) };
    const component = kind === "subscribe" ? "subscribeCommand" : kind === "unsubscribe" ? "unsubscribeCommand" : kind === "list" ? "listSubscriptionsCommand"
      : params.action?.includes("indices") || params.action === "indexlist" ? "cfbenchmarksUpdateSubscriptionCommand"
        : params.action?.includes("underlyings") || params.action === "underlying_list" ? "pythUpdateSubscriptionCommand" : "updateSubscriptionCommand";
    try { this.validator.validate(component, wire); } catch (error) { context.dispose(); return Promise.reject(error); }
    const payload = JSON.stringify(wire);
    const bytes = Buffer.byteLength(payload);
    if (this.queuedBytes + (this.socket?.bufferedAmount ?? 0) + bytes > this.limits.outboundBytes) { context.dispose(); return Promise.reject(new KalshiWebSocketBackpressureError(generation)); }
    this.queuedBytes += bytes;
    let reserved = true;
    const releaseBytes = () => { if (reserved) { reserved = false; if (this.generation === generation) this.queuedBytes -= bytes; } };
    return new Promise((resolve, reject) => {
      const pending: Pending = { generation, id, kind, sent: false, params,
        channels: new Set(params.channels ?? []), sids: new Set(params.sids ?? (params.sid ? [params.sid] : [])),
        markets: new Set(kind === "snapshot" ? params.market_tickers : []), values: [], valueBytes: 0, handles, resolve, reject, cleanup: () => {} };
      const cancel = () => {
        this.settle(pending, undefined, context.signal.reason);
        if (pending.sent && ["subscribe", "update", "unsubscribe", "snapshot"].includes(kind) && this.generation === generation) this.fence(context.signal.reason, true);
      };
      pending.cleanup = () => { releaseBytes(); context.signal.removeEventListener("abort", cancel); context.dispose(); };
      // Reserving remaining channels in pending is synchronous with this final capacity check.
      if (this.pending.size >= this.limits.pendingCommands || kind === "subscribe" && this.subscriptionSlots(params.channels,handles) > this.limits.subscriptions) {
        pending.cleanup(); reject(new KalshiWebSocketBackpressureError(generation)); return;
      }
      this.pending.set(id, pending);
      if (kind === "snapshot") for (const handle of handles) handle.recovering = id;
      if (context.signal.aborted) { cancel(); return; }
      context.signal.addEventListener("abort", cancel, { once: true });
      const turn = this.outgoing.then(async () => {
        releaseBytes();
        if (!this.pending.has(id) || this.generation !== generation) return;
        if (!this.isOpen || !this.socket || this.socket.bufferedAmount + bytes > this.limits.outboundBytes) { this.settle(pending, undefined, new KalshiWebSocketBackpressureError(generation)); return; }
        pending.sent = true;
        await new Promise<void>((sent, failed) => this.socket!.send(payload, error => error ? failed(error) : sent()));
      }).catch(error => { if (this.generation === generation) this.fence(error, true); });
      this.outgoing = turn;
    });
  }
  private settle(pending: Pending, value?: any, error?: unknown): void {
    if (this.pending.get(pending.id) !== pending) return;
    this.pending.delete(pending.id); pending.cleanup();
    if (pending.kind === "snapshot") for (const handle of pending.handles) if (handle.recovering === pending.id) handle.recovering = undefined;
    if (error && pending.kind === "subscribe") {
      const provisional = pending.handles.filter(h => h.generation === pending.generation && !h.desired);
      for (const handle of provisional) { this.remove(handle); handle.queue.end(error); }
      if (provisional.length) error = new KalshiWebSocketPartialSubscriptionError(pending.generation, provisional.map(h => h.channel), error);
    }
    error ? pending.reject(error) : pending.resolve(value);
  }
  private sequence(value: Schema): boolean {
    if (value.seq === undefined || value.sid === undefined) return true;
    const last = this.sequences.get(value.sid);
    if (last !== undefined && value.seq <= last) return false;
    if (last === undefined && this.sequences.size >= this.limits.subscriptions + this.limits.pendingCommands) throw new KalshiWebSocketBackpressureError(this.generation);
    this.sequences.set(value.sid, value.seq);
    if (last !== undefined && value.seq !== last + 1) {
      const handle = this.bindings.get(value.sid); handle?.books.invalidate(); this.observe("gap", { sid: value.sid, expected: last + 1, actual: value.seq });
      if (handle?.recovering !== undefined && handle.recovering !== -1) {
        this.fence(new KalshiWebSocketError("Sequence gap during snapshot recovery.", this.generation), true); return false;
      }
      if (handle?.channel === "orderbook_delta") this.recover(handle);
    }
    return true;
  }
  private receive(value: Schema, bytes: number): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new KalshiContractError("websocket", "message", "expected an object");
    const pending = value.id === undefined ? undefined : this.pending.get(value.id);
    if (pending && pending.generation !== this.generation) return;
    if (["subscribed", "unsubscribed", "ok", "error"].includes(value.type)) {
      let name = value.type === "subscribed" ? "subscribedResponse" : value.type === "unsubscribed" ? "unsubscribedResponse" : value.type === "error" ? "errorResponse"
        : pending?.kind === "list" ? "listSubscriptionsResponse" : pending?.params.action?.includes("indices") ? "subscribedIndicesResponse"
          : pending?.params.action?.includes("underlyings") ? "subscribedUnderlyingsResponse" : "okResponse";
      if (!this.contract.components.messages[name]) name = "okResponse";
      this.validator.validate(name, value); if (!this.sequence(value)) return; this.observe("message", value);
      if (!pending) return;
      if (value.type === "error") {
        if (pending.kind !== "subscribe" && pending.kind !== "list" && value.sid !== undefined
          && !pending.sids.has(value.sid) && !pending.handles.some(h=>h.generation === pending.generation && h.sid === value.sid)) return;
        const error = new KalshiWebSocketCommandError(this.generation, value);
        this.settle(pending, undefined, error);
        if (pending.kind === "subscribe") this.fence(error, true);
        return;
      }
      if (pending.kind === "subscribe" && value.type === "subscribed") {
        if (!Number.isSafeInteger(value.msg.sid) || value.msg.sid < 1) throw new KalshiContractError("subscribe","sid","unsafe subscription identity");
        if (!pending.channels.delete(value.msg.channel) || this.bindings.has(value.msg.sid)) throw new KalshiContractError("subscribe", "ack", "unexpected channel or duplicate SID");
        const filters = { ...structuredClone(pending.params) }; delete filters.channels;
        let handle = pending.handles.find(h => h.channel === value.msg.channel);
        if (!handle) { handle = new StreamHandle(this, value.msg.channel, filters); handle.desired = false; pending.handles.push(handle); }
        if (handle.ending) { this.fence(new KalshiWebSocketError("Subscription ended during restoration.",this.generation),true); return; }
        handle.sid = value.msg.sid; handle.generation = this.generation;
        this.handles.add(handle); this.bindings.set(handle.sid, handle);
        const orphan = this.orphans.get(handle.sid) ?? []; this.orphans.delete(handle.sid);
        const generation = this.generation;
        for (const message of orphan) {
          const size = Buffer.byteLength(JSON.stringify(message)); this.orphanBytes -= size; this.receive(message, size);
          if (this.generation !== generation) return;
        }
        if (!pending.channels.size) { for (const handle of pending.handles) handle.desired = true; this.settle(pending, pending.handles); }
      } else if (pending.kind === "unsubscribe" && value.type === "unsubscribed") {
        if (!pending.sids.delete(value.sid)) throw new KalshiContractError("unsubscribe", "sid", "unrelated SID");
        pending.values.push(value);
        if (!pending.sids.size) this.settle(pending, pending.values);
      } else if (pending.kind === "list" && value.type === "ok") this.settle(pending, value);
      else if (pending.kind === "update" && ["ok"].includes(value.type)) {
        if (["indexlist","underlying_list"].includes(pending.params.action)) return;
        if (value.sid !== undefined && !pending.sids.has(value.sid)) throw new KalshiContractError("update", "sid", "unrelated SID");
        this.settle(pending, value);
      }
      return;
    }
    const handle = this.bindings.get(value.sid);
    if (!handle) {
      if (![...this.pending.values()].some(p => p.kind === "subscribe") || !Number.isSafeInteger(value.sid)) throw new KalshiContractError("websocket", "sid", "unknown subscription");
      const orphan = this.orphans.get(value.sid) ?? [];
      if (orphan.length >= this.limits.queueMessages || this.orphanBytes + bytes > this.limits.queueBytes) throw new KalshiWebSocketBackpressureError(this.generation);
      orphan.push(value); this.orphans.set(value.sid, orphan); this.orphanBytes += bytes; return;
    }
    this.validator.dispatch(handle.channel, value);
    const generation = this.generation;
    const sequential = this.sequence(value);
    if (!sequential || generation !== this.generation) return;
    const discoveryType = pending?.params.action === "indexlist" && handle.channel.startsWith("cfbenchmarks") ? `${handle.channel}_indexlist`
      : pending?.params.action === "underlying_list" && handle.channel === "pyth_value" ? "pyth_value_underlying_list" : undefined;
    if (discoveryType !== undefined && value.type === discoveryType && pending?.kind === "update" && pending.sids.has(value.sid)) this.settle(pending, value);
    if (value.type === "orderbook_snapshot") {
      const accepted = handle.recovering === undefined || pending?.kind === "snapshot" && pending.id === handle.recovering && pending.sids.has(value.sid) && pending.markets.has(value.msg.market_ticker);
      if (accepted) {
        handle.books.snapshot(value);
        if (pending?.kind === "snapshot" && pending.sids.has(value.sid) && pending.markets.delete(value.msg.market_ticker)) {
          if (pending.valueBytes + bytes > this.limits.queueBytes) throw new KalshiWebSocketBackpressureError(this.generation);
          pending.valueBytes += bytes;
          pending.values.push(value); if (!pending.markets.size) { handle.recoveryAttempts = 0; this.settle(pending, pending.values); }
        }
      }
    } else if (value.type === "orderbook_delta") {
      if (!handle.book(value.msg.market_ticker)?.ready) this.recover(handle);
      else handle.books.delta(value);
    }
    try { handle.queue.push(structuredClone(value), bytes); }
    catch (error) { handle.books.invalidate(); throw error; }
    this.observe("message", value);
  }
  private recover(handle: StreamHandle): void {
    if (handle.recovering !== undefined || !handle.desired || handle.ending) return;
    handle.books.invalidate();
    if (++handle.recoveryAttempts > 3) { this.fence(new KalshiWebSocketError("Orderbook recovery limit exceeded.", this.generation), true); return; }
    const markets = this.markets(handle.filters);
    // Reserve synchronously so later frames cannot start a second recovery task.
    handle.recovering = -1;
    const generation = this.generation;
    void handle.getSnapshot(markets).catch(error => { if (generation === this.generation) this.fence(error, true); });
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifetime.abort(new KalshiAbortError()); this.transition("closing"); clearTimeout(this.heartbeat);
    const socket = this.socket; ++this.generation; this.socket = undefined;
    const error = new KalshiWebSocketError("WebSocket client closed.", this.generation);
    for (const pending of [...this.pending.values()]) this.settle(pending, undefined, error);
    for (const probe of this.probes) { this.probes.delete(probe); probe.cleanup(); probe.reject(error); }
    for (const handle of this.handles) { handle.desired = false; handle.ending = true; handle.books.clear(); handle.queue.end(); }
    this.handles.clear(); this.bindings.clear(); this.sequences.clear(); this.orphans.clear();
    this.closePromise = new Promise<void>(resolve => {
      if (!socket || socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, this.options.closeTimeoutMs ?? 3000);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close();
    }).finally(() => { this.transition("closed"); this.eventsQueue.end(); });
    return this.closePromise;
  }
}
