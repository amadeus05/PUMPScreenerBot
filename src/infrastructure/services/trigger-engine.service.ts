import { Inject, Injectable } from '../../shared/decorators';
import {
  IDataAggregatorService,
  ITriggerEngineService,
  INotificationService,
} from '../../domain/interfaces/services.interface';
import { ITriggerRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { Logger } from '../../shared/logger';
import { UptimeService } from './uptime.service';

// Backwards-compatible TriggerEngineService with optimisations:
// - batched symbol processing (queue with debounce)
// - grouping triggers by symbol (per-symbol and global triggers)
// - per-(trigger,symbol) rate-limiting with dynamic backoff
// - metric caching with price-based invalidation tuned to trigger threshold
// - separate cooldown for notifications to avoid duplicates
// - concurrency protection for same trigger+symbol
// - debug logging behind env flag

const BATCH_PROCESSING_SIZE = Number(process.env.BATCH_PROCESSING_SIZE) || 10;
const PENDING_FLUSH_MS = Number(process.env.TRIGGER_ENGINE_FLUSH_MS) || 200; // flush pending symbols every X ms
const METRIC_CACHE_TTL_MS = Number(process.env.TRIGGER_ENGINE_METRIC_CACHE_TTL_MS) || 500; // short local cache
const DEFAULT_MIN_CHECK_INTERVAL_MS = Number(process.env.MIN_CHECK_INTERVAL_MS) || 1000; // base rate-limit

@Injectable()
export class TriggerEngineService implements ITriggerEngineService {
  private readonly logger = new Logger(TriggerEngineService.name);
  private isRunning = false;

  // pendingSymbols stores last price and timestamp to allow price-aware cache invalidation
  private pendingSymbols = new Map<string, { price: number; timestamp: number }>();

  // timing and state maps
  private lastCheckTime = new Map<string, number>(); // last attempt time for check (per trigger+symbol)
  private lastNotificationTime = new Map<string, number>(); // last notification time (per trigger+symbol)
  private runningChecks = new Set<string>(); // currently running checks keys
  private consecutiveFires = new Map<string, number>(); // consecutive fire counts

  // metric local cache: `${symbol}_${interval}` -> { ts, metrics }
  private metricCache = new Map<string, { ts: number; metrics: any }>();

  private pendingTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  // configuration knobs
  private readonly MIN_CHECK_INTERVAL_MS = DEFAULT_MIN_CHECK_INTERVAL_MS;
  private readonly DEBOUNCE_THRESHOLD = Number(process.env.TRIGGER_ENGINE_DEBOUNCE_THRESHOLD) || 3;

  constructor(
    @Inject('ITriggerRepository') private readonly triggerRepository: ITriggerRepository,
    @Inject('IDataAggregatorService') private readonly dataAggregator: IDataAggregatorService,
    @Inject('INotificationService') private readonly notificationService: INotificationService,
    private readonly uptimeService: UptimeService,
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // schedule health-checks and cleanup only after explicit start (better for DI & tests)
    this.healthTimer = setInterval(() => this.logHealth(), 5 * 60 * 1000);
    this.cleanupTimer = setInterval(() => this.cleanupFireCounters(), 10 * 60 * 1000);

    this.logger.info('TriggerEngineService started');
  }

  public stop(): void {
    this.isRunning = false;

    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.pendingSymbols.clear();
    this.lastCheckTime.clear();
    this.lastNotificationTime.clear();
    this.runningChecks.clear();
    this.consecutiveFires.clear();
    this.metricCache.clear();

    this.logger.info('TriggerEngineService stopped');
  }

  // Called by DataAggregator on each tick. We only store latest price and batch-process.
  public async onPriceUpdate(symbol: string, price: number): Promise<void> {
    if (!this.isRunning || !symbol) return;

    this.pendingSymbols.set(symbol, { price, timestamp: Date.now() });

    if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => this.flushPendingSymbols(), PENDING_FLUSH_MS);
    }
  }

  // Flush a batch of pending symbols and evaluate triggers for them
  private async flushPendingSymbols(): Promise<void> {
    if (!this.isRunning) return;

    const work = Array.from(this.pendingSymbols.entries()).slice(0, BATCH_PROCESSING_SIZE);
    for (const [symbol] of work) this.pendingSymbols.delete(symbol);

    // rearm timer if still pending
    if (this.pendingSymbols.size === 0 && this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    } else if (this.pendingSymbols.size > 0) {
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => this.flushPendingSymbols(), PENDING_FLUSH_MS);
    }

    if (work.length === 0) return;

    // load active triggers once per flush to reduce repository hits
    const activeTriggers = this.triggerRepository.getAllActive();
    if (!activeTriggers || activeTriggers.length === 0) return;

    // group and sort triggers
    const triggersBySymbol = this.groupAndSortTriggers(activeTriggers);

    // iterate symbols; processing them sequentially improves metric cache hit-rate
    for (const [symbol, { price: currentPrice }] of work) {
      try {
        // skip if aggregator considers symbol cold (optional helper)
        // @ts-ignore
        if (typeof (this.dataAggregator as any).isWarm === 'function') {
          // @ts-ignore
          if (!(this.dataAggregator as any).isWarm(symbol)) continue;
        }

        const symbolTriggers = triggersBySymbol.get(symbol) || [];
        const globalTriggers = triggersBySymbol.get('*') || [];
        const combined = [...symbolTriggers, ...globalTriggers];

        for (const trigger of combined) {
          try {
            await this.checkTriggerWithRateLimit(trigger, symbol, currentPrice);
          } catch (err) {
            this.logger.error(`checkTriggerWithRateLimit error for ${symbol} / trigger ${trigger.id}:`, err);
          }
        }
      } catch (err) {
        this.logger.error(`Error processing symbol ${symbol}:`, err);
      }
    }
  }

  // Group triggers by symbol key and sort each group by priority (higher threshold first)
  private groupAndSortTriggers(triggers: Trigger[]): Map<string, Trigger[]> {
    const result = new Map<string, Trigger[]>();

    // Trigger has no symbol field → all triggers are global
    const key = '*';
    const arr: Trigger[] = [];
    for (const t of triggers) arr.push(t);

    // sort by threshold
    arr.sort((a, b) => (b.priceChangePercent ?? 0) - (a.priceChangePercent ?? 0));
    result.set(key, arr);

    return result;
  }

  // Rate-limit wrapper: avoids frequent checks and concurrent checks for same trigger+symbol
  private async checkTriggerWithRateLimit(trigger: Trigger, symbol: string, currentPrice: number): Promise<void> {
    const checkKey = `${trigger.id}-${symbol}`;
    const now = Date.now();

    const fireCount = this.consecutiveFires.get(checkKey) || 0;
    const dynamicInterval = this.calculateCheckInterval(fireCount);

    const last = this.lastCheckTime.get(checkKey) || 0;
    if (now - last < dynamicInterval) return;

    if (this.runningChecks.has(checkKey)) return;

    this.runningChecks.add(checkKey);
    try {
      await this.checkTrigger(trigger, symbol, currentPrice);
    } finally {
      this.runningChecks.delete(checkKey);
      this.lastCheckTime.set(checkKey, Date.now());
    }
  }

  // Main check logic. Accepts latest currentPrice to allow price-aware decisions.
  private async checkTrigger(trigger: Trigger, symbol: string, currentPrice: number): Promise<void> {
    const checkKey = `${trigger.id}-${symbol}`;

    try {
      const metricKey = `${symbol}_${trigger.timeIntervalMinutes}`;
      const cached = this.metricCache.get(metricKey);
      let metrics: any = null;

      // Dynamic invalidation: if cached exists and price moved significantly vs trigger threshold
      const thresholdPercent = Math.abs(trigger.priceChangePercent || 0);
      // fallback to 1% if threshold is missing or tiny
      const effectiveThreshold = Math.max(thresholdPercent, 1);
      const invalidateLevel = Math.max(effectiveThreshold / 200, 0.005); // half of threshold (%) divided by 100

      const shouldInvalidateCache = !!cached &&
        Number.isFinite(cached.metrics?.currentPrice) &&
        Math.abs((cached.metrics.currentPrice - currentPrice) / currentPrice) > (invalidateLevel);

      if (cached && !shouldInvalidateCache && Date.now() - cached.ts < METRIC_CACHE_TTL_MS) {
        metrics = cached.metrics;
      } else {
        metrics = await this.dataAggregator.getMetricChanges(symbol, trigger.timeIntervalMinutes);
        // ensure metrics has currentPrice (prefer newest tick)
        if (!metrics) {
          this.metricCache.set(metricKey, { ts: Date.now(), metrics: null });
        } else {
          metrics.currentPrice = currentPrice;
          this.metricCache.set(metricKey, { ts: Date.now(), metrics });
        }
      }

      if (!metrics) {
        // no data => reset consecutive fires
        this.consecutiveFires.delete(checkKey);
        if (this.isDebug()) this.logger.debug(`No metrics for ${symbol}@${trigger.timeIntervalMinutes}m`);
        return;
      }

      if (this.isDebug()) {
        const pct = Number.isFinite(metrics.priceChangePercent) ? metrics.priceChangePercent.toFixed(2) : 'NaN';
        this.logger.debug(`Eval trigger=${trigger.id} symbol=${symbol} interval=${trigger.timeIntervalMinutes}m actual=${pct}% currentPrice=${metrics.currentPrice}`);
      }

      if (this.shouldTriggerFire(trigger, metrics)) {
        const prev = this.consecutiveFires.get(checkKey) || 0;
        const nowCount = prev + 1;
        this.consecutiveFires.set(checkKey, nowCount);

        this.logger.info(`Trigger ${trigger.id} fired for ${symbol} (count=${nowCount})`);

        // notification cooldown: don't notify more often than notificationLimitSeconds
        const notifKey = `${trigger.id}_${symbol}`;
        const lastNotified = this.lastNotificationTime.get(notifKey) || 0;
        const cooldownMs = (trigger.notificationLimitSeconds || 0) * 1000;
        const now = Date.now();

        if (cooldownMs > 0 && now - lastNotified < cooldownMs) {
          if (this.isDebug()) this.logger.debug(`Cooldown active for ${notifKey}, skipping send`);
        } else {
          this.lastNotificationTime.set(notifKey, Date.now());
          try {
            await this.notificationService.processTrigger(trigger, symbol, metrics);
          } catch (err) {
            this.logger.error(`notificationService failed for trigger=${trigger.id} symbol=${symbol}:`, err);
          }
        }
      } else {
        // reset consecutive count
        this.consecutiveFires.delete(checkKey);
      }
    } catch (err) {
      this.logger.error(`Error checking trigger ${trigger.id} for ${symbol}:`, err);
      this.consecutiveFires.delete(checkKey);
    }
  }

  // Safer comparison with NaN handling. For "down" triggers, threshold is treated as positive percent.
  private shouldTriggerFire(trigger: Trigger, metrics: { priceChangePercent: number }): boolean {
    const actual = metrics?.priceChangePercent;
    if (!Number.isFinite(actual)) return false;

    const threshold = Number(trigger.priceChangePercent) || 0;
    if (trigger.direction === 'up') return actual >= threshold;

    // down: actual is usually negative, threshold is positive
    return actual <= -Math.abs(threshold);
  }

  // dynamic check interval/backoff based on consecutive fires
  private calculateCheckInterval(consecutiveFireCount: number): number {
    if (consecutiveFireCount < this.DEBOUNCE_THRESHOLD) return this.MIN_CHECK_INTERVAL_MS;
    const power = Math.min(consecutiveFireCount - this.DEBOUNCE_THRESHOLD + 1, 8);
    return this.MIN_CHECK_INTERVAL_MS * Math.pow(2, power - 1);
  }

  private logHealth(): void {
    try {
      const activeTriggers = this.triggerRepository.getAllActive();
      // @ts-ignore
      const symbols = typeof (this.dataAggregator as any).getAllKnownSymbols === 'function'
        ? (this.dataAggregator as any).getAllKnownSymbols()
        : [];

      const uptime = this.uptimeService.getUptime?.() || 0;
      if (this.isDebug()) {
        this.logger.debug(`Health: triggers=${activeTriggers?.length || 0} symbols=${symbols?.length || 0} uptime=${uptime}`);
      } else {
        this.logger.info(`Health: triggers=${activeTriggers?.length || 0} symbols=${symbols?.length || 0}`);
      }
    } catch (err) {
      this.logger.debug('Health check failed', err);
    }
  }

  private cleanupFireCounters(): void {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000; // 30 minutes

    for (const [k, ts] of Array.from(this.lastCheckTime.entries())) {
      if (now - ts > staleThreshold) {
        this.lastCheckTime.delete(k);
        this.consecutiveFires.delete(k);
      }
    }

    // also cleanup notification times a bit older
    for (const [k, ts] of Array.from(this.lastNotificationTime.entries())) {
      if (now - ts > 24 * 60 * 60 * 1000) this.lastNotificationTime.delete(k);
    }

    if (this.isDebug()) this.logger.debug(`Cleanup done: checks=${this.lastCheckTime.size} fires=${this.consecutiveFires.size}`);
  }

  private isDebug(): boolean {
    return Boolean(process.env.DEBUG_TRIGGER_ENGINE);
  }
}
