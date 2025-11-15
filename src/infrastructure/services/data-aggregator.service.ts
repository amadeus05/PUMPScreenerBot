// Stable Data Aggregator — Production-ready, backward-compatible
// Implements spec v1.0: event-time buckets (15s, 1m), strict warmup & fallback,
// deterministic behavior, LRU eviction, monitoring endpoints.
// FIXED: Correct OHLC handling for out-of-order ticks

import { Injectable } from "../../shared/decorators";
import {
  IDataAggregatorService,
  IMetricChanges,
  ITriggerEngineService,
} from "../../domain/interfaces/services.interface";
import { Logger } from "../../shared/logger";

type Bucket = {
  open: number;
  close: number;
  high: number;
  low: number;
  count: number;
  firstTs: number; // event-time of first tick in bucket
  lastTs: number; // event-time of last tick in bucket
};

@Injectable()
export class DataAggregatorService implements IDataAggregatorService {
  private readonly logger = new Logger("StableAggregatorProd");

  // buckets keyed by symbol -> bucketTime -> Bucket (bucketTime is event-time aligned)
  private buckets15s: Map<string, Map<number, Bucket>> = new Map();
  private buckets1m: Map<string, Map<number, Bucket>> = new Map();

  // last known price and lastUpdate (event-time) used for LRU
  private lastKnownPrices: Map<string, number> = new Map();
  private lastUpdateTs: Map<string, number> = new Map();

  // firstSeen stores first event timestamp for the symbol (event-time)
  private firstSeen: Map<string, number> = new Map();

  private triggerEngine?: ITriggerEngineService | null = null;

  // Tunables (env overrides)
  private readonly MAX_MINUTE_BUCKETS = Number(process.env.MAX_MINUTE_BUCKETS) || 70;
  private readonly MAX_15S_BUCKETS = Number(process.env.MAX_15S_BUCKETS) || 300;
  private readonly MIN_BUCKET_SAMPLES = Number(process.env.MIN_BUCKET_SAMPLES) || 2;
  private readonly DEBUG = process.env.DEBUG === 'true' || Boolean(Number(process.env.DEBUG));
  private readonly FALLBACK_SHIFT_MULTIPLIER = Number(process.env.FALLBACK_SHIFT_MULTIPLIER) || 2;

  // Eviction controls
  private readonly SYMBOL_CHECK_INTERVAL = Number(process.env.SYMBOL_CHECK_INTERVAL) || 5_000;
  private readonly MAX_TRACKED_SYMBOLS = Number(process.env.MAX_TRACKED_SYMBOLS) || 2000;
  private lastSymbolCheck = 0;

  // Out-of-order tracking
  private outOfOrderWarnings: Map<string, number> = new Map(); // symbol -> count

  // ---------------- Public API (backward-compatible) ----------------

  public updatePrice(symbol: string, price: number, timestamp: number): void {
    if (!symbol || !Number.isFinite(price) || !Number.isFinite(timestamp)) return;

    // record last known price and lastUpdate (use event timestamp)
    this.lastKnownPrices.set(symbol, price);
    this.lastUpdateTs.set(symbol, timestamp);

    // set firstSeen using event timestamp if not present
    if (!this.firstSeen.has(symbol)) this.firstSeen.set(symbol, timestamp);

    // add point using event timestamp (CRITICAL for compatibility with original behavior)
    this.addRawPoint(symbol, { timestamp, price });

    // notify trigger engine (non-blocking, race-safe)
    if (this.triggerEngine && typeof this.triggerEngine.onPriceUpdate === 'function') {
      // don't await; protect from throwing
      try {
        void this.triggerEngine.onPriceUpdate(symbol, price);
      } catch (err) {
        this.logger.error(`Trigger engine onPriceUpdate error: ${String(err)}`);
      }
    }

    // throttled ensure symbol limit
    const now = Date.now();
    if (now - this.lastSymbolCheck > this.SYMBOL_CHECK_INTERVAL) {
      this.lastSymbolCheck = now;
      try {
        this.ensureSymbolLimit();
      } catch (err) {
        this.logger.error(`ensureSymbolLimit error: ${String(err)}`);
      }
    }
  }

