import { Injectable } from '../../shared/decorators';
import {
  IDataAggregatorService,
  IMetricChanges,
  ITriggerEngineService,
} from '../../domain/interfaces/services.interface';
import { Logger } from '../../shared/logger';

type RawPoint = {
  timestamp: number;
  price: number;
};

type TimeBucket = {
  timestamp: number;
  price: number;
  sampleCount: number;
};

@Injectable()
export class DataAggregatorService implements IDataAggregatorService {
  private readonly logger = new Logger(DataAggregatorService.name);

  // Configuration
  private readonly MAX_DATA_AGE_MINUTES = 60;
  private readonly MAX_RAW_POINTS = 2000;
  private readonly CACHE_TTL_MS = 10_000;
  private readonly CLEANUP_INTERVAL_MS = 30_000;

  // UPDATED: Four-tier bucket system (added 2-minute buckets)
  private readonly BUCKET_SIZES = {
    SECOND_15: 15 * 1000, // 15-second buckets for 1-4 min intervals
    MINUTE_1: 60 * 1000, // 1-minute buckets for 5-10 min intervals
    MINUTE_2: 2 * 60 * 1000, // 2-minute buckets for 11-20 min intervals
    MINUTE_5: 5 * 60 * 1000, // 5-minute buckets for 21-60 min intervals
  };

  // Storage
  private readonly rawPoints = new Map<string, RawPoint[]>();
  private triggerEngine?: ITriggerEngineService;

  // Four-tier bucket system
  private readonly buckets15sec = new Map<string, Map<number, TimeBucket>>();
  private readonly buckets1min = new Map<string, Map<number, TimeBucket>>();
  private readonly buckets2min = new Map<string, Map<number, TimeBucket>>();
  private readonly buckets5min = new Map<string, Map<number, TimeBucket>>();

  private readonly lastSeen = new Map<string, number>();
  private readonly calcCache = new Map<string, { timestamp: number; result: IMetricChanges }>();
  private readonly locks = new Map<string, Promise<void>>();

  // Persistent cache (survives cleanup)
  private readonly lastKnownPrices = new Map<string, number>();

  private readonly updateQueues = new Map<string, Array<() => Promise<void>>>();
  private readonly processingSymbols = new Set<string>();

  // ADD: Missing declaration for updateCounts
  private readonly updateCounts = new Map<string, number>();

  private cleanupTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;

  // Performance tracking
  private stats = {
    bucket15secHits: 0,
    bucket1minHits: 0,
    bucket2minHits: 0,
    bucket5minHits: 0,
    interpolationHits: 0,
    totalCalculations: 0,
  };

  constructor() {
    this.cleanupTimer = setInterval(() => this.performCleanup(), this.CLEANUP_INTERVAL_MS);
    this.statsTimer = setInterval(() => this.logStats(), 60_000); // Log every minute
  }

  public setTriggerEngine(engine: ITriggerEngineService): void {
    // NEW
    this.triggerEngine = engine;
  }

  private getBucketFillPercentage(
    bucketMap: Map<string, Map<number, TimeBucket>>,
    symbol: string,
    maxSamplesPerBucket: number
  ): string {
    const symbolBuckets = bucketMap.get(symbol);
    if (!symbolBuckets || symbolBuckets.size === 0) return '0%';
  
    let totalFillPercent = 0;
    for (const bucket of symbolBuckets.values()) {
      const fillPercent = Math.min((bucket.sampleCount / maxSamplesPerBucket) * 100, 100);
      totalFillPercent += fillPercent;
    }
  
    const avgFillPercent = totalFillPercent / symbolBuckets.size;
    return `${avgFillPercent.toFixed(1)}%`;
  }

