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

const BATCH_PROCESSING_SIZE = Number(process.env.BATCH_PROCESSING_SIZE) || 10;
const PENDING_FLUSH_MS = Number(process.env.TRIGGER_ENGINE_FLUSH_MS) || 200;
const METRIC_CACHE_TTL_MS = Number(process.env.TRIGGER_ENGINE_METRIC_CACHE_TTL_MS) || 500;
const DEFAULT_MIN_CHECK_INTERVAL_MS = Number(process.env.MIN_CHECK_INTERVAL_MS) || 1000;

// 🔥 КОНСТАНТА ОТКАТА (0.5%)
// Сигнал сработает, если цена откатит на 0.5% от пика после пробития триггера
const REVERSION_DROP_THRESHOLD = 0.005; 

@Injectable()
export class TriggerEngineService implements ITriggerEngineService {
  private readonly logger = new Logger(TriggerEngineService.name);
  private isRunning = false;

  // Очередь обновлений цен
  private pendingSymbols = new Map<string, { price: number; timestamp: number }>();

  // Карты состояний и таймингов
  private lastCheckTime = new Map<string, number>();
  private lastNotificationTime = new Map<string, number>();
  private runningChecks = new Set<string>();
  private consecutiveFires = new Map<string, number>();

  // 🔥 STATE MACHINE: Хранилище для отслеживания пиков (Mean Reversion)
  // Key: `${trigger.id}-${symbol}` -> Value: { peakPrice: number, armedAt: number }
  private pendingReversions = new Map<string, { peakPrice: number; armedAt: number }>();

  // Кэш метрик агрегатора
  private metricCache = new Map<string, { ts: number; metrics: any }>();

  private pendingTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

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

    this.healthTimer = setInterval(() => this.logHealth(), 5 * 60 * 1000);
    this.cleanupTimer = setInterval(() => this.cleanupFireCounters(), 10 * 60 * 1000);

