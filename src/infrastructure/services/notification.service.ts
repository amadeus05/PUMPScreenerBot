import { Inject, Injectable } from '../../shared/decorators';
import { INotificationService, IMetricChanges } from '../../domain/interfaces/services.interface';
import { ISignalRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { SignalDto } from '../../application/dto/signal.dto';
import { SignalHandler } from '../../presentation/telegram/handlers/signal.handler';
import { Logger } from '../../shared/logger';

type QueuedNotification = {
  key: string;
  trigger: Trigger;
  symbol: string;
  metrics: IMetricChanges;
  readyAt: number;
  enqueuedAt: number;
};

@Injectable()
export class NotificationService implements INotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly signalHandler: SignalHandler;
  private readonly signalRepository: ISignalRepository;
  private readonly MAX_QUEUE_LENGTH = 50;
  private readonly QUEUE_TICK_MS = 100;
  private readonly MAX_MESSAGES_PER_SECOND = 3;
  private readonly COOLDOWN_MINUTES = 5;
  private readonly RETRY_DELAY_MS = 1000;

  private notificationCooldowns = new Map<string, number>();
  private pendingNotifications: QueuedNotification[] = [];
  private pendingByKey = new Map<string, QueuedNotification>();
  private tokensAvailable = this.MAX_MESSAGES_PER_SECOND;
  private isProcessingQueue = false;

  // ✅ FIX: Store timer references  for cleanup
  private queueProcessTimer: NodeJS.Timeout | null = null;
  private tokenRefillTimer: NodeJS.Timeout | null = null;
  private cooldownCleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject('SignalHandler')
    signalHandler: SignalHandler,
    @Inject('ISignalRepository')
    signalRepository: ISignalRepository,
  ) {
    this.signalHandler = signalHandler;
    this.signalRepository = signalRepository;

    // ✅ FIX: Store timer references instead of anonymous setInterval
    this.queueProcessTimer = setInterval(() => this.processQueue(), this.QUEUE_TICK_MS);
    this.tokenRefillTimer = setInterval(() => {
      this.tokensAvailable = this.MAX_MESSAGES_PER_SECOND;
      this.processQueue();
    }, 1000);

    this.cooldownCleanupTimer = setInterval(() => this.cleanupCooldowns(), 10 * 60 * 1000);
  }

  // ✅ FIX: Add cleanup method
  public stop(): void {
    if (this.queueProcessTimer) clearInterval(this.queueProcessTimer);
    if (this.tokenRefillTimer) clearInterval(this.tokenRefillTimer);
    if (this.cooldownCleanupTimer) clearInterval(this.cooldownCleanupTimer);
    this.queueProcessTimer = null;
    this.tokenRefillTimer = null;
    this.cooldownCleanupTimer = null;
  }

  public async processTrigger(
    trigger: Trigger,
    symbol: string,
    metrics: IMetricChanges,
  ): Promise<void> {
    const key = this.getCooldownKey(trigger.userId, symbol);
    const cooldown = this.calculateCooldown(trigger.notificationLimitSeconds);
    const lastNotification = this.notificationCooldowns.get(key) ?? 0;
    const readyAt = Math.max(lastNotification + cooldown, Date.now());

    this.enqueueOrUpdatePending(key, trigger, symbol, metrics, readyAt);
    this.processQueue();
  }

  private enqueueOrUpdatePending(
    key: string,
    trigger: Trigger,
    symbol: string,
    metrics: IMetricChanges,
    readyAt: number,
  ): void {
    const existing = this.pendingByKey.get(key);
    const now = Date.now();

    if (existing) {
      existing.trigger = trigger;
      existing.metrics = metrics;
      existing.readyAt = readyAt;
      existing.enqueuedAt = now;
      this.logger.debug(
        `🔄 Updated pending signal for ${symbol} (user ${trigger.userId}, ready in ${Math.max(0, readyAt - now)}ms)`,
      );
      return;
    }

    const pending: QueuedNotification = {
      key,
      trigger,
      symbol,
      metrics,
      readyAt,
      enqueuedAt: now,
    };

    this.pendingByKey.set(key, pending);
    this.pendingNotifications.push(pending);

    this.logger.debug(
      `🗳️ Queued signal for ${symbol} (user ${trigger.userId}, ready in ${Math.max(0, readyAt - now)}ms)`,
    );
  }

  private processQueue(): void {
    if (this.isProcessingQueue) return;

    this.isProcessingQueue = true;
    void this.flushQueue().finally(() => {
      this.isProcessingQueue = false;
    });
  }

  private async flushQueue(): Promise<void> {
    if (this.pendingNotifications.length === 0 || this.tokensAvailable <= 0) return;

    this.pendingNotifications.sort((a, b) => a.readyAt - b.readyAt);

    let dispatched = 0;

    while (this.tokensAvailable > 0 && this.pendingNotifications.length > 0) {
      const next = this.pendingNotifications[0];
      if (next.readyAt > Date.now()) break;

      this.pendingNotifications.shift();
      this.pendingByKey.delete(next.key);

      const result = await this.dispatchNotification(next);
      if (!result) {
        this.scheduleRetry(next);
        continue;
      }

      dispatched++;
    }

    if (dispatched > 0) {
      this.logger.debug(`📬 Dispatched ${dispatched} notifications. Tokens left: ${this.tokensAvailable}`);
    }
  }

  private scheduleRetry(pending: QueuedNotification): void {
    pending.readyAt = Date.now() + this.RETRY_DELAY_MS;
    this.pendingByKey.set(pending.key, pending);
    this.pendingNotifications.push(pending);
    this.logger.warn(`⏳ Rescheduled signal for ${pending.symbol} due to delivery failure`);
  }

  private async dispatchNotification(pending: QueuedNotification): Promise<boolean> {
    if (this.tokensAvailable <= 0) return false;

    this.tokensAvailable -= 1;

    const { trigger, symbol, metrics } = pending;
    const now = Date.now();

    try {
      this.notificationCooldowns.set(pending.key, now);

      this.logger.info(
        `Trigger #${trigger.id} dispatched for ${symbol}. Price change: ${metrics.priceChangePercent.toFixed(2)}% ` +
        `(tokens left: ${this.tokensAvailable})`,
      );

      const signalDto = new SignalDto(
        0,
        symbol,
        metrics.priceChangePercent,
        metrics.currentPrice,
        metrics.previousPrice,
        new Date(),
        trigger.timeIntervalMinutes,
      );

      await this.signalHandler.handleSignal(
        signalDto,
        trigger.id,
        trigger.userId,
        trigger.timeIntervalMinutes,
      );

      return true;
    } catch (error) {
      this.tokensAvailable = Math.min(this.tokensAvailable + 1, this.MAX_MESSAGES_PER_SECOND);
      this.logger.error(
        `❌ Failed to dispatch signal for ${symbol}`,
        error instanceof Error ? { message: error.message, stack: error.stack } : error,
      );
      return false;
    }
  }

  private calculateCooldown(baseCooldownSeconds: number): number {
    return baseCooldownSeconds * 1000;
  }

  private getCooldownKey(userId: number, symbol: string): string {
    return `${userId}-${symbol}`;
  }

  private cleanupCooldowns(): void {
    const now = Date.now();
    const staleThreshold = 60 * 60 * 1000;

    let cleaned = 0;
    for (const [key, lastNotification] of this.notificationCooldowns.entries()) {
      if (now - lastNotification > staleThreshold) {
        this.notificationCooldowns.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(
        `🧹 Cleaned ${cleaned} stale cooldowns. Active: ${this.notificationCooldowns.size}`,
      );
    }
  }
}