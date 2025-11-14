// src/infrastructure/services/trigger-engine.service.ts
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

const MAX_CONCURRENT_CHECKS = parseInt(process.env.MAX_CONCURRENT_CHECKS || '5', 10);
const MIN_CHECK_INTERVAL_MS = parseInt(process.env.MIN_CHECK_INTERVAL_MS || '1000', 10);

@Injectable()
export class TriggerEngineService implements ITriggerEngineService {
  private readonly logger = new Logger(TriggerEngineService.name);
  private isRunning = false;

  // Race condition prevention
  private readonly processingSymbols = new Set<string>();
  private readonly symbolLocks = new Map<string, Promise<void>>();
  
  // Batch processing
  private readonly pendingChecks = new Map<string, Set<number>>();
  private batchTimer: NodeJS.Timeout | null = null;
  
  // Rate limiting
  private lastCheckTime = new Map<string, number>();
  
  // Health monitoring
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject('ITriggerRepository') private readonly triggerRepository: ITriggerRepository,
    @Inject('IDataAggregatorService') private readonly dataAggregator: IDataAggregatorService,
    @Inject('INotificationService') private readonly notificationService: INotificationService,
    private readonly uptimeService: UptimeService,
  ) {}

  public start(): void {
    if (this.isRunning) {
      this.logger.warn('Trigger engine already running');
      return;
    }
    
    this.isRunning = true;
    this.startBatchProcessor();
    this.startHealthMonitoring();
    
    const activeTriggers = this.triggerRepository.getAllActive();
    this.logger.info(
      `Trigger engine started (event-driven mode with batching) - ` +
      `${activeTriggers.length} active triggers, ` +
      `concurrency: ${MAX_CONCURRENT_CHECKS}`
    );
  }

  public stop(): void {
    if (!this.isRunning) {
      this.logger.warn('Trigger engine not running');
      return;
    }
    
    this.isRunning = false;
    this.stopBatchProcessor();
    this.stopHealthMonitoring();
    
    // Cleanup
    this.lastCheckTime.clear();
    this.processingSymbols.clear();
    this.symbolLocks.clear();
    this.pendingChecks.clear();
    
    this.logger.info('Trigger engine stopped');
  }

  /**
   * Called by DataAggregator on EVERY price update
   * Adds checks to queue instead of processing immediately
   */
  public async onPriceUpdate(symbol: string, price: number): Promise<void> {
    if (!this.isRunning) return;

    // Rate limiting per symbol
    const lastCheck = this.lastCheckTime.get(symbol) || 0;
    const now = Date.now();

    if (now - lastCheck < MIN_CHECK_INTERVAL_MS) {
      return;
    }

    this.lastCheckTime.set(symbol, now);

    // Get active triggers and add to pending queue
    const activeTriggers = this.triggerRepository.getAllActive();
    if (activeTriggers.length === 0) return;

    if (!this.pendingChecks.has(symbol)) {
      this.pendingChecks.set(symbol, new Set());
    }

    const pending = this.pendingChecks.get(symbol)!;
    for (const trigger of activeTriggers) {
      pending.add(trigger.id);
    }
  }

  /**
   * Batch processor - runs every second
   * Processes all pending checks with controlled concurrency
   */
  private startBatchProcessor(): void {
    this.batchTimer = setInterval(() => {
      this.processPendingChecks().catch(err => {
        this.logger.error('Batch processor error:', err);
      });
    }, 1000);
  }

  private stopBatchProcessor(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private async processPendingChecks(): Promise<void> {
    if (this.pendingChecks.size === 0) return;

    const activeTriggers = this.triggerRepository.getAllActive();
    const triggerMap = new Map(activeTriggers.map(t => [t.id, t]));

    // Collect all pending tasks
    const tasks: Array<{ symbol: string; trigger: Trigger }> = [];

    for (const [symbol, triggerIds] of this.pendingChecks.entries()) {
      for (const triggerId of triggerIds) {
        const trigger = triggerMap.get(triggerId);
        if (trigger) {
          tasks.push({ symbol, trigger });
        }
      }
      triggerIds.clear();
    }

    if (tasks.length === 0) return;

    // Process in batches with controlled concurrency
    for (let i = 0; i < tasks.length; i += MAX_CONCURRENT_CHECKS) {
      const batch = tasks.slice(i, i + MAX_CONCURRENT_CHECKS);
      await Promise.all(
        batch.map(({ symbol, trigger }) => 
          this.checkTriggerSafe(trigger, symbol)
        )
      );
    }
  }

  /**
   * Safe wrapper with lock protection
   * Prevents parallel processing of same trigger-symbol pair
   */
  private async checkTriggerSafe(trigger: Trigger, symbol: string): Promise<void> {
    const lockKey = `${trigger.id}-${symbol}`;
    
    // Skip if already processing this combination
    if (this.symbolLocks.has(lockKey)) {
      return;
    }

    const promise = this.checkTrigger(trigger, symbol)
      .catch(error => {
        this.logger.error(
          `Error checking trigger ${trigger.id} for ${symbol}:`, 
          error
        );
      })
      .finally(() => {
        this.symbolLocks.delete(lockKey);
      });

    this.symbolLocks.set(lockKey, promise);
    await promise;
  }

  /**
   * Core trigger checking logic
   */
  private async checkTrigger(trigger: Trigger, symbol: string): Promise<void> {
    const metrics = this.dataAggregator.getMetricChanges(
      symbol, 
      trigger.timeIntervalMinutes
    );

    if (!metrics) {
      return; // Not enough data yet
    }

    if (this.shouldTriggerFire(trigger, metrics)) {
      this.logger.info(
        `🚨 Trigger #${trigger.id} fired: ${symbol} ` +
        `${metrics.priceChangePercent.toFixed(2)}% ` +
        `($${metrics.previousPrice.toFixed(4)} → $${metrics.currentPrice.toFixed(4)})`
      );
      
      await this.notificationService.processTrigger(trigger, symbol, metrics);
    }
  }

  /**
   * Determines if trigger conditions are met
   */
  private shouldTriggerFire(
    trigger: Trigger, 
    metrics: { priceChangePercent: number }
  ): boolean {
    const { direction, priceChangePercent: threshold } = trigger;
    const { priceChangePercent: actual } = metrics;

    if (direction === 'up') {
      return actual >= threshold;
    } else {
      return actual <= -threshold;
    }
  }

  /**
   * Health monitoring - logs system stats every 5 minutes
   */
  private startHealthMonitoring(): void {
    this.healthCheckTimer = setInterval(() => {
      const activeTriggers = this.triggerRepository.getAllActive();
      const symbols = this.dataAggregator.getAllKnownSymbols();
      const uptime = this.uptimeService.getUptime();
      const pendingCount = Array.from(this.pendingChecks.values())
        .reduce((sum, set) => sum + set.size, 0);
      
      this.logger.info(
        `🏥 Health Check: ` +
        `${activeTriggers.length} triggers, ` +
        `${symbols.length} symbols, ` +
        `${pendingCount} pending, ` +
        `${this.symbolLocks.size} active, ` +
        `uptime: ${uptime}`
      );
    }, 5 * 60 * 1000);
  }

  private stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}