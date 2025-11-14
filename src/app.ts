import { Inject, Injectable } from './shared/decorators';
import { Logger } from './shared/logger';
import { IMarketDataGateway, ITriggerEngineService } from './domain/interfaces/services.interface';
import { TelegramBotService } from './infrastructure/telegram/telegram.bot';
import { ITriggerRepository } from './domain/interfaces/repositories.interface';
import { CommandHandler } from './presentation/telegram/handlers/command.handler';

@Injectable()
export class PumpScoutBot {
  private readonly logger = new Logger(PumpScoutBot.name);

  constructor(
    @Inject('IMarketDataGateway') private readonly marketDataGateway: IMarketDataGateway,
    @Inject('ITriggerEngineService') private readonly triggerEngine: ITriggerEngineService,
    private readonly telegramBotService: TelegramBotService,
    @Inject('ITriggerRepository') private readonly triggerRepository: ITriggerRepository,
    private readonly commandHandler: CommandHandler,
  ) {}

  public async start(): Promise<void> {
    this.logger.info('Initializing Pump Scout Bot...');
    try {
      await this.triggerRepository.init();
      this.logger.info(
        `Trigger repository initialized with ${this.triggerRepository.getAllActive().length} active triggers.`,
      );

      await this.marketDataGateway.connect();
      this.triggerEngine.start();

      this.commandHandler.initialize();

      this.logger.info('Pump Scout Bot started successfully!');
    } catch (error) {
      this.logger.error('Failed to initialize Pump Scout Bot:', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Pump Scout Bot...');
    this.triggerEngine.stop();
    await this.marketDataGateway.disconnect();
    await this.telegramBotService.stop();
    this.logger.info('Pump Scout Bot stopped gracefully.');
  }
}
