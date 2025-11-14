// src/app.ts
import { Inject, Injectable } from './shared/decorators';
import { Logger } from './shared/logger';
import { 
  IMarketDataGateway, 
  ITriggerEngineService,
  IDataAggregatorService 
} from './domain/interfaces/services.interface';
import { TelegramBotService } from './infrastructure/telegram/telegram.bot';
import { ITriggerRepository } from './domain/interfaces/repositories.interface';
import { CommandHandler } from './presentation/telegram/handlers/command.handler';

@Injectable()
export class PumpScoutBot {
  private readonly logger = new Logger(PumpScoutBot.name);
  private isShuttingDown = false;
  private isRunning = false;

  constructor(
    @Inject('IMarketDataGateway') 
    private readonly marketDataGateway: IMarketDataGateway,
    
    @Inject('ITriggerEngineService') 
    private readonly triggerEngine: ITriggerEngineService,
    
    private readonly telegramBotService: TelegramBotService,
    
    @Inject('ITriggerRepository') 
    private readonly triggerRepository: ITriggerRepository,
    
    private readonly commandHandler: CommandHandler,
    
    @Inject('IDataAggregatorService') 
    private readonly dataAggregator: IDataAggregatorService,
  ) {}

  /**
   * Start the bot and all its services
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Bot already running');
      return;
    }

    this.logger.info('🚀 Initializing Pump Scout Bot...');
    
    try {
      // 1. Initialize trigger repository
      await this.triggerRepository.init();
      const activeTriggers = this.triggerRepository.getAllActive();
      this.logger.info(
        `✅ Trigger repository initialized with ${activeTriggers.length} active triggers`
      );

      // 2. Connect to market data
      await this.marketDataGateway.connect();
      this.logger.info('✅ Market data gateway connected');

      // 3. Start trigger engine
      this.triggerEngine.start();
      this.logger.info('✅ Trigger engine started');

      // 4. Initialize Telegram command handlers
      this.commandHandler.initialize();
      this.logger.info('✅ Telegram bot initialized');

      this.isRunning = true;
      this.logger.info('🎉 Pump Scout Bot started successfully!');
    } catch (error) {
      this.logger.error('❌ Failed to initialize Pump Scout Bot:', error);
      
      // Cleanup on startup failure
      await this.cleanup().catch(cleanupError => {
        this.logger.error('Error during startup cleanup:', cleanupError);
      });
      
      throw error;
    }
  }

  /**
   * Stop the bot gracefully
   */
  public async stop(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('⚠️ Shutdown already in progress');
      return;
    }

    if (!this.isRunning) {
      this.logger.warn('⚠️ Bot not running');
      return;
    }

    this.isShuttingDown = true;
    this.logger.info('🛑 Stopping Pump Scout Bot...');

    try {
      await this.cleanup();
      this.isRunning = false;
      this.logger.info('✅ Pump Scout Bot stopped gracefully');
    } catch (error) {
      this.logger.error('❌ Error during shutdown:', error);
      throw error;
    } finally {
      this.isShuttingDown = false;
    }
  }

  /**
   * Cleanup all services in proper order with timeouts
   */
  private async cleanup(): Promise<void> {
    const CLEANUP_TIMEOUT = 5000; // 5 seconds per service

    const cleanupTasks = [
      {
        name: 'Trigger Engine',
        action: async () => {
          this.triggerEngine.stop();
        }
      },
      {
        name: 'WebSocket Gateway',
        action: async () => {
          await this.marketDataGateway.disconnect();
        }
      },
      {
        name: 'Data Aggregator',
        action: async () => {
          if (typeof this.dataAggregator.shutdown === 'function') {
            this.dataAggregator.shutdown();
          }
        }
      },
      {
        name: 'Telegram Bot',
        action: async () => {
          await this.telegramBotService.stop();
        }
      }
    ];

    for (const task of cleanupTasks) {
      try {
        this.logger.info(`⏳ Stopping ${task.name}...`);
        
        await Promise.race([
          task.action(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), CLEANUP_TIMEOUT)
          )
        ]);
        
        this.logger.info(`✅ ${task.name} stopped`);
      } catch (error) {
        if (error instanceof Error && error.message === 'Timeout') {
          this.logger.error(`⏱️ ${task.name} shutdown timeout (${CLEANUP_TIMEOUT}ms)`);
        } else {
          this.logger.error(`❌ Failed to stop ${task.name}:`, error);
        }
      }
    }
  }

  /**
   * Get bot status
   */
  public getStatus(): {
    isRunning: boolean;
    isShuttingDown: boolean;
    activeTriggers: number;
    knownSymbols: number;
  } {
    return {
      isRunning: this.isRunning,
      isShuttingDown: this.isShuttingDown,
      activeTriggers: this.triggerRepository.getAllActive().length,
      knownSymbols: this.dataAggregator.getAllKnownSymbols().length,
    };
  }
}