  public getMetricChanges(symbol: string, timeIntervalMinutes: number): IMetricChanges | null {
    if (!symbol || timeIntervalMinutes <= 0) return null;

    if (timeIntervalMinutes <= 2) return this.calculateBuckets(symbol, timeIntervalMinutes, 15_000, this.buckets15s);
    return this.calculateBuckets(symbol, timeIntervalMinutes, 60_000, this.buckets1m);
  }

  public getAllKnownSymbols(): string[] {
    const set = new Set<string>();
    for (const s of this.buckets15s.keys()) set.add(s);
    for (const s of this.buckets1m.keys()) set.add(s);
    for (const s of this.lastKnownPrices.keys()) set.add(s);
    return Array.from(set);
  }

  public getHistoryLength(symbol: string): number {
    const m1 = this.buckets1m.get(symbol)?.size ?? 0;
    const m15 = this.buckets15s.get(symbol)?.size ?? 0;
    return Math.max(m1, m15);
  }

  public getCurrentPrice(symbol: string): number {
    return this.lastKnownPrices.get(symbol) ?? 0;
  }

  public setTriggerEngine(engine: ITriggerEngineService): void {
    this.triggerEngine = engine;
  }

  // Monitoring helper
  public getBucketHealth(symbol: string, minutes: number): { availableBuckets: number; expectedBuckets: number; coveragePercent: number } {
    const bucketSize = minutes <= 2 ? 15_000 : 60_000;
    const store = bucketSize === 15_000 ? this.buckets15s : this.buckets1m;
    const map = store.get(symbol);
    if (!map) return { availableBuckets: 0, expectedBuckets: 0, coveragePercent: 0 };

    const now = Date.now();
    const durationMs = Math.round(minutes * 60_000);
    const endBucket = Math.floor(now / bucketSize) * bucketSize;
    const startBucket = Math.floor((now - durationMs) / bucketSize) * bucketSize;

    // expected includes both boundaries inclusive
    const expected = Math.round((endBucket - startBucket) / bucketSize) + 1;
    const available = [...map.keys()].filter(k => k >= startBucket && k <= endBucket).length;
    const coverage = expected === 0 ? 0 : Math.round((available / expected) * 100);
    return { availableBuckets: available, expectedBuckets: expected, coveragePercent: coverage };
  }

  // Visualization for debugging (keeps compatibility)
  public visualizeBuckets(symbol: string): void {
    const m15 = this.buckets15s.get(symbol);
    const m1 = this.buckets1m.get(symbol);
    this.logger.debug(`--- BUCKETS ${symbol} ---`);
    if (!m15 && !m1) {
      this.logger.debug(`No buckets for ${symbol}`);
      return;
    }
    if (m15) {
      this.logger.debug(`15s:`);
      [...m15.keys()].sort((a,b)=>a-b).forEach(ts => {
        const b = m15.get(ts)!;
        this.logger.debug(`15s ${new Date(ts).toISOString()} O=${b.open} C=${b.close} H=${b.high} L=${b.low} cnt=${b.count}`);
      });
    }
    if (m1) {
      this.logger.debug(`1m:`);
      [...m1.keys()].sort((a,b)=>a-b).forEach(ts => {
        const b = m1.get(ts)!;
        this.logger.debug(`1m ${new Date(ts).toISOString()} O=${b.open} C=${b.close} H=${b.high} L=${b.low} cnt=${b.count}`);
      });
    }
  }

  // New: Get out-of-order statistics
  public getOutOfOrderStats(symbol?: string): Record<string, number> | number {
    if (symbol) return this.outOfOrderWarnings.get(symbol) ?? 0;
    return Object.fromEntries(this.outOfOrderWarnings);
  }

  // ---------------- Ingestion & Buckets ----------------

