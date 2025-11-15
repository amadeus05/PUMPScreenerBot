// Production-Ready Data Aggregator Service v2.3
// Features:
// - Event-time OHLC with out-of-order support
// - Boundary interpolation (linear, production-grade)
// - Dynamic coverage thresholds (90% for 1m, 80% for 30m+)
// - minBuckets = 60% of minutes
// - SortedBucketMap with O(1) sorted keys
// - LRU + TTL eviction
// - Health monitoring + warmup/fallback metrics

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
  firstTs: number;
  lastTs: number;
};

type HealthStats = {
  totalSymbols: number;
  buckets15s: number;
  buckets1m: number;
  memoryEstimateMB: number;
  oldestData: number;
  newestData: number;
  warmupRejects: number;
  fallbacksUsed: number;
};

// Wrapper for Map with cached sorted keys
class SortedBucketMap {
  private map: Map<number, Bucket> = new Map();
  private sortedKeys: number[] | null = null;

  get size(): number {
    return this.map.size;
  }

  has(key: number): boolean {
    return this.map.has(key);
  }

  get(key: number): Bucket | undefined {
    return this.map.get(key);
  }

  set(key: number, value: Bucket): void {
    const isNew = !this.map.has(key);
    this.map.set(key, value);
    if (isNew) {
      this.sortedKeys = null;
    }
  }

  delete(key: number): boolean {
    const existed = this.map.delete(key);
    if (existed) {
      this.sortedKeys = null;
    }
    return existed;
  }

  getSortedKeys(): number[] {
    if (this.sortedKeys === null) {
      this.sortedKeys = [...this.map.keys()].sort((a, b) => a - b);
    }
    return this.sortedKeys;
  }

  keys(): IterableIterator<number> {
    return this.map.keys();
  }

  values(): IterableIterator<Bucket> {
    return this.map.values();
  }

  entries(): IterableIterator<[number, Bucket]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[number, Bucket]> {
    return this.map[Symbol.iterator]();
  }
}

@Injectable()
export class DataAggregatorService implements IDataAggregatorService {
  private readonly logger = new Logger("DataAggregatorProd");

  private buckets15s: Map<string, SortedBucketMap> = new Map();
  private buckets1m: Map<string, SortedBucketMap> = new Map();

  private lastKnownPrices: Map<string, number> = new Map();
  private lastUpdateTs: Map<string, number> = new Map();
  private firstSeen: Map<string, number> = new Map();
  private outOfOrderCount: Map<string, number> = new Map();

  private triggerEngine?: ITriggerEngineService | null = null;

  // Configuration
  private readonly MAX_MINUTE_BUCKETS = Number(process.env.MAX_MINUTE_BUCKETS) || 70;
  private readonly MAX_15S_BUCKETS = Number(process.env.MAX_15S_BUCKETS) || 300;
  private readonly MIN_BUCKET_SAMPLES = Number(process.env.MIN_BUCKET_SAMPLES) || 2;
  private readonly MAX_TRACKED_SYMBOLS = Number(process.env.MAX_TRACKED_SYMBOLS) || 2000;
  private readonly SYMBOL_CHECK_INTERVAL = Number(process.env.SYMBOL_CHECK_INTERVAL) || 5_000;
  private readonly FALLBACK_SHIFT_MULTIPLIER = Number(process.env.FALLBACK_SHIFT_MULTIPLIER) || 2;
  private readonly DEBUG = process.env.DEBUG === 'true';

  private lastSymbolCheck = 0;
  private readonly SYMBOL_TTL_MS = 24 * 60 * 60 * 1000;

  private totalUpdates = 0;
  private lastHealthCheck = 0;
  private readonly HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;

  private metricsCalculated = 0;
  private fallbacksUsed = 0;
  private warmupRejects = 0;

  // ==================== PUBLIC API ====================

  public updatePrice(symbol: string, price: number, timestamp: number): void {
    if (!symbol || !Number.isFinite(price) || price <= 0) {
      if (this.DEBUG) this.logger.warn(`Invalid price update: ${symbol} ${price}`);
      return;
    }

    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      if (this.DEBUG) this.logger.warn(`Invalid timestamp: ${symbol} ${timestamp}`);
      return;
    }

