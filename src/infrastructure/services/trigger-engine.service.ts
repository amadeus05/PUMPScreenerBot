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

const TICK_INTERVAL_MS = 15 * 1000;
const BATCH_PROCESSING_SIZE = 10;

@Injectable()
export class TriggerEngineService implements ITriggerEngineService {
  private readonly logger = new Logger(TriggerEngineService.name);
  private isRunning = false;

  private lastCheckTime = new Map<string, number>();
  private readonly MIN_CHECK_INTERVAL_MS = 1000; // Max 1 check per second per symbol

  constructor(
    @Inject('ITriggerRepository') private readonly triggerRepository: ITriggerRepository,
    @Inject('IDataAggregatorService') private readonly dataAggregator: IDataAggregatorService,
    @Inject('INotificationService') private readonly notificationService: INotificationService,
    private readonly uptimeService: UptimeService,
  ) {
    // Periodic health check every 5 minutes
    setInterval(
      () => {
        const activeTriggers = this.triggerRepository.getAllActive();
        const symbols = this.dataAggregator.getAllKnownSymbols();
        const uptime = this.uptimeService.getUptime();
        this.logger.debug(
          `🏥 System health: ${activeTriggers.length} triggers, ${symbols.length} symbols, uptime: ${uptime}`,
        );
      },
      5 * 60 * 1000,
    );
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('Trigger engine started (event-driven mode)');
  }

  public stop(): void {
    this.isRunning = false;
    this.lastCheckTime.clear();
    this.logger.info('Trigger engine stopped');
  }

  // NEW: Called by DataAggregator on EVERY price update
  public async onPriceUpdate(symbol: string, price: number): Promise<void> {
    if (!this.isRunning) return;

    // Rate limit checks per symbol
    const lastCheck = this.lastCheckTime.get(symbol) || 0;
    const now = Date.now();

    if (now - lastCheck < this.MIN_CHECK_INTERVAL_MS) {
      return;
    }

    this.lastCheckTime.set(symbol, now);

    const activeTriggers = this.triggerRepository.getAllActive();
    if (activeTriggers.length === 0) return;

    // ADD: Debug log for trigger processing
    this.logger.debug(
      `🔍 Checking ${activeTriggers.length} triggers for ${symbol} @ $${price.toFixed(4)}`,
    );

    for (const trigger of activeTriggers) {
      await this.checkTrigger(trigger, symbol);
    }
  }

  private async checkTrigger(trigger: Trigger, symbol: string): Promise<void> {
    try {
      const metrics = this.dataAggregator.getMetricChanges(symbol, trigger.timeIntervalMinutes);

      if (!metrics) {
        // ADD: More informative message
        this.logger.debug(
          `⏳ ${symbol} (${trigger.timeIntervalMinutes}m): Collecting data... (${this.dataAggregator.getHistoryLength(symbol)} points)`,
        );
        return;
      }

      // ADD: Log calculation results
      this.logger.debug(
        `📊 ${symbol} ${trigger.timeIntervalMinutes}m: ${metrics.priceChangePercent.toFixed(2)}% ($${metrics.previousPrice.toFixed(4)} → $${metrics.currentPrice.toFixed(4)})`,
      );

      if (this.shouldTriggerFire(trigger, metrics)) {
        this.logger.debug(`🚨 Trigger ${trigger.id} fired for ${symbol}!`);
        await this.notificationService.processTrigger(trigger, symbol, metrics);
      }
    } catch (error) {
      this.logger.error(`Error checking trigger ${trigger.id} for ${symbol}:`, error);
    }
  }

  private shouldTriggerFire(trigger: Trigger, metrics: { priceChangePercent: number }): boolean {
    const { direction, priceChangePercent: threshold } = trigger;
    const { priceChangePercent: actual } = metrics;

    if (direction === 'up') {
      return actual >= threshold;
    } else {
      return actual <= -threshold;
    }
  }
}