  private addRawPoint(symbol: string, point: { timestamp: number; price: number }): void {
    // protect from future timestamps: clamp to now + 60s to avoid creating far-future buckets
    const maxFuture = Date.now() + 60_000;
    const ts = Math.min(Math.floor(point.timestamp), maxFuture);
    const price = point.price;

    if (!this.firstSeen.has(symbol)) this.firstSeen.set(symbol, ts);

    this.updateBucket(symbol, ts, price, 15_000, this.buckets15s);
    this.updateBucket(symbol, ts, price, 60_000, this.buckets1m);
  }

  private updateBucket(
    symbol: string,
    ts: number,
    price: number,
    bucketSize: number,
    store: Map<string, Map<number, Bucket>>,
  ): void {
    let map = store.get(symbol);
    if (!map) {
      map = new Map();
      store.set(symbol, map);
    }

    const bucketTime = Math.floor(ts / bucketSize) * bucketSize;
    let b = map.get(bucketTime);

    if (!b) {
      b = {
        open: price,
        close: price,
        high: price,
        low: price,
        count: 0,
        firstTs: ts,
        lastTs: ts,
      };
      map.set(bucketTime, b);
      if (this.DEBUG) this.logger.debug(`New bucket ${symbol} size=${bucketSize/1000}s at ${new Date(bucketTime).toISOString()}`);
    }

    // CRITICAL FIX: Update open/close based on event-time, not arrival order
    // This ensures correct OHLC even with out-of-order ticks
    if (ts < b.firstTs) {
      b.open = price;
      b.firstTs = ts;
      
      // Track out-of-order for monitoring
      if (b.count > 0) {
        const count = this.outOfOrderWarnings.get(symbol) ?? 0;
        this.outOfOrderWarnings.set(symbol, count + 1);
        
        if (this.DEBUG) {
          this.logger.warn(
            `Out-of-order tick for ${symbol}: new ts=${new Date(ts).toISOString()}, ` +
            `was firstTs=${new Date(b.firstTs + (ts - b.firstTs)).toISOString()}, ` +
            `shift=${b.firstTs + (ts - b.firstTs) - ts}ms`
          );
        }
      }
    }
    
    if (ts > b.lastTs) {
      b.close = price;
      b.lastTs = ts;
    }

    // High/low are order-independent
    b.high = Math.max(b.high, price);
    b.low = Math.min(b.low, price);
    b.count++;

    this.cleanup(store, symbol, bucketSize);
  }

  private cleanup(store: Map<string, Map<number, Bucket>>, symbol: string, bucketSize: number): void {
    const map = store.get(symbol);
    if (!map) return;

    const limit = bucketSize === 15_000 ? this.MAX_15S_BUCKETS : this.MAX_MINUTE_BUCKETS;
    const keys = [...map.keys()].sort((a, b) => a - b);
    if (keys.length <= limit) return;

    const removing = keys.length - limit;
    for (let i = 0; i < removing; i++) map.delete(keys[i]);
    if (this.DEBUG) this.logger.debug(`Cleanup ${symbol} ${bucketSize/1000}s: removed ${removing} buckets`);
  }

  // ---------------- Calculation with strict warmup & fallback ----------------