    const maxFuture = Date.now() + 60_000;
    const safeTs = Math.min(Math.floor(timestamp), maxFuture);

    this.lastKnownPrices.set(symbol, price);
    this.lastUpdateTs.set(symbol, safeTs);

    if (!this.firstSeen.has(symbol)) {
      this.firstSeen.set(symbol, safeTs);
      if (this.DEBUG) this.logger.debug(`New symbol tracked: ${symbol}`);
    }

    this.addRawPoint(symbol, { timestamp: safeTs, price });

    if (this.triggerEngine && typeof this.triggerEngine.onPriceUpdate === 'function') {
      try {
        void this.triggerEngine.onPriceUpdate(symbol, price);
      } catch (err) {
        this.logger.error(`Trigger engine notification failed: ${err}`);
      }
    }

    this.totalUpdates++;
    const now = Date.now();

    if (now - this.lastSymbolCheck > this.SYMBOL_CHECK_INTERVAL) {
      this.lastSymbolCheck = now;
      try {
        this.ensureSymbolLimit();
      } catch (err) {
        this.logger.error(`Symbol limit check failed: ${err}`);
      }
    }

    if (now - this.lastHealthCheck > this.HEALTH_CHECK_INTERVAL) {
      this.lastHealthCheck = now;
      this.logHealth();
    }
  }

  public getMetricChanges(symbol: string, timeIntervalMinutes: number): IMetricChanges | null {
    if (!symbol || timeIntervalMinutes <= 0) return null;

    if (timeIntervalMinutes <= 2) {
      return this.calculateBuckets(symbol, timeIntervalMinutes, 15_000, this.buckets15s);
    }
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

  // ==================== MONITORING API ====================

  public getBucketHealth(symbol: string, minutes: number): {
    availableBuckets: number;
    expectedBuckets: number;
    coveragePercent: number;
    missingBuckets: number;
  } {
    const bucketSize = minutes <= 2 ? 15_000 : 60_000;
    const store = bucketSize === 15_000 ? this.buckets15s : this.buckets1m;
    const map = store.get(symbol);

    if (!map) return { availableBuckets: 0, expectedBuckets: 0, coveragePercent: 0, missingBuckets: 0 };

    const now = Date.now();
    const durationMs = minutes * 60_000;
    const endBucket = Math.floor(now / bucketSize) * bucketSize;
    const startBucket = Math.floor((now - durationMs) / bucketSize) * bucketSize;

    const expected = Math.round((endBucket - startBucket) / bucketSize) + 1;
    const keys = map.getSortedKeys();
    const available = keys.filter(k => k >= startBucket && k <= endBucket).length;
    const coverage = expected === 0 ? 0 : Math.round((available / expected) * 100);
    const missing = expected - available;

    return { availableBuckets: available, expectedBuckets: expected, coveragePercent: coverage, missingBuckets: missing };
  }

  public visualizeBuckets(symbol: string): void {
    const m15 = this.buckets15s.get(symbol);
    const m1 = this.buckets1m.get(symbol);

    this.logger.info(`=== BUCKETS: ${symbol} ===`);

    if (!m15 && !m1) {
      this.logger.info(`No buckets for ${symbol}`);
      return;
    }

    if (m15) {
      this.logger.info(`15s buckets (${m15.size}):`);
      const keys = m15.getSortedKeys();
      keys.slice(-10).forEach(ts => {
        const b = m15.get(ts)!;
        this.logger.info(
          `  ${new Date(ts).toISOString()} | O:${b.open.toFixed(6)} H:${b.high.toFixed(6)} ` +
          `L:${b.low.toFixed(6)} C:${b.close.toFixed(6)} | cnt:${b.count}`
        );
      });
    }

    if (m1) {
      this.logger.info(`1m buckets (${m1.size}):`);
      const keys = m1.getSortedKeys();
      keys.slice(-10).forEach(ts => {
        const b = m1.get(ts)!;
        this.logger.info(
          `  ${new Date(ts).toISOString()} | O:${b.open.toFixed(6)} H:${b.high.toFixed(6)} ` +
          `L:${b.low.toFixed(6)} C:${b.close.toFixed(6)} | cnt:${b.count}`
        );
      });
    }
  }

  public getOutOfOrderStats(symbol?: string): Record<string, number> | number {
    if (symbol) return this.outOfOrderCount.get(symbol) ?? 0;
    return Object.fromEntries(this.outOfOrderCount);
  }

  public getHealthStats(): HealthStats {
    let buckets15Count = 0;
    let buckets1mCount = 0;
    let oldestTs = Date.now();
    let newestTs = 0;

    for (const map of this.buckets15s.values()) {
      buckets15Count += map.size;
      for (const [ts] of map) {
        oldestTs = Math.min(oldestTs, ts);
        newestTs = Math.max(newestTs, ts);
      }
    }

    for (const map of this.buckets1m.values()) {
      buckets1mCount += map.size;
      for (const [ts] of map) {
        oldestTs = Math.min(oldestTs, ts);
        newestTs = Math.max(newestTs, ts);
      }
    }

    const bytesPerBucket = 80;
    const memoryEstimateMB = ((buckets15Count + buckets1mCount) * bytesPerBucket) / (1024 * 1024);

    return {
      totalSymbols: this.getAllKnownSymbols().length,
      buckets15s: buckets15Count,
      buckets1m: buckets1mCount,
      memoryEstimateMB: Math.round(memoryEstimateMB * 100) / 100,
      oldestData: oldestTs === Date.now() ? 0 : oldestTs,
      newestData: newestTs,
      warmupRejects: this.warmupRejects,
      fallbacksUsed: this.fallbacksUsed,
    };
  }

  // ==================== INGESTION & BUCKETS ====================

  private addRawPoint(symbol: string, point: { timestamp: number; price: number }): void {
    const { timestamp: ts, price } = point;
    this.updateBucket(symbol, ts, price, 15_000, this.buckets15s);
    this.updateBucket(symbol, ts, price, 60_000, this.buckets1m);
  }

  private updateBucket(
    symbol: string,
    ts: number,
    price: number,
    bucketSize: number,
    store: Map<string, SortedBucketMap>,
  ): void {
    let map = store.get(symbol);
    if (!map) {
      map = new SortedBucketMap();
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
    }

    if (ts < b.firstTs) {
      if (b.count > 0) {
        const count = this.outOfOrderCount.get(symbol) ?? 0;
        this.outOfOrderCount.set(symbol, count + 1);
      }
      b.open = price;
      b.firstTs = ts;
    }

    if (ts > b.lastTs) {
      b.close = price;
      b.lastTs = ts;
    }

    b.high = Math.max(b.high, price);
    b.low = Math.min(b.low, price);
    b.count++;

    this.cleanupBuckets(store, symbol, bucketSize);
  }

  private cleanupBuckets(
    store: Map<string, SortedBucketMap>,
    symbol: string,
    bucketSize: number,
  ): void {
    const map = store.get(symbol);
    if (!map) return;

    const limit = bucketSize === 15_000 ? this.MAX_15S_BUCKETS : this.MAX_MINUTE_BUCKETS;
    const keys = map.getSortedKeys();

    if (keys.length <= limit) return;

    const removing = keys.length - limit;
    for (let i = 0; i < removing; i++) {
      map.delete(keys[i]);
    }

    if (this.DEBUG) {
      this.logger.debug(`Cleaned ${removing} old buckets for ${symbol} (${bucketSize/1000}s)`);
    }
  }

  // ==================== DYNAMIC COVERAGE THRESHOLD ====================

  private getCoverageThreshold(minutes: number): number {
    if (minutes <= 1) return 90;     // 1m  → 90%
    if (minutes <= 2) return 80;     // 2m  → 80%
    if (minutes <= 5) return 75;     // 3–5m → 75%
    if (minutes <= 15) return 78;    // 6–15m → 78%
    if (minutes <= 30) return 80;    // 16–30m → 80%
    return 82;                       // 30m+ → 82%
  }

  // ==================== CALCULATION WITH STRICT POLICIES ====================

  private calculateBuckets(
    symbol: string,
    minutes: number,
    bucketSize: number,
    store: Map<string, SortedBucketMap>,
  ): IMetricChanges | null {
    const map = store.get(symbol);
    if (!map || map.size === 0) {
      if (this.DEBUG) this.logger.debug(`❌ No data for ${symbol}`);
      return null;
    }

    const now = Date.now();
    const durationMs = minutes * 60_000;

    const firstSeenTs = this.firstSeen.get(symbol) ?? now;
    const hasWallClockHistory = (now - firstSeenTs) >= durationMs;

    const endBucket = Math.floor(now / bucketSize) * bucketSize;
    const startBucket = Math.floor((now - durationMs) / bucketSize) * bucketSize;

    const expectedBuckets = Math.round((endBucket - startBucket) / bucketSize) + 1;
    const keys = map.getSortedKeys();
    const availableBuckets = keys.filter(k => k >= startBucket && k <= endBucket).length;
    const coveragePercent = expectedBuckets > 0 ? (availableBuckets / expectedBuckets) * 100 : 0;

    const coverageThreshold = this.getCoverageThreshold(minutes);
    const minBucketsRequired = Math.ceil(minutes * 0.6);

    if (!hasWallClockHistory) {
      if (this.DEBUG) {
        this.logger.debug(`Warmup: not enough wall-clock history for ${symbol} ${minutes}m`);
      }
      this.warmupRejects++;
      return null;
    }
    
    if (availableBuckets < minBucketsRequired || coveragePercent < coverageThreshold) {
      if (this.DEBUG) {
        this.logger.debug(
          `Coverage reject: ${symbol} ${minutes}m ` +
          `avail=${availableBuckets}/${expectedBuckets} ` +
          `(${coveragePercent.toFixed(1)}%) ` +
          `min=${minBucketsRequired} thresh=${coverageThreshold}%`
        );
      }
      this.warmupRejects++;
      return null;
    }

    const startPrice = this.getPriceAtBoundary(map, startBucket);
    const endPrice = this.getPriceAtBoundary(map, endBucket);

    if (startPrice === null || endPrice === null) {
      if (this.DEBUG) this.logger.debug(`🔄 Missing boundaries (interpolation failed), trying fallback`);
      return this.fallbackInterpolation(map, startBucket, endBucket, bucketSize, durationMs, minutes);
    }

    const minSamples = this.effectiveMinSamples(minutes);
    const startBucketKey = this.findNearestBucketAtOrBefore(map, startBucket);
    const endBucketKey = this.findNearestBucketAtOrBefore(map, endBucket);

    const startBucketObj = startBucketKey !== null ? map.get(startBucketKey) : undefined;
    const endBucketObj = endBucketKey !== null ? map.get(endBucketKey) : undefined;

    if (startBucketObj && endBucketObj) {
      if (startBucketObj.count < minSamples || endBucketObj.count < minSamples) {
        if (this.DEBUG) {
          this.logger.debug(
            `📊 Insufficient samples: start=${startBucketObj.count} end=${endBucketObj.count} (need ${minSamples})`
          );
        }
        return this.fallbackInterpolation(map, startBucket, endBucket, bucketSize, durationMs, minutes);
      }
    }

    if (startPrice <= 0 || endPrice <= 0) {
      if (this.DEBUG) this.logger.debug(`❌ Invalid interpolated prices at boundaries`);
      return null;
    }

    const priceChangePercent = Number((((endPrice - startPrice) / startPrice) * 100).toFixed(6));

    const result: IMetricChanges = {
      priceChangePercent,
      currentPrice: endPrice,
      previousPrice: startPrice,
      timeWindowSeconds: minutes * 60,
    };

    if (this.DEBUG) {
      this.logger.info(
        `✅ ${symbol} ${minutes}m: ${priceChangePercent.toFixed(4)}% ` +
        `(${startPrice.toFixed(6)} → ${endPrice.toFixed(6)}) ` +
        `coverage=${coveragePercent.toFixed(1)}%`
      );
    }

    this.metricsCalculated++;
    return result;
  }

  // ==================== BOUNDARY INTERPOLATION HELPERS ====================

  private getPriceAtBoundary(map: SortedBucketMap, boundary: number): number | null {
    const keys = map.getSortedKeys();
    if (keys.length === 0) return null;

    let left = 0;
    let right = keys.length - 1;
    let idx = -1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (keys[mid] <= boundary) {
        idx = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    const leftKey = idx >= 0 ? keys[idx] : null;
    const rightKey = (idx + 1) < keys.length ? keys[idx + 1] : null;

    if (leftKey !== null && leftKey === rightKey) {
      const b = map.get(leftKey)!;
      if (b.firstTs <= boundary && boundary <= b.lastTs) {
        return this.interpolate(b.firstTs, b.open, b.lastTs, b.close, boundary);
      }
      if (boundary < b.firstTs) return b.open;
      return b.close;
    }

    const leftBucket = leftKey !== null ? map.get(leftKey) : undefined;
    const rightBucket = rightKey !== null ? map.get(rightKey) : undefined;

    if (leftBucket && leftBucket.firstTs <= boundary && boundary <= leftBucket.lastTs) {
      return this.interpolate(leftBucket.firstTs, leftBucket.open, leftBucket.lastTs, leftBucket.close, boundary);
    }

    if (rightBucket && rightBucket.firstTs <= boundary && boundary <= rightBucket.lastTs) {
      return this.interpolate(rightBucket.firstTs, rightBucket.open, rightBucket.lastTs, rightBucket.close, boundary);
    }

    if (leftBucket && rightBucket) {
      const prevTime = leftBucket.lastTs;
      const prevPrice = leftBucket.close;
      const nextTime = rightBucket.firstTs;
      const nextPrice = rightBucket.open;

      if (prevTime <= boundary && boundary <= nextTime && nextTime > prevTime) {
        return this.interpolate(prevTime, prevPrice, nextTime, nextPrice, boundary);
      }

      const leftDelta = Math.abs(boundary - prevTime);
      const rightDelta = Math.abs(nextTime - boundary);
      return leftDelta <= rightDelta ? prevPrice : nextPrice;
    }

    if (leftBucket) return leftBucket.close;
    if (rightBucket) return rightBucket.open;

    return null;
  }

  private interpolate(t0: number, p0: number, t1: number, p1: number, t: number): number {
    if (t1 === t0) return p0;
    const ratio = (t - t0) / (t1 - t0);
    return p0 + (p1 - p0) * ratio;
  }

  private findNearestBucketAtOrBefore(map: SortedBucketMap, boundary: number): number | null {
    const keys = map.getSortedKeys();
    if (keys.length === 0) return null;

    let left = 0;
    let right = keys.length - 1;
    let result: number | null = null;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const key = keys[mid];
      
      if (key <= boundary) {
        result = key;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    
    return result;
  }

  private effectiveMinSamples(minutes: number): number {
    if (minutes >= 5) return Math.max(3, this.MIN_BUCKET_SAMPLES);
    return this.MIN_BUCKET_SAMPLES;
  }

  private fallbackInterpolation(
    map: SortedBucketMap,
    startBucket: number,
    endBucket: number,
    bucketSize: number,
    durationMs: number,
    minutes: number,
  ): IMetricChanges | null {
    this.fallbacksUsed++;
    const keys = map.getSortedKeys();
    if (keys.length === 0) return null;

    const maxShift = Math.min(
      this.FALLBACK_SHIFT_MULTIPLIER * bucketSize,
      durationMs * 0.05
    );

    const beforeStart = keys.filter(k => k <= startBucket);
    const afterStart = keys.filter(k => k > startBucket);

    let startKey: number | null = null;
    if (beforeStart.length > 0) {
      startKey = beforeStart[beforeStart.length - 1];
      const shiftBack = startBucket - startKey;
      if (shiftBack > maxShift) {
        if (this.DEBUG) this.logger.debug(`❌ Backward start shift too large: ${shiftBack}ms > ${maxShift}ms`);
        startKey = null;
      }
    }

    if (startKey === null && afterStart.length > 0) {
      const candidate = afterStart[0];
      const shift = candidate - startBucket;
      if (shift <= maxShift) {
        startKey = candidate;
        if (this.DEBUG) this.logger.debug(`⚠️ Forward shift: ${shift}ms`);
      } else {
        if (this.DEBUG) this.logger.debug(`❌ Forward shift too large: ${shift}ms > ${maxShift}ms`);
        return null;
      }
    }

    const beforeEnd = keys.filter(k => k <= endBucket);
    let endKey: number | null = null;
    
    if (beforeEnd.length > 0) {
      endKey = beforeEnd[beforeEnd.length - 1];
      const shiftBack = endBucket - endKey;
      if (shiftBack > maxShift) {
        if (this.DEBUG) this.logger.debug(`❌ Backward end shift too large: ${shiftBack}ms > ${maxShift}ms`);
        endKey = null;
      }
    }

    if (endKey === null) {
      const candidate = keys[keys.length - 1];
      const shift = endBucket - candidate;
      if (shift <= maxShift) {
        endKey = candidate;
        if (this.DEBUG) this.logger.debug(`⚠️ Backward shift: ${shift}ms`);
      } else {
        if (this.DEBUG) this.logger.debug(`❌ Backward shift too large: ${shift}ms > ${maxShift}ms`);
        return null;
      }
    }

    if (startKey === null || endKey === null || startKey > endKey) {
      return null;
    }

    const s = map.get(startKey)!;
    const e = map.get(endKey)!;

    const startPrice = this.getPriceAtBoundary(map, startBucket) ?? s.open;
    const endPrice = this.getPriceAtBoundary(map, endBucket) ?? e.close;

    if (s.count < 1 || e.count < 1 || startPrice <= 0 || endPrice <= 0) {
      return null;
    }

    const priceChangePercent = Number((((endPrice - startPrice) / startPrice) * 100).toFixed(6));

    if (this.DEBUG) {
      this.logger.warn(
        `🔄 Fallback used: ${priceChangePercent.toFixed(4)}% ` +
        `(${new Date(startKey).toISOString()} → ${new Date(endKey).toISOString()})`
      );
    }

    return {
      priceChangePercent,
      currentPrice: endPrice,
      previousPrice: startPrice,
      timeWindowSeconds: minutes * 60,
    };
  }

  // ==================== LRU EVICTION ====================

  private ensureSymbolLimit(): void {
    const now = Date.now();
    let ttlEvicted = 0;
    for (const [symbol, lastUpdate] of this.lastUpdateTs.entries()) {
      if (now - lastUpdate > this.SYMBOL_TTL_MS) {
        this.evictSymbol(symbol);
        ttlEvicted++;
      }
    }

    if (ttlEvicted > 0 && this.DEBUG) {
      this.logger.info(`TTL evicted ${ttlEvicted} symbols`);
    }

    const total = this.lastUpdateTs.size;
    if (total <= this.MAX_TRACKED_SYMBOLS) return;

    const arr: Array<{ s: string; ts: number }> = [];
    for (const [s, ts] of this.lastUpdateTs.entries()) {
      arr.push({ s, ts });
    }

    arr.sort((a, b) => a.ts - b.ts);
    const removeCount = total - this.MAX_TRACKED_SYMBOLS;

    for (let i = 0; i < removeCount; i++) {
      this.evictSymbol(arr[i].s);
    }

    this.logger.warn(`LRU evicted ${removeCount} symbols (total: ${this.MAX_TRACKED_SYMBOLS})`);
  }

  private evictSymbol(symbol: string): void {
    this.buckets15s.delete(symbol);
    this.buckets1m.delete(symbol);
    this.lastKnownPrices.delete(symbol);
    this.lastUpdateTs.delete(symbol);
    this.firstSeen.delete(symbol);
    this.outOfOrderCount.delete(symbol);
  }

  // ==================== MONITORING ====================

  private logHealth(): void {
    const stats = this.getHealthStats();
    const outOfOrderTotal = Array.from(this.outOfOrderCount.values()).reduce((a, b) => a + b, 0);

    this.logger.info(
      `Health: symbols=${stats.totalSymbols} buckets(15s=${stats.buckets15s}, 1m=${stats.buckets1m}) ` +
      `memory≈${stats.memoryEstimateMB}MB updates=${this.totalUpdates} outOfOrder=${outOfOrderTotal} ` +
      `warmupRejects=${stats.warmupRejects} fallbacks=${stats.fallbacksUsed}`
    );

    if (this.DEBUG) {
      const oldestAge = stats.oldestData ? ((Date.now() - stats.oldestData) / 60000).toFixed(1) : 'N/A';
      this.logger.debug(`   Oldest data: ${oldestAge} minutes ago`);
    }
  }
}