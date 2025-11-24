// Production-Ready Data Aggregator Service v2.3 (fixed UP/DOWN detection)
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
  spikeCount: number;
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

type NormalizedTick = {
  price: number;
  isSpike: boolean;
  median: number;
  mad: number;
};

class TickNormalizer {
  private readonly buffers = new Map<string, number[]>();

  constructor(
    private readonly windowSize: number,
    private readonly minWindow: number,
    private readonly spikeMultiplier: number,
  ) {}

  // Добавляем метод для получения MAD
  getCurrentMad(symbol: string): number {
    const buffer = this.buffers.get(symbol);
    if (!buffer || buffer.length < this.minWindow) return 0;
    
    const median = this.computeMedian(buffer);
    const deviations = buffer.map(v => Math.abs(v - median));
    return this.computeMedian(deviations) || 0;
  }

  // Добавляем метод для очистки буфера символа
  removeSymbol(symbol: string): void {
    this.buffers.delete(symbol);
  }

  normalize(symbol: string, price: number): NormalizedTick {
    const buffer = this.buffers.get(symbol) ?? [];
    buffer.push(price);
    if (buffer.length > this.windowSize) buffer.shift();
    this.buffers.set(symbol, buffer);

    if (buffer.length < this.minWindow) {
      return { price, isSpike: false, median: price, mad: 0 };
    }

    const median = this.computeMedian(buffer);
    const deviations = buffer.map(v => Math.abs(v - median));
    const mad = this.computeMedian(deviations) || 0;

    const epsilon = Math.max(median * 0.0001, 1e-6);
    const threshold = Math.max(mad * this.spikeMultiplier, epsilon);
    const deviation = Math.abs(price - median);

    if (deviation > threshold) {
      const clamped = median + Math.sign(price - median) * threshold;
      return { price: clamped, isSpike: true, median, mad };
    }

    return { price, isSpike: false, median, mad };
  }

  private computeMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }
}

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

type WindowSnapshot = {
  candles: Bucket[];
  windowStart: number;
  windowEnd: number;
  expectedBuckets: number;
  availableBuckets: number;
  missingBuckets: number;
  coveragePercent: number;
  coveredMs: number;
  expectedMs: number;
  spikeShare: number;
  maxGapMs: number;
};