  private calculateBuckets(
    symbol: string,
    minutes: number,
    bucketSize: number,
    store: Map<string, Map<number, Bucket>>,
  ): IMetricChanges | null {
    const map = store.get(symbol);
    if (!map) {
      if (this.DEBUG) this.logger.debug(`No bucket map for ${symbol}`);
      return null;
    }

    const now = Date.now();
    const durationMs = Math.round(minutes * 60_000);

    // Warmup check: require either wall-clock history OR coverage threshold
    const first = this.firstSeen.get(symbol) ?? 0;

    // wall-clock requirement (exact): require now - first >= durationMs for deterministic old behavior
    const hasWallClock = (now - first) >= durationMs;

    // coverage requirement: compute expected and available
    const endBucket = Math.floor(now / bucketSize) * bucketSize;
    const startBucket = Math.floor((now - durationMs) / bucketSize) * bucketSize;

    const expectedBuckets = Math.round((endBucket - startBucket) / bucketSize) + 1;
    const availableBuckets = [...map.keys()].filter(k => k >= startBucket && k <= endBucket).length;
    const coveragePercent = expectedBuckets === 0 ? 0 : (availableBuckets / expectedBuckets) * 100;

    const coverageThreshold = minutes >= 5 ? 75 : 60; // spec thresholds

    if (!hasWallClock && coveragePercent < coverageThreshold) {
      if (this.DEBUG) this.logger.debug(`Warmup: ${symbol} needs either wall-clock (${durationMs}ms) or coverage >= ${coverageThreshold}%. have=${coveragePercent.toFixed(2)}%`);
      return null;
    }

    // Find exact start & end buckets (prefer at-or-before boundary)
    const startBucketKey = this.findNearestBucketAtOrBefore(map, startBucket);
    const endBucketKey = this.findNearestBucketAtOrBefore(map, endBucket);

    const start = startBucketKey !== null ? map.get(startBucketKey)! : undefined;
    const end = endBucketKey !== null ? map.get(endBucketKey)! : undefined;

    if (!start || !end) {
      if (this.DEBUG) this.logger.debug(`Missing start or end for ${symbol}. Trying fallback`);
      const fallback = this.interpolateFromBuckets(map, startBucket, endBucket, bucketSize, durationMs);
      if (fallback) return fallback;
      return null;
    }

    if (start.count < this.effectiveMinSamples(minutes) || end.count < this.effectiveMinSamples(minutes)) {
      if (this.DEBUG) this.logger.debug(`Insufficient samples for ${symbol}: start=${start.count} end=${end.count}`);
      const fallback = this.interpolateFromBuckets(map, startBucket, endBucket, bucketSize, durationMs);
      if (fallback) return fallback;
      return null;
    }

    if (start.open <= 0 || end.close <= 0) {
      if (this.DEBUG) this.logger.debug(`Invalid bucket prices for ${symbol}`);
      return null;
    }

    // Use higher precision for financial calculations
    const priceChangePercent = Number(
      (((end.close - start.open) / start.open) * 100).toFixed(6)
    );
    const currentPrice = end.close;
    const previousPrice = start.open;
    const timeWindowSeconds = minutes * 60; // ALWAYS fixed to requested window for compatibility

    if (this.DEBUG) {
      this.logger.info(
        `Metric ${symbol} ${minutes}m: ${priceChangePercent.toFixed(4)}% ` +
        `(${previousPrice}→${currentPrice}) coverage=${coveragePercent.toFixed(1)}%`
      );
    }

    return {
      priceChangePercent,
      currentPrice,
      previousPrice,
      timeWindowSeconds,
    };
  }

  // effective minimum samples: stricter for larger windows
  private effectiveMinSamples(minutes: number): number {
    if (minutes >= 5) return Math.max(2, this.MIN_BUCKET_SAMPLES);
    return this.MIN_BUCKET_SAMPLES;
  }

  // find greatest key <= boundary, or null if none
  private findNearestBucketAtOrBefore(map: Map<number, Bucket>, boundary: number): number | null {
    const keys = [...map.keys()].sort((a, b) => a - b);
    let candidate: number | null = null;
    for (const k of keys) {
      if (k <= boundary) candidate = k;
      else break;
    }
    return candidate;
  }

  // ---------------- Fallback interpolation (configurable shift limits) ----------------
  // allowed shift <= min(FALLBACK_SHIFT_MULTIPLIER * bucketSize, durationMs * 0.05)

