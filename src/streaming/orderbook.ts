import Big from "big.js";
import { KalshiContractError } from "../errors.js";

const Decimal = Big();
Decimal.strict = true;
export interface StreamingBook {
  readonly marketTicker: string;
  readonly generation: number;
  readonly sid: number;
  readonly sequence: number;
  readonly ready: boolean;
  readonly priceConvention: "yes-leg" | "bid-ask";
  readonly yes: readonly (readonly [string, string])[];
  readonly no: readonly (readonly [string, string])[];
}
export class BookStore {
  private books = new Map<string, { yes: Map<string, Big>; no: Map<string, Big>; sequence: number; ready: boolean }>();
  constructor(private readonly product: string, private readonly yesPrice: boolean, private readonly maxDigits: number, private readonly maxLevels: number, private readonly maxMarkets = 1024) {}
  private decimal(value: unknown): Big {
    if (typeof value !== "string" || value.length > this.maxDigits || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new KalshiContractError("orderbook", "decimal", "expected a bounded plain decimal string");
    return new Decimal(value);
  }
  private price(value: unknown, no: boolean): string {
    const price = this.decimal(value);
    const canonical = (this.product === "predictions" && no && !this.yesPrice ? new Decimal("1").minus(price) : price).toFixed();
    if (canonical.length > this.maxDigits) throw new KalshiContractError("orderbook", "decimal", "canonical price exceeds decimal limit");
    return canonical;
  }
  invalidate(): void { for (const book of this.books.values()) book.ready = false; }
  retain(markets: readonly string[]): void { const allowed = new Set(markets); for (const ticker of this.books.keys()) if (!allowed.has(ticker)) this.books.delete(ticker); }
  snapshot(message: Record<string, any>): void {
    const msg = message.msg;
    if (!this.books.has(msg.market_ticker) && this.books.size >= this.maxMarkets) throw new KalshiContractError("orderbook", "snapshot", "book market limit exceeded");
    const yes = new Map<string, Big>(), no = new Map<string, Big>();
    const fields = this.product === "predictions" ? ["yes_dollars_fp", "no_dollars_fp"] : ["bid", "ask"];
    for (const [index, field] of fields.entries()) {
      for (const level of msg[field] ?? []) {
        const price = this.price(level[0], index === 1), quantity = this.decimal(level[1]);
        const side = index === 0 ? yes : no;
        if (quantity.lt("0") || side.has(price)) throw new KalshiContractError("orderbook", "snapshot", "negative quantity or duplicate canonical price");
        if (!quantity.eq("0")) side.set(price, quantity);
      }
    }
    if (yes.size + no.size > this.maxLevels) throw new KalshiContractError("orderbook", "snapshot", "book level limit exceeded");
    this.books.set(msg.market_ticker, { yes, no, sequence: message.seq, ready: true });
  }
  delta(message: Record<string, any>): void {
    const msg = message.msg, book = this.books.get(msg.market_ticker);
    if (!book?.ready) return;
    const isNo = this.product === "predictions" ? msg.side === "no" : msg.side === "ask";
    const side = isNo ? book.no : book.yes;
    const key = this.price(this.product === "predictions" ? msg.price_dollars : msg.price, isNo);
    const quantity = (side.get(key) ?? new Decimal("0")).plus(this.decimal(this.product === "predictions" ? msg.delta_fp : msg.delta));
    if (quantity.lt("0")) throw new KalshiContractError("orderbook", "delta", "resulting quantity is negative");
    if (quantity.toFixed().length > this.maxDigits) throw new KalshiContractError("orderbook", "decimal", "resulting quantity exceeds decimal limit");
    if (!side.has(key) && !quantity.eq("0") && book.yes.size + book.no.size >= this.maxLevels) throw new KalshiContractError("orderbook", "delta", "book level limit exceeded");
    if (quantity.eq("0")) side.delete(key); else side.set(key, quantity);
    book.sequence = message.seq;
  }
  get(ticker: string, generation: number, sid: number): StreamingBook | undefined {
    const book = this.books.get(ticker);
    if (!book) return undefined;
    const levels = (side: Map<string, Big>, descending: boolean) => Object.freeze([...side.entries()]
      .sort(([a], [b]) => new Decimal(a).cmp(b) * (descending ? -1 : 1))
      .map(([price, quantity]) => Object.freeze([price, quantity.toFixed()] as const)));
    return Object.freeze({ marketTicker: ticker, generation, sid, sequence: book.sequence, ready: book.ready,
      priceConvention: this.product === "predictions" ? "yes-leg" : "bid-ask", yes: levels(book.yes, true), no: levels(book.no, false) });
  }
  clear(): void { this.books.clear(); }
}
