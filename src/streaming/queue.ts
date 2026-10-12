import { KalshiWebSocketBackpressureError } from "./errors.js";

export class BoundedQueue<T> implements AsyncIterableIterator<T> {
  private values: { value: T; bytes: number }[] = [];
  private waiters: { resolve: (value: IteratorResult<T>) => void; reject: (reason: unknown) => void }[] = [];
  private ended = false;
  private error: unknown;
  private bytes = 0;
  constructor(private readonly countLimit: number, private readonly byteLimit: number,
    private readonly generation: () => number, private readonly returned: () => void = () => {},
    private readonly budget?: { used: number; max: number }) {}
  push(value: T, bytes: number): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) { waiter.resolve({ value, done: false }); return; }
    if (this.values.length >= this.countLimit || this.bytes + bytes > this.byteLimit || this.budget && this.budget.used + bytes > this.budget.max) throw new KalshiWebSocketBackpressureError(this.generation());
    this.values.push({ value, bytes }); this.bytes += bytes;
    if (this.budget) this.budget.used += bytes;
  }
  end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true; this.error = error; this.reset();
    for (const waiter of this.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({ value: undefined, done: true });
  }
  reset(): void { if (this.budget) this.budget.used -= this.bytes; this.values = []; this.bytes = 0; }
  next(): Promise<IteratorResult<T>> {
    const entry = this.values.shift();
    if (entry) { this.bytes -= entry.bytes; if (this.budget) this.budget.used -= entry.bytes; return Promise.resolve({ value: entry.value, done: false }); }
    if (this.ended) return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true });
    if (this.waiters.length >= this.countLimit) return Promise.reject(new KalshiWebSocketBackpressureError(this.generation()));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async return(): Promise<IteratorResult<T>> { this.end(); this.returned(); return { value: undefined, done: true }; }
  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }
}
