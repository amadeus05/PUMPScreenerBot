// STABLE DATA AGGREGATOR — PRODUCTION-READY (NO EMA) + FULL DEBUG + FALLBACK
// - Lightweight production-ready aggregator for 1–30 minute intervals
// - Uses 15s + 1m buckets only, robust warmup, MIN_SAMPLES default 1 (configurable)
// - Exposes updatePrice, getMetricChanges, getAllKnownSymbols, getHistoryLength, getCurrentPrice, setTriggerEngine, visualizeBuckets
// - NOTE: openInterest removed (not used)

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

@Injectable()
export class DataAggregatorService implements IDataAggregatorService {
  private readonly logger = new Logger("StableAggregatorProd");

  private buckets15s: Map<string, Map<number, Bucket>> = new Map();
  private buckets1m: Map<string, Map<number, Bucket>> = new Map();

  private lastKnownPrices: Map<string, number> = new Map();
  private firstSeen: Map<string, number> = new Map();

  private triggerEngine?: ITriggerEngineService | null = null;

  // Tunables (env override)
  private readonly MAX_MINUTE_BUCKETS = Number(process.env.MAX_MINUTE_BUCKETS) || 70;
  private readonly MAX_15S_BUCKETS = Number(process.env.MAX_15S_BUCKETS) || 300;
  private readonly MIN_BUCKET_SAMPLES = Number(process.env.MIN_BUCKET_SAMPLES) || 1; // tolerant default
  private readonly WARMUP_FACTOR = Number(process.env.WARMUP_FACTOR) || 0.2; // faster warmup by default
  private readonly DEBUG = Boolean(Number(process.env.DEBUG)) || Boolean(process.env.DEBUG === 'true');

  // ---------------- Interface (backward-compatible) ----------------

  public updatePrice(symbol: string, price: number, timestamp: number): void {
    if (!symbol || !Number.isFinite(price) || !Number.isFinite(timestamp)) return;

    // record last price
    this.lastKnownPrices.set(symbol, price);

    // set firstSeen if new
    if (!this.firstSeen.has(symbol)) this.firstSeen.set(symbol, Date.now());

    // use local time for bucket alignment
    const tsLocal = Date.now();

    // Add raw point (openInterest intentionally omitted)
    this.addRawPoint(symbol, { timestamp: tsLocal, price });

    // notify trigger engine non-blocking
    if (this.triggerEngine && typeof this.triggerEngine.onPriceUpdate === 'function') {
      try {
        void this.triggerEngine.onPriceUpdate(symbol, price);
      } catch (err) {
        this.logger.error(`Trigger engine onPriceUpdate error: ${String(err)}`);
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
    return this.buckets1m.get(symbol)?.size ?? this.buckets15s.get(symbol)?.size ?? 0;
  }

  public getCurrentPrice(symbol: string): number {
    return this.lastKnownPrices.get(symbol) ?? 0;
  }

  public setTriggerEngine(engine: ITriggerEngineService): void {
    this.triggerEngine = engine;
  }

  // ---------------- Ingestion ----------------

  private addRawPoint(symbol: string, point: { timestamp: number; price: number }): void {
    const ts = point.timestamp;
    const price = point.price;

    if (!this.firstSeen.has(symbol)) this.firstSeen.set(symbol, ts);

    this.updateBucket(symbol, ts, price, 15_000, this.buckets15s);
    this.updateBucket(symbol, ts, price, 60_000, this.buckets1m);
  }

  // ---------------- Buckets ----------------

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

    b.close = price;
    b.high = Math.max(b.high, price);
    b.low = Math.min(b.low, price);
    b.count++;
    b.lastTs = ts;

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

  // ---------------- Calculation ----------------

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

    // Warmup check
    const first = this.firstSeen.get(symbol) ?? 0;
    const required = Math.ceil(this.WARMUP_FACTOR * durationMs);
    if (Date.now() - first < required) {
      if (this.DEBUG) this.logger.debug(`Warmup: ${symbol} needs ${required}ms history`);
      return null;
    }

    const endBucket = Math.floor(now / bucketSize) * bucketSize;
    const startBucket = Math.floor((now - durationMs) / bucketSize) * bucketSize;

    const start = map.get(startBucket);
    const end = map.get(endBucket);

    if (this.DEBUG) this.logger.debug(`Calc ${symbol} ${minutes}m | bucket=${bucketSize/1000}s start=${startBucket}(${!!start}) end=${endBucket}(${!!end})`);

    if (!start || !end) {
      if (this.DEBUG) this.logger.debug(`Missing start or end for ${symbol}. Trying fallback`);
      const fallback = this.interpolateFromBuckets(map, startBucket, endBucket, bucketSize);
      if (fallback) return fallback;
      return null;
    }

    if (start.count < this.MIN_BUCKET_SAMPLES || end.count < this.MIN_BUCKET_SAMPLES) {
      if (this.DEBUG) this.logger.debug(`Insufficient samples for ${symbol}: start=${start.count} end=${end.count}`);
      const fallback = this.interpolateFromBuckets(map, startBucket, endBucket, bucketSize);
      if (fallback) return fallback;
      return null;
    }

    if (start.open <= 0 || end.close <= 0) {
      if (this.DEBUG) this.logger.debug(`Invalid bucket prices for ${symbol}`);
      return null;
    }

    const priceChangePercent = ((end.close - start.open) / start.open) * 100;
    const currentPrice = end.close;
    const previousPrice = start.open;
    const timeWindowSeconds = minutes * 60;

    if (this.DEBUG) this.logger.info(`Metric ${symbol} ${minutes}m: ${priceChangePercent.toFixed(2)}% (${previousPrice}→${currentPrice})`);

    return {
      priceChangePercent,
      currentPrice,
      previousPrice,
      timeWindowSeconds,
    };
  }

  // ---------------- Fallback interpolation ----------------

  private interpolateFromBuckets(
    map: Map<number, Bucket>,
    startBucket: number,
    endBucket: number,
    bucketSize: number,
  ): IMetricChanges | null {
    const keys = [...map.keys()].sort((a, b) => a - b);
    if (keys.length === 0) return null;

    const startKey = keys.find(k => k >= startBucket) ?? keys[0];
    const endKeys = keys.filter(k => k <= endBucket);
    const endKey = endKeys.length ? endKeys[endKeys.length - 1] : keys[keys.length - 1];

    const s = map.get(startKey)!;
    const e = map.get(endKey)!;
    if (!s || !e) return null;
    if (s.count < 1 || e.count < 1) return null;
    if (s.open <= 0 || e.close <= 0) return null;

    const pct = ((e.close - s.open) / s.open) * 100;
    const timeWindowSeconds = Math.round((e.lastTs - s.firstTs) / 1000) || Math.round((endBucket - startBucket) / 1000);

    if (this.DEBUG) this.logger.debug(`Interpolated ${pct.toFixed(2)}% using ${new Date(startKey).toISOString()} -> ${new Date(endKey).toISOString()}`);

    return {
      priceChangePercent: pct,
      currentPrice: e.close,
      previousPrice: s.open,
      timeWindowSeconds,
    };
  }

  // ---------------- Visualization ----------------

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
}
