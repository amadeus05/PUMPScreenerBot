import { Injectable } from '../../shared/decorators';
import {
  IDataAggregatorService,
  IMetricChanges,
  ITriggerEngineService,
} from '../../domain/interfaces/services.interface';
import { Logger } from '../../shared/logger';

type RawPoint = { timestamp: number; price: number };
type TimeBucket = { timestamp: number; price: number; sampleCount: number };

@Injectable()
export class DataAggregatorService implements IDataAggregatorService {
  private readonly logger = new Logger(DataAggregatorService.name);

  // === CONFIGURATION (tuneable by env if desired) ===
  private readonly MAX_DATA_AGE_MINUTES = Number(process.env.MAX_DATA_AGE_MINUTES) || 60;
  private readonly MAX_RAW_POINTS = Number(process.env.MAX_RAW_POINTS) || 2000;
  private readonly CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 10_000;
  private readonly CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS) || 30_000;

  // bucket sizes kept as original for backward compatibility
  private readonly BUCKET_SIZES = {
    SECOND_15: 15 * 1000,
    MINUTE_1: 60 * 1000,
    MINUTE_2: 2 * 60 * 1000,
    MINUTE_5: 5 * 60 * 1000,
  } as const;

  // === STORAGE ===
  private readonly rawPoints = new Map<string, RawPoint[]>();
  private readonly buckets15sec = new Map<string, Map<number, TimeBucket>>();
  private readonly buckets1min = new Map<string, Map<number, TimeBucket>>();
  private readonly buckets2min = new Map<string, Map<number, TimeBucket>>();
  private readonly buckets5min = new Map<string, Map<number, TimeBucket>>();
  private readonly lastSeen = new Map<string, number>();
  private readonly lastKnownPrices = new Map<string, number>();
  private readonly calcCache = new Map<string, { timestamp: number; result: IMetricChanges }>();
  private readonly updateCounts = new Map<string, number>();

  // keep track of first-seen time to support warm-up checks
  private readonly firstSeen = new Map<string, number>();

  // optional: minimal samples required in a bucket to consider its price "stable"
  private readonly MIN_BUCKET_SAMPLES = Number(process.env.MIN_BUCKET_SAMPLES) || 4;
  // don't apply EMA smoothing until the bucket has at least this many samples
  private readonly EMA_ENABLED_AFTER_SAMPLES = Number(process.env.EMA_ENABLED_AFTER_SAMPLES) || 4;

  // warm-up: require this many seconds of history equal to requested interval before returning metrics
  private readonly WARMUP_FACTOR = Number(process.env.WARMUP_FACTOR) || 1.0; // multiplier for required history (1.0 => require full interval)

  private triggerEngine?: ITriggerEngineService;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;

  private stats = {
    bucket15secHits: 0,
    bucket1minHits: 0,
    bucket2minHits: 0,
    bucket5minHits: 0,
    interpolationHits: 0,
    totalCalculations: 0,
  };

  constructor() {
    // periodic maintenance
    this.cleanupTimer = setInterval(() => this.performCleanup(), this.CLEANUP_INTERVAL_MS);
    this.statsTimer = setInterval(() => this.logStats(), 60_000);
  }

  public setTriggerEngine(engine: ITriggerEngineService): void {
    this.triggerEngine = engine;
  }

  /**
   * Update price stream. Backward-compatible signature.
   */
  public updatePrice(symbol: string, price: number, timestamp: number): void {
    if (!symbol || price <= 0 || !Number.isFinite(timestamp)) return;

    // record first seen
    if (!this.firstSeen.has(symbol)) this.firstSeen.set(symbol, timestamp);

    this.lastKnownPrices.set(symbol, price);
    this.lastSeen.set(symbol, timestamp);

    this.insertRawPoint(symbol, { timestamp, price });

    // update buckets with safer initialization (avoid EMA drift on first samples)
    this.updateBucketSafely(
      symbol,
      timestamp,
      price,
      this.BUCKET_SIZES.SECOND_15,
      this.buckets15sec,
    );
    this.updateBucketSafely(symbol, timestamp, price, this.BUCKET_SIZES.MINUTE_1, this.buckets1min);
    this.updateBucketSafely(symbol, timestamp, price, this.BUCKET_SIZES.MINUTE_2, this.buckets2min);
    this.updateBucketSafely(symbol, timestamp, price, this.BUCKET_SIZES.MINUTE_5, this.buckets5min);

    this.invalidateCache(symbol);

    const count = (this.updateCounts.get(symbol) || 0) + 1;
    this.updateCounts.set(symbol, count);
    if (count % 100 === 0) this.logBucketStats(symbol);

    // notify trigger engine (backward-compatible)
    if (this.triggerEngine) {
      this.triggerEngine
        .onPriceUpdate(symbol, price)
        .catch((err) => this.logger.error(`Trigger engine error for ${symbol}:`, err));
    }
  }

  /**
   * Backward-compatible metric retrieval. Returns null while in warm-up or if insufficient data.
   */
  public getMetricChanges(symbol: string, timeIntervalMinutes: number): IMetricChanges | null {
    const key = `${symbol}_${timeIntervalMinutes}`;
    const cached = this.calcCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) return cached.result;

    const result = this.calculateFromBucketsAdaptiveWithWarmup(symbol, timeIntervalMinutes);
    if (result) this.calcCache.set(key, { timestamp: Date.now(), result });
    return result;
  }

  /**
   * New: returns true when symbol has enough history & bucket samples to be considered "warm".
   * This is backward-compatible (new helper), and TriggerEngine can call it if desired.
   */
  public isWarm(symbol: string): boolean {
    const first = this.firstSeen.get(symbol);
    if (!first) return false;

    const now = Date.now();
    // require at least 2x of 1m by default or configurable via WARMUP_FACTOR
    const minSeconds = Math.max(60, this.WARMUP_FACTOR * 60);
    if (now - first < minSeconds * 1000) return false;

    // require some buckets present
    const b15 = this.buckets15sec.get(symbol)?.size || 0;
    const b1 = this.buckets1min.get(symbol)?.size || 0;
    return b15 >= 4 && b1 >= 1; // conservative
  }

  /**
   * Improved adaptive calculation with warm-up checks and safer bucket alignment.
   * Tries to use the most precise bucket available for the requested interval.
   */
  private calculateFromBucketsAdaptiveWithWarmup(
    symbol: string,
    minutes: number,
  ): IMetricChanges | null {
    this.stats.totalCalculations++;

    const intervalMs = minutes * 60 * 1000;
    const now = Date.now();

    // Warm-up: ensure symbol existed long enough to cover requested interval
    const firstSeenTs = this.firstSeen.get(symbol) || 0;
    const requiredHistoryMs = Math.ceil(this.WARMUP_FACTOR * intervalMs);
    if (now - firstSeenTs < requiredHistoryMs) {
      if (this.logger)
        this.logger.debug(
          `Warmup: insufficient history for ${symbol} ${minutes}m (${now - firstSeenTs}ms < ${requiredHistoryMs}ms)`,
        );
      return null;
    }

    // choose best bucket set
    let bucketSize: number;
    let bucketMap: Map<string, Map<number, TimeBucket>>;

    if (minutes <= 0.25) {
      // < 15s essentially
      bucketSize = this.BUCKET_SIZES.SECOND_15;
      bucketMap = this.buckets15sec;
      this.stats.bucket15secHits++;
    } else if (minutes <= 4) {
      bucketSize = this.BUCKET_SIZES.SECOND_15;
      bucketMap = this.buckets15sec;
      this.stats.bucket15secHits++;
    } else if (minutes <= 15) {
      bucketSize = this.BUCKET_SIZES.MINUTE_1;
      bucketMap = this.buckets1min;
      this.stats.bucket1minHits++;
    } else if (minutes <= 30) {
      bucketSize = this.BUCKET_SIZES.MINUTE_2;
      bucketMap = this.buckets2min;
      this.stats.bucket2minHits++;
    } else {
      bucketSize = this.BUCKET_SIZES.MINUTE_5;
      bucketMap = this.buckets5min;
      this.stats.bucket5minHits++;
    }

    const symbolBuckets = bucketMap.get(symbol);
    if (!symbolBuckets || symbolBuckets.size === 0) return null;

    // compute target buckets (use aligned bucket boundaries to avoid tiny windows)
    const endBucket = Math.floor(now / bucketSize) * bucketSize;
    const startTime = now - intervalMs;
    const startBucket = Math.floor(startTime / bucketSize) * bucketSize;

    // Basic checks: require start and end buckets exist and have sufficient samples
    const startData = symbolBuckets.get(startBucket);
    const endData = symbolBuckets.get(endBucket);

    if (!startData || !endData) {
      // Try to interpolate using raw points if a bucket is missing (graceful fallback)
      const fallback = this.interpolateFromRawPoints(symbol, startTime, now);
      if (fallback) {
        this.stats.interpolationHits++;
        return fallback;
      }
      return null;
    }

    // Require stable buckets (at least MIN_BUCKET_SAMPLES)
    if (
      startData.sampleCount < this.MIN_BUCKET_SAMPLES ||
      endData.sampleCount < this.MIN_BUCKET_SAMPLES
    ) {
      // If sample counts are low, do not use the bucket price; try raw-point interpolation
      const fallback = this.interpolateFromRawPoints(symbol, startTime, now);
      if (fallback) {
        this.stats.interpolationHits++;
        return fallback;
      }
      // otherwise treat as not ready
      if (this.logger)
        this.logger.debug(
          `Insufficient bucket samples for ${symbol}: start=${startData?.sampleCount} end=${endData?.sampleCount}`,
        );
      return null;
    }

    if (startData.price <= 0 || endData.price <= 0) return null;

    const priceChangePercent = ((endData.price - startData.price) / startData.price) * 100;
    const actualWindowSec = (endBucket - startBucket) / 1000;

    // tolerate ±1 bucketSize worth of difference
    const expectedSec = minutes * 60;
    const toleranceSec = bucketSize / 1000;
    if (Math.abs(actualWindowSec - expectedSec) > toleranceSec * 2) {
      // don't trust mismatched window
      if (this.logger)
        this.logger.debug(
          `Window mismatch: ${symbol} ${actualWindowSec}s vs ${expectedSec}s (bucket ${bucketSize}ms)`,
        );
      // fallback to raw interpolation if possible
      const fallback = this.interpolateFromRawPoints(symbol, startTime, now);
      if (fallback) {
        this.stats.interpolationHits++;
        return fallback;
      }
      return null;
    }

    return {
      priceChangePercent,
      currentPrice: endData.price,
      previousPrice: startData.price,
      timeWindowSeconds: actualWindowSec,
    };
  }

  /**
   * Interpolate precise prices using rawPoints when buckets are missing or unstable.
   * Returns IMetricChanges or null.
   */
  private interpolateFromRawPoints(
    symbol: string,
    startTs: number,
    endTs: number,
  ): IMetricChanges | null {
    const arr = this.rawPoints.get(symbol);
    if (!arr || arr.length === 0) return null;

    // find nearest samples to startTs and endTs
    let iStart = -1;
    let iEnd = -1;

    // binary search for performance
    let lo = 0,
      hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].timestamp < startTs) lo = mid + 1;
      else hi = mid - 1;
    }
    iStart = Math.max(0, lo - 1);

    lo = 0;
    hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].timestamp <= endTs) lo = mid + 1;
      else hi = mid - 1;
    }
    iEnd = Math.max(0, Math.min(arr.length - 1, lo - 1));

    // ensure we have sensible indices
    if (iStart < 0 || iEnd < 0 || iStart >= arr.length || iEnd < iStart) return null;

    const startPoint = arr[iStart];
    const endPoint = arr[iEnd];

    // require minimal number of raw samples within window to avoid noise
    const rawCount = iEnd - iStart + 1;
    if (rawCount < Math.max(3, this.MIN_BUCKET_SAMPLES)) return null;

    if (startPoint.price <= 0 || endPoint.price <= 0) return null;

    const priceChangePercent = ((endPoint.price - startPoint.price) / startPoint.price) * 100;
    const actualWindowSec = Math.floor((endPoint.timestamp - startPoint.timestamp) / 1000);

    return {
      priceChangePercent,
      currentPrice: endPoint.price,
      previousPrice: startPoint.price,
      timeWindowSeconds: actualWindowSec || 1,
    };
  }

  /**
   * Safer bucket updater: do not apply EMA smoothing until bucket has EMA_ENABLED_AFTER_SAMPLES samples.
   * This prevents "drift" on first samples which was the main cause of false positives.
   */
  private updateBucketSafely(
    symbol: string,
    timestamp: number,
    price: number,
    bucketSize: number,
    bucketMap: Map<string, Map<number, TimeBucket>>,
  ): void {
    let symbolBuckets = bucketMap.get(symbol);
    if (!symbolBuckets) {
      symbolBuckets = new Map();
      bucketMap.set(symbol, symbolBuckets);
    }

    const bucketTime = Math.floor(timestamp / bucketSize) * bucketSize;
    let bucket = symbolBuckets.get(bucketTime);

    if (!bucket) {
      bucket = { timestamp: bucketTime, price, sampleCount: 1 };
      symbolBuckets.set(bucketTime, bucket);
      return;
    }

    // if bucket has few samples, use simple average for first few updates to avoid EMA bias
    if (bucket.sampleCount < this.EMA_ENABLED_AFTER_SAMPLES) {
      // running average: newAvg = oldAvg + (price - oldAvg) / (n+1)
      const n = bucket.sampleCount;
      bucket.price = (bucket.price * n + price) / (n + 1);
      bucket.sampleCount++;
      return;
    }

    // apply EMA smoothing afterwards
    const alpha = 0.3; // keep original behavior after warm-up
    bucket.price = bucket.price * (1 - alpha) + price * alpha;
    bucket.sampleCount++;
  }

  private insertRawPoint(symbol: string, point: RawPoint): void {
    let arr = this.rawPoints.get(symbol);
    if (!arr) {
      arr = [];
      this.rawPoints.set(symbol, arr);
    }

    // append if in-order (common fast path)
    if (!arr.length || point.timestamp >= arr[arr.length - 1].timestamp) {
      arr.push(point);
    } else {
      // keep array sorted (insertion sort). In most systems out-of-order points are rare.
      let i = arr.length - 1;
      while (i >= 0 && arr[i].timestamp > point.timestamp) i--;
      arr.splice(i + 1, 0, point);
    }

    if (arr.length > this.MAX_RAW_POINTS) arr.splice(0, arr.length - this.MAX_RAW_POINTS);
  }

  private invalidateCache(symbol: string): void {
    for (const key of Array.from(this.calcCache.keys())) {
      if (key.startsWith(symbol + '_')) this.calcCache.delete(key);
    }
  }

  private performCleanup(): void {
    const now = Date.now();
    const maxAgeMs = this.MAX_DATA_AGE_MINUTES * 60 * 1000;

    // cache TTL cleanup (use small TTL already)
    for (const [k, v] of this.calcCache.entries()) {
      if (now - v.timestamp > this.CACHE_TTL_MS) this.calcCache.delete(k);
    }

    // rawPoints cleanup
    for (const [symbol, arr] of this.rawPoints.entries()) {
      const cutoff = now - maxAgeMs;
      let i = 0;
      while (i < arr.length && arr[i].timestamp < cutoff) i++;
      if (i > 0) arr.splice(0, i);
      if (arr.length === 0) this.rawPoints.delete(symbol);
    }

    // bucket cleanup with safety buffer
    const buffer = 2 * 60 * 1000;
    this.cleanBuckets(this.buckets15sec, now, maxAgeMs, 240, buffer);
    this.cleanBuckets(this.buckets1min, now, maxAgeMs, 60, buffer);
    this.cleanBuckets(this.buckets2min, now, maxAgeMs, 30, buffer);
    this.cleanBuckets(this.buckets5min, now, maxAgeMs, 12, buffer);

    // stale symbol pruning
    const staleThreshold = now - maxAgeMs * 2;
    for (const [symbol, last] of this.lastSeen.entries()) {
      if (last < staleThreshold) {
        this.rawPoints.delete(symbol);
        this.buckets15sec.delete(symbol);
        this.buckets1min.delete(symbol);
        this.buckets2min.delete(symbol);
        this.buckets5min.delete(symbol);
        this.lastKnownPrices.delete(symbol);
        this.lastSeen.delete(symbol);
        this.updateCounts.delete(symbol);
        this.firstSeen.delete(symbol);
      }
    }
  }

  private cleanBuckets(
    bucketMap: Map<string, Map<number, TimeBucket>>,
    now: number,
    maxAge: number,
    maxBuckets: number,
    buffer: number,
  ): void {
    const threshold = now - maxAge - buffer;
    for (const [symbol, buckets] of bucketMap.entries()) {
      for (const ts of Array.from(buckets.keys())) {
        if (ts < threshold) buckets.delete(ts);
      }
      if (buckets.size > maxBuckets) {
        const sorted = Array.from(buckets.keys()).sort((a, b) => a - b);
        const toRemove = sorted.slice(0, buckets.size - maxBuckets);
        for (const ts of toRemove) buckets.delete(ts);
      }
      if (buckets.size === 0) bucketMap.delete(symbol);
    }
  }

  private logBucketStats(symbol: string): void {
    const b15 = this.buckets15sec.get(symbol)?.size || 0;
    const b1 = this.buckets1min.get(symbol)?.size || 0;
    const b2 = this.buckets2min.get(symbol)?.size || 0;
    const b5 = this.buckets5min.get(symbol)?.size || 0;
    this.logger.debug(`Buckets ${symbol}: 15s=${b15}, 1m=${b1}, 2m=${b2}, 5m=${b5}`);
  }

  private logStats(): void {
    const t = this.stats.totalCalculations;
    if (t === 0) return;
    this.logger.info(
      `Stats: Total=${t}, ` +
        `15s=${((this.stats.bucket15secHits / t) * 100).toFixed(1)}%, ` +
        `1m=${((this.stats.bucket1minHits / t) * 100).toFixed(1)}%, ` +
        `5m=${((this.stats.bucket5minHits / t) * 100).toFixed(1)}%`,
    );
    this.stats = {
      bucket15secHits: 0,
      bucket1minHits: 0,
      bucket2minHits: 0,
      bucket5minHits: 0,
      interpolationHits: 0,
      totalCalculations: 0,
    };
  }

  public getAllKnownSymbols(): string[] {
    const set = new Set<string>();
    for (const s of this.rawPoints.keys()) set.add(s);
    for (const s of this.buckets15sec.keys()) set.add(s);
    for (const s of this.buckets1min.keys()) set.add(s);
    for (const s of this.buckets2min.keys()) set.add(s);
    for (const s of this.buckets5min.keys()) set.add(s);
    for (const s of this.lastKnownPrices.keys()) set.add(s);
    return Array.from(set);
  }

  public getHistoryLength(symbol: string): number {
    return this.rawPoints.get(symbol)?.length || 0;
  }

  public getCurrentPrice(symbol: string): number {
    const arr = this.rawPoints.get(symbol);
    if (arr?.length) return arr[arr.length - 1].price;
    const cached = this.lastKnownPrices.get(symbol);
    if (cached) return cached;
    return 0;
  }

  public shutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
  }
}