type Movement = {
  percent: number;
  startPrice: number;
  endPrice: number;
  duration: number;
  startTs: number;
  endTs: number;
};

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

  // Tick normalization & anti-spike layers
  private readonly NORMALIZER_WINDOW = Number(process.env.AGG_NORMALIZER_WINDOW) || 25;
  private readonly NORMALIZER_MIN_WINDOW = Number(process.env.AGG_NORMALIZER_MIN_WINDOW) || 5;
  private readonly SPIKE_SIGMA_MULTIPLIER = Number(process.env.AGG_SPIKE_SIGMA_MULTIPLIER) || 4;
  private readonly MEDIAN_FILTER_WINDOW = Number(process.env.AGG_MEDIAN_WINDOW) || 5;
  private readonly SPIKE_SHARE_LIMIT = Number(process.env.AGG_SPIKE_SHARE_LIMIT) || 0.35;
  private readonly ACTIVE_BUCKET_GRACE_MS = Number(process.env.AGG_ACTIVE_BUCKET_GRACE_MS) || 5_000;
  private readonly MAX_GAP_FACTOR = Number(process.env.AGG_MAX_GAP_FACTOR) || 4;

  private readonly tickNormalizer = new TickNormalizer(
    this.NORMALIZER_WINDOW,
    this.NORMALIZER_MIN_WINDOW,
    this.SPIKE_SIGMA_MULTIPLIER,
  );

  // Параметры фильтра Калмана для сглаживания цены (anti-spike без лага MA)
  // Чем меньше Q (process noise), тем более "инерционная" модель, тем сильнее сглаживание.
  // Чем больше R (measurement noise), тем меньше доверие к отдельным измерениям (тикам).
  private readonly KALMAN_PROCESS_NOISE =
    Number(process.env.KALMAN_PROCESS_NOISE) || 0.01;
  private readonly KALMAN_MEASUREMENT_NOISE =
    Number(process.env.KALMAN_MEASUREMENT_NOISE) || 1.0;

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

    const normalized = this.tickNormalizer.normalize(symbol, price);
    const sanitizedPrice = normalized.price;

    this.lastKnownPrices.set(symbol, sanitizedPrice);
    this.lastUpdateTs.set(symbol, safeTs);

    if (!this.firstSeen.has(symbol)) {
      this.firstSeen.set(symbol, safeTs);
      if (this.DEBUG) this.logger.debug(`New symbol tracked: ${symbol}`);
    }

    this.addRawPoint(symbol, { timestamp: safeTs, price: sanitizedPrice, isSpike: normalized.isSpike });

    if (this.triggerEngine && typeof this.triggerEngine.onPriceUpdate === 'function') {
      try {
        void this.triggerEngine.onPriceUpdate(symbol, sanitizedPrice);
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

    const snapshot = this.buildWindowSnapshot(map, bucketSize, minutes, Date.now());
    if (!snapshot) {
      return { availableBuckets: 0, expectedBuckets: 0, coveragePercent: 0, missingBuckets: 0 };
    }

    return {
      availableBuckets: snapshot.availableBuckets,
      expectedBuckets: snapshot.expectedBuckets,
      coveragePercent: snapshot.coveragePercent,
      missingBuckets: snapshot.missingBuckets,
    };
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

  private addRawPoint(symbol: string, point: { timestamp: number; price: number; isSpike: boolean }): void {
    const { timestamp: ts, price, isSpike } = point;
    this.updateBucket(symbol, ts, price, 15_000, this.buckets15s, isSpike);
    this.updateBucket(symbol, ts, price, 60_000, this.buckets1m, isSpike);
  }

  private updateBucket(
    symbol: string,
    ts: number,
    price: number,
    bucketSize: number,
    store: Map<string, SortedBucketMap>,
    isSpike: boolean,
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
        spikeCount: 0,
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
    if (isSpike) b.spikeCount++;

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
    const currentPrice = this.lastKnownPrices.get(symbol) ?? 0;
    const currentTs = this.lastUpdateTs.get(symbol) ?? now;

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      if (this.DEBUG) this.logger.debug(`❌ No current price for ${symbol}`);
      return null;
    }

    // Warmup: require firstSeen >= window
    const firstSeenTs = this.firstSeen.get(symbol) ?? now;
    const hasWallClockHistory = (now - firstSeenTs) >= durationMs;

    if (!hasWallClockHistory) {
      if (this.DEBUG) {
        this.logger.debug(`Warmup: not enough wall-clock history for ${symbol} ${minutes}m`);
      }
      this.warmupRejects++;
      return null;
    }

    const snapshot = this.buildWindowSnapshot(map, bucketSize, minutes, now);
    if (!snapshot) {
      if (this.DEBUG) this.logger.debug(`❌ No closed buckets snapshot for ${symbol} ${minutes}m`);
      return null;
    }

    const coverageThreshold = this.getCoverageThreshold(minutes);
    const minFallbackCoverage = Math.max(30, Math.floor(coverageThreshold * 0.5));
    if (snapshot.coveragePercent < coverageThreshold) {
      if (this.DEBUG) {
        this.logger.debug(`Coverage ${snapshot.coveragePercent}% < ${coverageThreshold}% for ${symbol} ${minutes}m`);
      }
      if (snapshot.coveragePercent < minFallbackCoverage) {
        return this.tryFallback(map, snapshot, bucketSize, durationMs, minutes);
      }
      // умеренное покрытие: продолжаем, но сохраняем метку в результате
    }

    const minSamples = this.effectiveMinSamples(minutes);
    if (snapshot.candles.length < minSamples) {
      if (this.DEBUG) {
        this.logger.debug(`Samples ${snapshot.candles.length}/${minSamples} for ${symbol} ${minutes}m`);
      }
      return null;
    }

    if (snapshot.spikeShare > this.SPIKE_SHARE_LIMIT) {
      if (this.DEBUG) {
        this.logger.debug(`Spike share ${snapshot.spikeShare.toFixed(3)} > ${this.SPIKE_SHARE_LIMIT} for ${symbol}`);
      }
      return null;
    }

    if (snapshot.maxGapMs > this.MAX_GAP_FACTOR * bucketSize) {
      if (this.DEBUG) {
        this.logger.debug(`Gap ${snapshot.maxGapMs}ms > ${this.MAX_GAP_FACTOR}*bucket for ${symbol}`);
      }
      return null;
    }

    const effectivePoint = { price: currentPrice, ts: Math.min(currentTs, now) };
    const metrics = this.evaluateWindow(snapshot, map, effectivePoint, symbol);

    if (metrics) {
      this.metricsCalculated++;
      if (this.DEBUG) {
        this.logger.info(`✅ ${symbol} ${minutes}m -> ${metrics.priceChangePercent}% (cov:${snapshot.coveragePercent}%)`);
      }
      return metrics;
    }

    return this.tryFallback(map, snapshot, bucketSize, durationMs, minutes);
  }

  private tryFallback(
    map: SortedBucketMap,
    snapshot: WindowSnapshot,
    bucketSize: number,
    durationMs: number,
    minutes: number,
  ): IMetricChanges | null {
    if (!snapshot) return null;
    const startBucket = Math.floor(snapshot.windowStart / bucketSize) * bucketSize;
    const endBucket = Math.floor(snapshot.windowEnd / bucketSize) * bucketSize;
    return this.fallbackInterpolation(
      map,
      startBucket,
      endBucket,
      bucketSize,
      durationMs,
      minutes,
    );
  }

  private buildWindowSnapshot(
    map: SortedBucketMap,
    bucketSize: number,
    minutes: number,
    now: number,
  ): WindowSnapshot | null {
    const durationMs = minutes * 60_000;
    const rawWindowEnd = Math.max(0, now - this.ACTIVE_BUCKET_GRACE_MS);
    const windowEnd = Math.floor(rawWindowEnd / bucketSize) * bucketSize;
    if (windowEnd <= 0) return null;
    const rawWindowStart = windowEnd - durationMs;
    const windowStart = Math.floor(rawWindowStart / bucketSize) * bucketSize;
    if (windowEnd <= windowStart) return null;

    const expectedMs = windowEnd - windowStart;
    if (expectedMs <= 0) return null;

    const keys = map.getSortedKeys();
    if (keys.length === 0) return null;

    const candles: Bucket[] = [];
    let coveredMs = 0;
    let totalCount = 0;
    let totalSpikes = 0;
    let maxGapMs = 0;
    let lastCoveredEnd: number | null = null;

    for (const key of keys) {
      const bucketStart = key;
      const bucketEnd = bucketStart + bucketSize;

      if (bucketEnd <= windowStart) continue;
      if (bucketStart >= windowEnd) break;

      const bucket = map.get(key);
      if (!bucket || bucket.count === 0) continue;

      if (bucketEnd > windowEnd) {
        // ещё не закрыт
        continue;
      }

      candles.push(bucket);

      const overlapStart = Math.max(bucketStart, windowStart);
      const overlapEnd = Math.min(bucketEnd, windowEnd);
      if (overlapEnd > overlapStart) coveredMs += overlapEnd - overlapStart;

      totalCount += bucket.count;
      totalSpikes += bucket.spikeCount;

      if (lastCoveredEnd !== null) {
        const gap = bucketStart - lastCoveredEnd;
        if (gap > maxGapMs) maxGapMs = gap;
      } else {
        const initialGap = bucketStart - windowStart;
        if (initialGap > maxGapMs) maxGapMs = initialGap;
      }

      lastCoveredEnd = bucketEnd;
    }

    if (!candles.length) return null;

    const trailingGap = windowEnd - (lastCoveredEnd ?? windowStart);
    if (trailingGap > maxGapMs) maxGapMs = trailingGap;

    const expectedBuckets = Math.max(1, Math.round(expectedMs / bucketSize));
    const availableBuckets = candles.length;
    const missingBuckets = Math.max(0, expectedBuckets - availableBuckets);
    const coveragePercent = expectedMs > 0
      ? Math.min(100, Math.round((coveredMs / expectedMs) * 100))
      : 0;
    const spikeShare = totalCount > 0 ? totalSpikes / totalCount : 0;

    return {
      candles,
      windowStart,
      windowEnd,
      expectedBuckets,
      availableBuckets,
      missingBuckets,
      coveragePercent,
      coveredMs,
      expectedMs,
      spikeShare,
      maxGapMs,
    };
  }

  private evaluateWindow(
    snapshot: WindowSnapshot,
    map: SortedBucketMap,
    currentPoint: { price: number; ts: number },
    symbol: string,
  ): IMetricChanges | null {
    if (!Number.isFinite(currentPoint.price) || currentPoint.price <= 0) return null;
    if (currentPoint.ts < snapshot.windowStart) return null;

    const candles = snapshot.candles;
    if (!candles.length) return null;

    // Создаем точки с согласованными временными метками
    const points: Array<{ value: number; ts: number }> = candles.map(c => ({
      value: c.close,
      ts: c.lastTs, // Используем время закрытия бака
    }));

    // Проверяем временную последовательность
    const lastCandleTs = points[points.length - 1].ts;
    if (currentPoint.ts <= lastCandleTs) {
      // Текущая точка раньше или совпадает с последним баком - обновляем последнюю точку
      points[points.length - 1] = { 
        value: currentPoint.price, 
        ts: Math.max(currentPoint.ts, lastCandleTs) // Сохраняем максимальное время
      };
    } else {
      // Текущая точка после последнего бака - добавляем новую точку
      points.push({ value: currentPoint.price, ts: currentPoint.ts });
    }

    // Проверяем временную упорядоченность
    for (let i = 1; i < points.length; i++) {
      if (points[i].ts < points[i-1].ts) {
        if (this.DEBUG) this.logger.debug(`Temporal inconsistency detected`);
        return null;
      }
    }

    if (points.length < 2) return null;

    const closes = points.map(p => p.value);
    const medianSeries = this.applySlidingMedian(closes);
    const kalmanSeries = this.runKalman(medianSeries, symbol); // Передаем symbol
    if (kalmanSeries.length === 0) return null;

    // сохраняем фактический текущий тик
    // kalmanSeries[kalmanSeries.length - 1] = currentPoint.price;

    const currentIdx = kalmanSeries.length - 1;
    const currentValue = kalmanSeries[currentIdx];
    const currentTs = points[currentIdx].ts;

    let bestUp: Movement | null = null;
    let bestDown: Movement | null = null;

    for (let i = 0; i < currentIdx; i++) {
      const startPrice = kalmanSeries[i];
      if (!Number.isFinite(startPrice) || startPrice <= 0) continue;

      const change = ((currentValue - startPrice) / startPrice) * 100;
      // Используем временные метки из points, которые теперь согласованы
      const durationSec = Math.max(1, Math.floor((points[currentIdx].ts - points[i].ts) / 1000));
      if (change >= 0) {
        const movement: Movement = {
          percent: Number(change.toFixed(6)),
          startPrice,
          endPrice: currentValue,
          duration: durationSec,
          startTs: points[i].ts,
          endTs: currentTs,
        };
        if (!bestUp || movement.percent > bestUp.percent) {
          bestUp = movement;
        }
      } else {
        const dropPercent = Number((-change).toFixed(6));
        const movement: Movement = {
          percent: dropPercent,
          startPrice,
          endPrice: currentValue,
          duration: durationSec,
          startTs: points[i].ts,
          endTs: currentTs,
        };
        if (!bestDown || movement.percent > bestDown.percent) {
          bestDown = movement;
        }
      }
    }

    const chosen = this.pickMovement(bestUp, bestDown);
    if (!chosen) return null;

    const signedPercent = chosen.direction === 'up'
      ? chosen.movement.percent
      : -chosen.movement.percent;

    // Вычисляем netChangePercent альтернативным способом если основной не работает
    let netChangePercent = this.computeRobustNetChange(
      map, snapshot.windowStart, currentPoint.price, snapshot.candles
    );

    const result: any = {
      priceChangePercent: Number(signedPercent.toFixed(6)),
      currentPrice: Number(currentPoint.price.toFixed(8)),
      previousPrice: Number(chosen.movement.startPrice.toFixed(8)),
      timeWindowSeconds: chosen.movement.duration,
      upPercent: bestUp ? bestUp.percent : 0,
      upStartPrice: bestUp?.startPrice,
      upEndPrice: bestUp ? currentPoint.price : undefined,
      upDuration: bestUp?.duration,
      downPercent: bestDown ? bestDown.percent : 0,
      downStartPrice: bestDown?.startPrice,
      downEndPrice: bestDown ? currentPoint.price : undefined,
      downDuration: bestDown?.duration,
      netChangePercent: netChangePercent,
      coveragePercent: snapshot.coveragePercent,
      availableBuckets: snapshot.availableBuckets,
      expectedBuckets: snapshot.expectedBuckets,
      spikeShare: Number(snapshot.spikeShare.toFixed(4)),
      maxGapMs: snapshot.maxGapMs,
      windowStartTs: snapshot.windowStart,
      windowEndTs: snapshot.windowEnd,
    };

    return result as IMetricChanges;
  }

  private applySlidingMedian(series: number[]): number[] {
    if (series.length === 0) return [];
    const window = Math.max(1, this.MEDIAN_FILTER_WINDOW);
    const buffer: number[] = [];
    return series.map(value => {
      buffer.push(value);
      if (buffer.length > window) buffer.shift();
      return this.computeMedian(buffer);
    });
  }

  private runKalman(values: number[], symbol?: string): number[] {
    if (values.length === 0) return [];
    const result: number[] = [];
    let estimate = values[0];
    let covariance = 1;
    
    // Базовые параметры
    const q = this.KALMAN_PROCESS_NOISE;
    let r = this.KALMAN_MEASUREMENT_NOISE;

    // Адаптация R на основе текущего MAD из TickNormalizer
    // Предполагаем, что symbol доступен через замыкание или нужно передать
    // Для простоты используем глобальную адаптацию (без привязки к символу)
    try {
      // Если нужно привязать к символу, потребуется изменить сигнатуру метода
      const recentMad = this.calculateVolatility(values.slice(-10));
      if (recentMad > 0) {
        r = Math.max(0.1, recentMad * 15); // MAD * 15 дает хорошую scaling
      }
    } catch (e) {
      // fallback к стандартному R
    }

    result.push(estimate);

    for (let i = 1; i < values.length; i++) {
      const measurement = Number.isFinite(values[i]) ? values[i] : estimate;
      covariance = covariance + q;
      const gain = covariance / (covariance + r);
      estimate = estimate + gain * (measurement - estimate);
      covariance = (1 - gain) * covariance;
      result.push(estimate);
    }

    return result;
  }

  private pickMovement(up: Movement | null, down: Movement | null): { direction: 'up' | 'down'; movement: Movement } | null {
    if (up && down) {
      // Сравниваем абсолютные величины изменений, а не просто проценты
      return Math.abs(up.percent) >= Math.abs(down.percent)
        ? { direction: 'up', movement: up }
        : { direction: 'down', movement: down };
    }
    if (up) return { direction: 'up', movement: up };
    if (down) return { direction: 'down', movement: down };
    return null;
  }

  private computeMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  private computeNetChange(map: SortedBucketMap, windowStart: number, endPrice: number): number | null {
    const startPrice = this.getPriceAtBoundary(map, windowStart);
    if (startPrice === null || startPrice <= 0 || !Number.isFinite(endPrice) || endPrice <= 0) {
      return null;
    }
    return Number((((endPrice - startPrice) / startPrice) * 100).toFixed(6));
  }

  private computeRobustNetChange(
    map: SortedBucketMap, 
    windowStart: number, 
    endPrice: number,
    fallbackCandles: Bucket[]
  ): number | null {
    // Основной метод с интерполяцией
    const startPrice = this.getPriceAtBoundary(map, windowStart);
    if (startPrice !== null && startPrice > 0) {
      return Number((((endPrice - startPrice) / startPrice) * 100).toFixed(6));
    }
    
    // Fallback 1: использовать первый бак с интерполяцией
    if (fallbackCandles.length > 0) {
      const firstCandle = fallbackCandles[0];
      if (firstCandle.firstTs <= windowStart && windowStart <= firstCandle.lastTs) {
        const interpolated = this.interpolate(
          firstCandle.firstTs, firstCandle.open,
          firstCandle.lastTs, firstCandle.close,
          windowStart
        );
        return Number((((endPrice - interpolated) / interpolated) * 100).toFixed(6));
      }
    }
    
    // Fallback 2: использовать первый available бак
    if (fallbackCandles.length > 0) {
      return Number((((endPrice - fallbackCandles[0].open) / fallbackCandles[0].open) * 100).toFixed(6));
    }
    
    return null;
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

    // Вычисляем реальную длительность окна
    const actualDurationMs = endKey - startKey;
    const actualWindowSeconds = Math.max(1, Math.floor(actualDurationMs / 1000));

    if (this.DEBUG) {
      this.logger.warn(
        `🔄 Fallback used: ${priceChangePercent.toFixed(4)}% ` +
        `(actual window: ${actualWindowSeconds}s vs expected: ${minutes * 60}s) ` +
        `(${new Date(startKey).toISOString()} → ${new Date(endKey).toISOString()})`
      );
    }

    return {
      priceChangePercent,
      currentPrice: endPrice,
      previousPrice: startPrice,
      timeWindowSeconds: actualWindowSeconds, // Используем реальную длительность
      fallbackApplied: true, // Флаг что использован fallback
      expectedWindowSeconds: minutes * 60, // Ожидаемая длительность для сравнения
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
    // Очищаем буфер в TickNormalizer
    this.tickNormalizer.removeSymbol(symbol);
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

  private calculateVolatility(values: number[]): number {
    if (values.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < values.length; i++) {
      sum += Math.abs(values[i] - values[i-1]) / values[i-1];
    }
    return sum / (values.length - 1);
  }
}