  public updatePrice(symbol: string, price: number, timestamp: number): void {
    if (price <= 0) return;

    this.lastKnownPrices.set(symbol, price);
    this.insertRawPoint(symbol, { timestamp, price });

    // Update ALL bucket types including 2min
    this.updateBucket(symbol, timestamp, price, this.BUCKET_SIZES.SECOND_15, this.buckets15sec);
    this.updateBucket(symbol, timestamp, price, this.BUCKET_SIZES.MINUTE_1, this.buckets1min);
    this.updateBucket(symbol, timestamp, price, this.BUCKET_SIZES.MINUTE_2, this.buckets2min);
    this.updateBucket(symbol, timestamp, price, this.BUCKET_SIZES.MINUTE_5, this.buckets5min);

    this.invalidateCache(symbol);

    // ADD: Periodic bucket status (every 100 updates per symbol)
    const updateCount = (this.updateCounts.get(symbol) || 0) + 1;
    this.updateCounts.set(symbol, updateCount);

    if (updateCount % 100 === 0) {
      const buckets15s = this.buckets15sec.get(symbol)?.size || 0;
      const buckets1m = this.buckets1min.get(symbol)?.size || 0;
      const buckets2m = this.buckets2min.get(symbol)?.size || 0;
      const buckets5m = this.buckets5min.get(symbol)?.size || 0;
      
      const fill15s = this.getBucketFillPercentage(this.buckets15sec, symbol, 15); // 15 samples max for 15s bucket
      const fill1m = this.getBucketFillPercentage(this.buckets1min, symbol, 60);   // 60 samples max for 1m bucket
      const fill2m = this.getBucketFillPercentage(this.buckets2min, symbol, 120);  // 120 samples max for 2m bucket
      const fill5m = this.getBucketFillPercentage(this.buckets5min, symbol, 300);  // 300 samples max for 5m bucket
      
      this.logger.debug(
        `📦 ${symbol}: ${buckets15s}×15s(${fill15s}), ${buckets1m}×1m(${fill1m}), ${buckets2m}×2m(${fill2m}), ${buckets5m}×5m(${fill5m}) buckets`,
      );
    }

    // NEW: Notify trigger engine on every update
    if (this.triggerEngine) {
      this.triggerEngine.onPriceUpdate(symbol, price).catch((err) => {
        this.logger.error(`Error in trigger engine for ${symbol}:`, err);
      });
    }
  }

  public getMetricChanges(symbol: string, timeIntervalMinutes: number): IMetricChanges | null {
    const key = `${symbol}_${timeIntervalMinutes}`;
    const cached = this.calcCache.get(key);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.result;
    }

    const result = this.calculateAdaptive(symbol, timeIntervalMinutes);

    if (result) {
      this.calcCache.set(key, { timestamp: Date.now(), result });
    }

