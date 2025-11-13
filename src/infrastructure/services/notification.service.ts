import { Inject, Injectable } from '../../shared/decorators';
import { INotificationService, IMetricChanges } from '../../domain/interfaces/services.interface';
import { ISignalRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { SignalDto, SignalQuality } from '../../application/dto/signal.dto';
import { SignalHandler } from '../../presentation/telegram/handlers/signal.handler';
import { Logger } from '../../shared/logger';

@Injectable()
export class NotificationService implements INotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly notificationCooldowns = new Map<string, number>();

  constructor(
    private readonly signalHandler: SignalHandler,
    @Inject('ISignalRepository')
    private readonly signalRepository: ISignalRepository,
  ) {}

  public async processTrigger(
    trigger: Trigger,
    symbol: string,
    metrics: IMetricChanges,
  ): Promise<void> {
    const cooldownKey = `${trigger.userId}-${symbol}`;
    const lastNotification = this.notificationCooldowns.get(cooldownKey);
    const now = Date.now();

    if (lastNotification && now - lastNotification < trigger.notificationLimitSeconds * 1000) {
      // ADD: Log cooldown hits
      this.logger.debug(
        `⏰ Cooldown active for ${symbol} (${trigger.notificationLimitSeconds}s remaining)`,
      );
      return;
    }

    this.logger.info(
      `Trigger #${trigger.id} fired for ${symbol}. Price change: ${metrics.priceChangePercent.toFixed(2)}%`,
    );

    this.notificationCooldowns.set(cooldownKey, now);

    // ADD: Log signal details
    this.logger.debug(
      `📤 Sending signal to user ${trigger.userId}: ${symbol} ${metrics.priceChangePercent.toFixed(2)}%`,
    );

    // Simple quality based on magnitude
    const quality: SignalQuality =
      Math.abs(metrics.priceChangePercent) > 5
        ? 'strong'
        : Math.abs(metrics.priceChangePercent) > 2
          ? 'medium'
          : 'weak';

    const signalDto = new SignalDto(
      0,
      symbol,
      metrics.priceChangePercent,
      metrics.currentPrice,
      metrics.previousPrice,
      new Date(),
      quality,
      trigger.timeIntervalMinutes,
    );

    await this.signalHandler.handleSignal(
      signalDto,
      trigger.id,
      trigger.userId,
      trigger.timeIntervalMinutes,
    );
  }
}
