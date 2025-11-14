import { Inject, Injectable } from '../../../shared/decorators';
import { TelegramBotService } from '../../../infrastructure/telegram/telegram.bot';
import { SignalDto } from '../../../application/dto/signal.dto';
import { ISignalRepository } from '../../../domain/interfaces/repositories.interface';
import { Signal } from '../../../domain/entities/signal.entity';
import { Logger } from '../../../shared/logger';

@Injectable()
export class SignalHandler {
  private readonly logger = new Logger(SignalHandler.name);

  constructor(
    private readonly telegramBotService: TelegramBotService,
    @Inject('ISignalRepository')
    private readonly signalRepository: ISignalRepository,
  ) {}

  async handleSignal(
    signalDto: SignalDto,
    triggerId: number,
    userId: number,
    triggerIntervalMinutes?: number,
  ): Promise<void> {
    try {
      const signalCount = await this.signalRepository.getLast24HoursSignalCountByTriggerAndSymbol(
        triggerId,
        signalDto.symbol,
      );

      this.logger.debug(
        `Trigger #${triggerId}: Found ${signalCount} previous signals, assigning number ${signalCount + 1}`,
      );

      const signal = new Signal();
      signal.signalNumber = signalCount + 1;
      signal.triggerId = triggerId;
      signal.symbol = signalDto.symbol;
      signal.priceChangePercent = signalDto.priceChangePercent;
      signal.currentPrice = signalDto.currentPrice;

      await this.signalRepository.save(signal);

      // ✅ UPDATED: Removed quality parameter from signalDto
      await this.telegramBotService.sendSignal(
        userId,
        {
          ...signalDto,
          signalNumber: signalCount + 1,
          timestamp: new Date(),
        },
        triggerIntervalMinutes,
      );

      this.logger.info(`Signal sent for ${signalDto.symbol} (trigger #${triggerId})`);
    } catch (error) {
      this.logger.error('Error handling signal:', error);
    }
  }
}