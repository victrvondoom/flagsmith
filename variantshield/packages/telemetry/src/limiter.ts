/** In-memory token bucket keyed by caller. Suitable for a single API process. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedMs: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;

  constructor(opts: { capacity: number; refillPerSecond: number; maxKeys?: number }) {
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSecond / 1000;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /** Returns 0 when allowed, otherwise the milliseconds until a token is available. */
  take(key: string, nowMs: number, cost = 1): number {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
      b = { tokens: this.capacity, updatedMs: nowMs };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (nowMs - b.updatedMs) * this.refillPerMs);
    b.updatedMs = nowMs;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return 0;
    }
    return Math.ceil((cost - b.tokens) / this.refillPerMs);
  }
}