    return result;
  }

  private calculateAdaptive(symbol: string, minutes: number): IMetricChanges | null {
    const intervalMs = minutes * 60 * 1000;

    // Choose best bucket size based on interval
    if (minutes <= 4) {
      return this.calculateFromBuckets(
        symbol,
        intervalMs,
        this.BUCKET_SIZES.SECOND_15,
        this.buckets15sec,
      );
    } else if (minutes <= 15) {
      return this.calculateFromBuckets(
        symbol,
        intervalMs,
        this.BUCKET_SIZES.MINUTE_1,
        this.buckets1min,
      );
    } else {
      return this.calculateFromBuckets(
        symbol,
        intervalMs,
        this.BUCKET_SIZES.MINUTE_5,
        this.buckets5min,
      );
    }
  }

  private calculateFromBuckets(
    symbol: string,
    intervalMs: number,
    bucketSize: number,
    bucketMap: Map<string, Map<number, TimeBucket>>,
  ): IMetricChanges | null {
    const symbolBuckets = bucketMap.get(symbol);
    if (!symbolBuckets || symbolBuckets.size === 0) return null;

    const now = Date.now();
    const startTime = now - intervalMs;

    const endBucket = Math.floor(now / bucketSize) * bucketSize;
    const startBucket = Math.floor(startTime / bucketSize) * bucketSize;

    const startData = symbolBuckets.get(startBucket);
    const endData = symbolBuckets.get(endBucket);

    if (!startData || !endData) return null;
    if (startData.sampleCount < 3 || endData.sampleCount < 3) return null;

    const priceChangePercent =
      startData.price > 0 ? ((endData.price - startData.price) / startData.price) * 100 : 0;

    return {
      priceChangePercent,
      currentPrice: endData.price,
      previousPrice: startData.price,
      timeWindowSeconds: (endBucket - startBucket) / 1000,
    };
  }

  private updateBucket(
    symbol: string,
    timestamp: number,
    price: number,
    bucketSize: number,
    bucketMap: Map<string, Map<number, TimeBucket>>,
  ): void {
    if (!bucketMap.has(symbol)) {
      bucketMap.set(symbol, new Map());
    }

    const symbolBuckets = bucketMap.get(symbol)!;
    const bucketTime = Math.floor(timestamp / bucketSize) * bucketSize;

    let bucket = symbolBuckets.get(bucketTime);

    if (!bucket) {
      bucket = { timestamp: bucketTime, price, sampleCount: 1 };
      symbolBuckets.set(bucketTime, bucket);
    } else {
      const alpha = 0.3; // EMA smoothing
      bucket.price = bucket.price * (1 - alpha) + price * alpha;
      bucket.sampleCount++;
    }
  }

  public getAllKnownSymbols(): string[] {
    const symbols = new Set<string>();
    for (const s of this.rawPoints.keys()) symbols.add(s);
    for (const s of this.buckets15sec.keys()) symbols.add(s);
    for (const s of this.buckets1min.keys()) symbols.add(s);
    for (const s of this.buckets2min.keys()) symbols.add(s);
    for (const s of this.buckets5min.keys()) symbols.add(s);
    for (const s of this.lastKnownPrices.keys()) symbols.add(s);
    return Array.from(symbols);
  }

  public getHistoryLength(symbol: string): number {
    const arr = this.rawPoints.get(symbol);
    return arr ? arr.length : 0;
  }

  private async enqueue(symbol: string, fn: () => Promise<void>): Promise<void> {
    if (!this.updateQueues.has(symbol)) {
      this.updateQueues.set(symbol, []);
    }

    const queue = this.updateQueues.get(symbol)!;

    // Prevent queue overflow
    if (queue.length > 100) {
      this.logger.warn(`Queue overflow for ${symbol}, dropping old updates`);
      queue.shift();
    }

    queue.push(fn);

    if (!this.processingSymbols.has(symbol)) {
      await this.processQueue(symbol);
    }
  }

  private async processQueue(symbol: string): Promise<void> {
    this.processingSymbols.add(symbol);
    const queue = this.updateQueues.get(symbol)!;

    while (queue.length > 0) {
      const fn = queue.shift()!;
      try {
        await fn();
      } catch (error) {
        this.logger.error(`Queue processing error for ${symbol}:`, error);
      }
    }

    this.processingSymbols.delete(symbol);
  }

  private peekLastPrice(symbol: string): number {
    const arr = this.rawPoints.get(symbol);
    if (arr && arr.length) {
      return arr[arr.length - 1].price;
    }
    return this.lastKnownPrices.get(symbol) || 0;
  }

  private insertRawPoint(symbol: string, point: RawPoint): void {
    if (!this.rawPoints.has(symbol)) this.rawPoints.set(symbol, []);
    const arr = this.rawPoints.get(symbol)!;

    if (!arr.length || point.timestamp >= arr[arr.length - 1].timestamp) {
      arr.push(point);
    } else {
      let lo = 0,
        hi = arr.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].timestamp === point.timestamp) {
          arr[mid] = point;
          return;
        }
        if (arr[mid].timestamp < point.timestamp) lo = mid + 1;
        else hi = mid - 1;
      }
      arr.splice(lo, 0, point);
    }

    if (arr.length > this.MAX_RAW_POINTS) {
      arr.splice(0, arr.length - this.MAX_RAW_POINTS);
    }
  }

  private invalidateCache(symbol: string): void {
    for (const k of Array.from(this.calcCache.keys())) {
      if (k.startsWith(symbol + '_')) this.calcCache.delete(k);
    }
  }

  private performCleanup(): void {
    const now = Date.now();

    // Clean calculation cache
    for (const [k, v] of this.calcCache.entries()) {
      if (now - v.timestamp > this.CACHE_TTL_MS) this.calcCache.delete(k);
    }

    // Clean raw points
    const maxAgeMs = this.MAX_DATA_AGE_MINUTES * 60 * 1000;
    for (const [symbol, arr] of this.rawPoints.entries()) {
      const firstAccept = now - maxAgeMs;
      let i = 0;
      while (i < arr.length && arr[i].timestamp < firstAccept) i++;
      if (i > 0) arr.splice(0, i);
      if (arr.length === 0) this.rawPoints.delete(symbol);
    }

    // Clean all bucket levels
    this.cleanBuckets(this.buckets15sec, now, 60 * 60 * 1000, 240); // 60 min, 240 buckets
    this.cleanBuckets(this.buckets1min, now, 60 * 60 * 1000, 60); // 60 min, 60 buckets
    this.cleanBuckets(this.buckets2min, now, 60 * 60 * 1000, 30); // 60 min, 30 buckets
    this.cleanBuckets(this.buckets5min, now, 60 * 60 * 1000, 12); // 60 min, 12 buckets

    // Clean stale symbols (2+ hours)
    const staleThreshold = now - this.MAX_DATA_AGE_MINUTES * 2 * 60 * 1000;
    for (const [symbol, last] of this.lastSeen.entries()) {
      if (last < staleThreshold) {
        this.rawPoints.delete(symbol);
        this.buckets15sec.delete(symbol);
        this.buckets1min.delete(symbol);
        this.buckets2min.delete(symbol);
        this.buckets5min.delete(symbol);
        this.invalidateCache(symbol);
        this.locks.delete(symbol);
        this.lastSeen.delete(symbol);
        this.lastKnownPrices.delete(symbol);
      }
    }
  }

  // UPDATED: Clean buckets with 2-minute safety buffer
  private cleanBuckets(
    bucketMap: Map<string, Map<number, TimeBucket>>,
    now: number,
    maxAge: number,
    maxBuckets: number,
  ): void {
    // CRITICAL FIX: Add 2-minute safety buffer to prevent premature deletion
    const buffer = 2 * 60 * 1000;
    const threshold = now - maxAge - buffer;

    for (const [symbol, buckets] of bucketMap.entries()) {
      for (const [timestamp] of buckets.entries()) {
        if (timestamp < threshold) {
          buckets.delete(timestamp);
        }
      }

      // Also enforce max bucket count
      if (buckets.size > maxBuckets) {
        const sorted = Array.from(buckets.keys()).sort((a, b) => a - b);
        const toRemove = sorted.slice(0, buckets.size - maxBuckets);
        for (const ts of toRemove) {
          buckets.delete(ts);
        }
      }

      if (buckets.size === 0) {
        bucketMap.delete(symbol);
      }
    }
  }

  private logStats(): void {
    const total = this.stats.totalCalculations;
    if (total === 0) return;

    const pct15sec = ((this.stats.bucket15secHits / total) * 100).toFixed(1);
    const pct1min = ((this.stats.bucket1minHits / total) * 100).toFixed(1);
    const pct2min = ((this.stats.bucket2minHits / total) * 100).toFixed(1);
    const pct5min = ((this.stats.bucket5minHits / total) * 100).toFixed(1);
    const pctInterp = ((this.stats.interpolationHits / total) * 100).toFixed(1);

    this.logger.info(
      `Aggregator Stats: Total=${total}, ` +
        `15s=${pct15sec}%, 1m=${pct1min}%, 2m=${pct2min}%, 5m=${pct5min}%, Interp=${pctInterp}%`,
    );

    // Reset stats
    this.stats = {
      bucket15secHits: 0,
      bucket1minHits: 0,
      bucket2minHits: 0,
      bucket5minHits: 0,
      interpolationHits: 0,
      totalCalculations: 0,
    };
  }

  public getCurrentPrice(symbol: string): number {
    const arr = this.rawPoints.get(symbol);
    if (arr && arr.length > 0) {
      return arr[arr.length - 1].price;
    }

    const lastKnown = this.lastKnownPrices.get(symbol);
    if (lastKnown) {
      const lastSeenTime = this.lastSeen.get(symbol);
      const timeSinceUpdate = lastSeenTime ? Date.now() - lastSeenTime : -1;
      this.logger.debug(
        `Using cached price for ${symbol}: $${lastKnown.toFixed(4)} ` +
          `(last update ${(timeSinceUpdate / 1000).toFixed(0)}s ago)`,
      );
      return lastKnown;
    }

    this.logger.warn(
      `⚠️ NO PRICE DATA for ${symbol}! ` +
        `RawPoints: ${arr?.length || 0}, ` +
        `HasCachedPrice: false, ` +
        `LastSeen: ${this.lastSeen.has(symbol) ? `${((Date.now() - this.lastSeen.get(symbol)!) / 1000).toFixed(0)}s ago` : 'never'}`,
    );

    return 0;
  }

  public shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }
}