    this.logger.info('TriggerEngineService started (with Mean Reversion Logic)');
  }

  public stop(): void {
    this.isRunning = false;

    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }

    this.pendingSymbols.clear();
    this.lastCheckTime.clear();
    this.lastNotificationTime.clear();
    this.runningChecks.clear();
    this.consecutiveFires.clear();
    this.metricCache.clear();
    this.pendingReversions.clear(); // Очистка состояний реверсии

    this.logger.info('TriggerEngineService stopped');
  }

  public async onPriceUpdate(symbol: string, price: number): Promise<void> {
    if (!this.isRunning || !symbol) return;

    this.pendingSymbols.set(symbol, { price, timestamp: Date.now() });

    if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => this.flushPendingSymbols(), PENDING_FLUSH_MS);
    }
  }

  private async flushPendingSymbols(): Promise<void> {
    if (!this.isRunning) return;

    const work = Array.from(this.pendingSymbols.entries()).slice(0, BATCH_PROCESSING_SIZE);
    for (const [symbol] of work) this.pendingSymbols.delete(symbol);

    if (this.pendingSymbols.size === 0 && this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    } else if (this.pendingSymbols.size > 0) {
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => this.flushPendingSymbols(), PENDING_FLUSH_MS);
    }

    if (work.length === 0) return;

    const activeTriggers = this.triggerRepository.getAllActive();
    if (!activeTriggers || activeTriggers.length === 0) return;

    const triggersBySymbol = this.groupAndSortTriggers(activeTriggers);

    for (const [symbol, { price: currentPrice }] of work) {
      try {
        // Проверка "прогрева" агрегатора (опционально)
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
            this.logger.error(`checkTrigger error for ${symbol}:`, err);
          }
        }
      } catch (err) {
        this.logger.error(`Error processing symbol ${symbol}:`, err);
      }
    }
  }

  private groupAndSortTriggers(triggers: Trigger[]): Map<string, Trigger[]> {
    const result = new Map<string, Trigger[]>();
    const key = '*'; 
    const arr: Trigger[] = [];
    for (const t of triggers) arr.push(t);
    // Сортировка по величине изменения (сначала самые большие движения)
    arr.sort((a, b) => (b.priceChangePercent ?? 0) - (a.priceChangePercent ?? 0));
    result.set(key, arr);
    return result;
  }

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

  // =================================================================
  // 🔥 ГЛАВНАЯ ЛОГИКА ПРОВЕРКИ ТРИГГЕРА + MEAN REVERSION
  // =================================================================
  private async checkTrigger(trigger: Trigger, symbol: string, currentPrice: number): Promise<void> {
    const checkKey = `${trigger.id}-${symbol}`;

    try {
      // 1. Получение метрик (с кэшированием)
      const metricKey = `${symbol}_${trigger.timeIntervalMinutes}`;
      const cached = this.metricCache.get(metricKey);
      let metrics: any = null;

      const thresholdPercent = Math.abs(trigger.priceChangePercent || 0);
      const effectiveThreshold = Math.max(thresholdPercent, 1);
      const invalidateLevel = Math.max(effectiveThreshold / 200, 0.005);

      const shouldInvalidateCache = !!cached &&
        Number.isFinite(cached.metrics?.currentPrice) &&
        Math.abs((cached.metrics.currentPrice - currentPrice) / currentPrice) > (invalidateLevel);

      if (cached && !shouldInvalidateCache && Date.now() - cached.ts < METRIC_CACHE_TTL_MS) {
        metrics = cached.metrics;
      } else {
        metrics = await this.dataAggregator.getMetricChanges(symbol, trigger.timeIntervalMinutes);
        if (!metrics) {
          this.metricCache.set(metricKey, { ts: Date.now(), metrics: null });
        } else {
          metrics.currentPrice = currentPrice; // Force latest price
          this.metricCache.set(metricKey, { ts: Date.now(), metrics });
        }
      }

      if (!metrics) {
        // Данных нет — сбрасываем всё
        this.consecutiveFires.delete(checkKey);
        this.pendingReversions.delete(checkKey);
        return;
      }

      // 2. Проверяем, пробит ли основной порог (например, > 8%)
      const isThresholdMet = this.shouldTriggerFire(trigger, metrics);

      // ===========================================
      // 🕵️‍♂️ LOGIC: MEAN REVERSION (PULLBACK)
      // ===========================================
      
      // Логика запускается если порог пробит ИЛИ мы уже "на мушке"
      if (isThresholdMet || this.pendingReversions.has(checkKey)) {
        
        let reversionState = this.pendingReversions.get(checkKey);

        // A. Сценарий СБРОСА: Цена упала ниже порога срабатывания, так и не дав откат
        // Пример: Было +8.1%, стало +7.5% (порог 8%). Мы больше не ждем пика.
        if (!isThresholdMet && reversionState) {
            const threshold = Number(trigger.priceChangePercent) || 0;
            
            // Проверка для UP триггера
            if (trigger.direction === 'up' && metrics.priceChangePercent < threshold) {
                 if (this.isDebug()) this.logger.debug(`Reset reversion for ${symbol}: price dropped below threshold`);
                 this.pendingReversions.delete(checkKey);
                 return; // Выход без сигнала
            }
             // Проверка для DOWN триггера
            if (trigger.direction === 'down' && metrics.priceChangePercent > -Math.abs(threshold)) {
                 this.pendingReversions.delete(checkKey);
                 return; // Выход без сигнала
            }
        }

        // B. Сценарий ВЗВОДА (ARMING): Первый раз пробили порог
        if (!reversionState && isThresholdMet) {
            this.pendingReversions.set(checkKey, { 
                peakPrice: currentPrice, 
                armedAt: Date.now() 
            });
            if (this.isDebug()) this.logger.debug(`🔫 ARMED Reversion for ${symbol} at ${currentPrice}`);
            return; // 🛑 СТОП! Ждем следующего тика для подтверждения пика.
        }

        // C. Сценарий ТРЕКИНГА: Мы уже следим, обновляем пик или проверяем откат
        if (reversionState) {
            // C1. Обновляем пик, если цена идет дальше в сторону тренда
            if (trigger.direction === 'up') {
                if (currentPrice > reversionState.peakPrice) {
                    reversionState.peakPrice = currentPrice;
                    this.pendingReversions.set(checkKey, reversionState);
                    return; // Цена растет, ждем дальше
                }
            } else { // down
                if (currentPrice < reversionState.peakPrice) {
                    reversionState.peakPrice = currentPrice;
                    this.pendingReversions.set(checkKey, reversionState);
                    return; // Цена падает, ждем дальше
                }
            }

            // C2. Проверяем ОТКАТ (Pullback)
            let pullbackPercent = 0;
            if (trigger.direction === 'up') {
                // Насколько упали от хая?
                pullbackPercent = (reversionState.peakPrice - currentPrice) / reversionState.peakPrice;
            } else {
                // Насколько отскочили от дна?
                pullbackPercent = (currentPrice - reversionState.peakPrice) / reversionState.peakPrice;
            }

            if (pullbackPercent >= REVERSION_DROP_THRESHOLD) {
                // ✅ УРА! Откат подтвержден (0.5%)
                this.logger.info(
                    `📉 Reversion CONFIRMED for ${symbol}: Peak ${reversionState.peakPrice} -> Cur ${currentPrice} ` +
                    `(-${(pullbackPercent*100).toFixed(2)}%)`
                );
                
                // Удаляем из слежки — пропускаем код дальше к отправке
                this.pendingReversions.delete(checkKey);
            } else {
                return; // 🛑 Рано, откат слишком маленький (например, всего 0.1%)
            }
        }
      } else {
          // Если порог не пробит и мы не следим — делать нечего
          this.consecutiveFires.delete(checkKey);
          return;
      }
      
      // ===========================================
      // 🚀 SENDING SIGNAL
      // ===========================================
      // Если код дошел сюда, значит Reversion Confirmed и пора слать сигнал

      const prev = this.consecutiveFires.get(checkKey) || 0;
      const nowCount = prev + 1;
      this.consecutiveFires.set(checkKey, nowCount);

      this.logger.info(`Trigger ${trigger.id} fired for ${symbol} (count=${nowCount})`);

      const notifKey = `${trigger.id}_${symbol}`;
      const lastNotified = this.lastNotificationTime.get(notifKey) || 0;
      const cooldownMs = (trigger.notificationLimitSeconds || 0) * 1000;

      if (cooldownMs > 0 && Date.now() - lastNotified < cooldownMs) {
        if (this.isDebug()) this.logger.debug(`Cooldown active for ${notifKey}, skipping send`);
      } else {
        this.lastNotificationTime.set(notifKey, Date.now());
        try {
          await this.notificationService.processTrigger(trigger, symbol, metrics);
        } catch (err) {
          this.logger.error(`notificationService failed for trigger=${trigger.id} symbol=${symbol}:`, err);
        }
      }

    } catch (err) {
      this.logger.error(`Error checking trigger ${trigger.id} for ${symbol}:`, err);
      // Safety Cleanup
      this.consecutiveFires.delete(checkKey);
      this.pendingReversions.delete(checkKey);
    }
  }

  // Сравнение значений с учетом направления
  private shouldTriggerFire(trigger: Trigger, metrics: { priceChangePercent: number }): boolean {
    const actual = metrics?.priceChangePercent;
    if (!Number.isFinite(actual)) return false;

    const threshold = Number(trigger.priceChangePercent) || 0;
    if (trigger.direction === 'up') return actual >= threshold;

    // для down сравниваем отрицательные числа (-10 < -8)
    return actual <= -Math.abs(threshold);
  }

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
      this.logger.info(`Health: triggers=${activeTriggers?.length || 0} symbols=${symbols?.length || 0} armedReversions=${this.pendingReversions.size}`);
    } catch (err) {
      this.logger.debug('Health check failed', err);
    }
  }

  private cleanupFireCounters(): void {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000;

    for (const [k, ts] of Array.from(this.lastCheckTime.entries())) {
      if (now - ts > staleThreshold) {
        this.lastCheckTime.delete(k);
        this.consecutiveFires.delete(k);
        this.pendingReversions.delete(k); // Чистим зависшие реверсии
      }
    }

    for (const [k, ts] of Array.from(this.lastNotificationTime.entries())) {
      if (now - ts > 24 * 60 * 60 * 1000) this.lastNotificationTime.delete(k);
    }
  }

  private isDebug(): boolean {
    return Boolean(process.env.DEBUG_TRIGGER_ENGINE);
  }
}