import { Inject, Injectable } from '../../shared/decorators';
import { INotificationService, IMetricChanges } from '../../domain/interfaces/services.interface';
import { ISignalRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { SignalDto } from '../../application/dto/signal.dto';
import { SignalHandler } from '../../presentation/telegram/handlers/signal.handler';
import { Logger } from '../../shared/logger';

@Injectable()
export class NotificationService implements INotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly notificationCooldowns = new Map<string, number>();

  // ✅ NEW: Track consecutive fires for exponential backoff
  private readonly consecutiveFires = new Map<string, number>();
  private readonly MAX_BACKOFF_MULTIPLIER = 8; // Max 8x cooldown

  constructor(
    private readonly signalHandler: SignalHandler,
    @Inject('ISignalRepository')
    private readonly signalRepository: ISignalRepository,
  ) {
    // ✅ NEW: Cleanup old cooldowns every 10 minutes
    setInterval(() => this.cleanupCooldowns(), 10 * 60 * 1000);
  }

  public async processTrigger(
    trigger: Trigger,
    symbol: string,
    metrics: IMetricChanges,
  ): Promise<void> {
    const cooldownKey = `${trigger.userId}-${symbol}`;
    const lastNotification = this.notificationCooldowns.get(cooldownKey);
    const now = Date.now();

    // ✅ FIX: Dynamic cooldown with exponential backoff
    const consecutiveCount = this.consecutiveFires.get(cooldownKey) || 0;
    const dynamicCooldown = this.calculateCooldown(trigger.notificationLimitSeconds, consecutiveCount);

    if (lastNotification && now - lastNotification < dynamicCooldown) {
      const remaining = Math.ceil((dynamicCooldown - (now - lastNotification)) / 1000);
      this.logger.debug(
        `⏰ Cooldown active for ${symbol} (${remaining}s remaining, fires: ${consecutiveCount})`,
      );
      return;
    }

    // ✅ FIX: Increment consecutive fire counter
    this.consecutiveFires.set(cooldownKey, consecutiveCount + 1);

    this.logger.info(
      `Trigger #${trigger.id} fired for ${symbol}. Price change: ${metrics.priceChangePercent.toFixed(2)}% ` +
      `(consecutive: ${consecutiveCount + 1}, cooldown: ${dynamicCooldown / 1000}s)`,
    );

    this.notificationCooldowns.set(cooldownKey, now);

    this.logger.debug(
      `📤 Sending signal to user ${trigger.userId}: ${symbol} ${metrics.priceChangePercent.toFixed(2)}%`,
    );

    // ✅ REMOVED: Quality indicator removed
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
  }

  // ✅ NEW: Calculate dynamic cooldown with exponential backoff
  private calculateCooldown(baseCooldownSeconds: number, consecutiveFires: number): number {
    if (consecutiveFires === 0) {
      return baseCooldownSeconds * 1000;
    }

    // Exponential backoff: 1x -> 1.5x -> 2.25x -> 3.375x ... (max 8x)
    const backoffMultiplier = Math.min(
      Math.pow(1.5, consecutiveFires),
      this.MAX_BACKOFF_MULTIPLIER,
    );

    return baseCooldownSeconds * 1000 * backoffMultiplier;
  }

  // ✅ NEW: Cleanup old cooldowns to prevent memory leak
  private cleanupCooldowns(): void {
    const now = Date.now();
    const staleThreshold = 60 * 60 * 1000; // 1 hour

    let cleaned = 0;
    for (const [key, lastNotification] of this.notificationCooldowns.entries()) {
      if (now - lastNotification > staleThreshold) {
        this.notificationCooldowns.delete(key);
        this.consecutiveFires.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(
        `🧹 Cleaned ${cleaned} stale cooldowns. Active: ${this.notificationCooldowns.size}`,
      );
    }
  }

  // ✅ NEW: Reset consecutive fires for a symbol (call when price stabilizes)
  public resetConsecutiveFires(userId: number, symbol: string): void {
    const key = `${userId}-${symbol}`;
    this.consecutiveFires.delete(key);
    this.logger.debug(`Reset consecutive fires for ${symbol}`);
  }
}