  private interpolateFromBuckets(
    map: Map<number, Bucket>,
    startBucket: number,
    endBucket: number,
    bucketSize: number,
    durationMs: number,
  ): IMetricChanges | null {
    const keys = [...map.keys()].sort((a, b) => a - b);
    if (keys.length === 0) return null;

    // candidate start: greatest key <= startBucket OR smallest key > startBucket (if forward-shift allowed)
    const beforeStart = keys.filter(k => k <= startBucket);
    const afterStart = keys.filter(k => k > startBucket);

    let startKey: number | null = null;
    if (beforeStart.length) startKey = beforeStart[beforeStart.length - 1];
    else if (afterStart.length) {
      const candidate = afterStart[0];
      const forwardShift = candidate - startBucket;
      const forwardLimit = Math.min(this.FALLBACK_SHIFT_MULTIPLIER * bucketSize, durationMs * 0.05);
      if (forwardShift <= forwardLimit) startKey = candidate; // allow small forward shift
      else {
        if (this.DEBUG) this.logger.debug(`Fallback reject: forward shift ${forwardShift} > ${forwardLimit}`);
        return null;
      }
    }

    // candidate end: greatest key <= endBucket OR last key if none (but limit backward shift)
    const beforeEnd = keys.filter(k => k <= endBucket);

    let endKey: number | null = null;
    if (beforeEnd.length) endKey = beforeEnd[beforeEnd.length - 1];
    else {
      const candidate = keys[keys.length - 1];
      const backwardShift = endBucket - candidate; // positive if candidate < endBucket
      const backwardLimit = Math.min(this.FALLBACK_SHIFT_MULTIPLIER * bucketSize, durationMs * 0.05);
      if (backwardShift <= backwardLimit) endKey = candidate;
      else {
        if (this.DEBUG) this.logger.debug(`Fallback reject: backward shift ${backwardShift} > ${backwardLimit}`);
        return null;
      }
    }

    if (startKey === null || endKey === null) return null;
    if (startKey > endKey) {
      if (this.DEBUG) this.logger.debug(`Fallback reject: startKey ${startKey} > endKey ${endKey}`);
      return null;
    }

    const s = map.get(startKey)!;
    const e = map.get(endKey)!;
    if (!s || !e) return null;
    if (s.count < 1 || e.count < 1) return null;
    if (s.open <= 0 || e.close <= 0) return null;

    // Use higher precision for financial calculations
    const pct = Number((((e.close - s.open) / s.open) * 100).toFixed(6));

    // IMPORTANT: return fixed requested time window (compatibility)
    const timeWindowSeconds = Math.round(durationMs / 1000);

    if (this.DEBUG) {
      this.logger.debug(
        `Interpolated ${pct.toFixed(4)}% using ` +
        `${new Date(startKey).toISOString()} -> ${new Date(endKey).toISOString()}`
      );
    }

    return {
      priceChangePercent: pct,
      currentPrice: e.close,
      previousPrice: s.open,
      timeWindowSeconds,
    };
  }

  // ---------------- LRU Eviction ----------------
  private ensureSymbolLimit(): void {
    // Remove symbols that haven't been updated for TTL (24h) to avoid memory leak from one-off symbols
    const TTL = 24 * 60 * 60 * 1000; // 24 hours in ms
    const now = Date.now();

    // Fast path: iterate over lastUpdateTs (O(n) but minimal allocations)
    for (const [sym, ts] of this.lastUpdateTs.entries()) {
      if (now - ts > TTL) {
        this.evictSymbol(sym);
        if (this.DEBUG) this.logger.info(`Evicted symbol ${sym} due to TTL`);
      }
    }

    // After TTL purge, check limit
    const total = this.lastUpdateTs.size;
    if (total <= this.MAX_TRACKED_SYMBOLS) return;

    // Build array from lastUpdateTs entries (no extra getAllKnownSymbols allocations)
    const arr: Array<{ s: string; ts: number }> = [];
    for (const [s, ts] of this.lastUpdateTs.entries()) {
      arr.push({ s, ts });
    }

    arr.sort((a, b) => a.ts - b.ts); // oldest first
    const removeCount = total - this.MAX_TRACKED_SYMBOLS;
    for (let i = 0; i < removeCount; i++) {
      const r = arr[i];
      this.evictSymbol(r.s);
      if (this.DEBUG) this.logger.info(`Evicted symbol ${r.s} due to LRU policy`);
    }
  }

  private evictSymbol(symbol: string): void {
    this.buckets15s.delete(symbol);
    this.buckets1m.delete(symbol);
    this.lastKnownPrices.delete(symbol);
    this.lastUpdateTs.delete(symbol);
    this.firstSeen.delete(symbol);
    this.outOfOrderWarnings.delete(symbol);
  }
}