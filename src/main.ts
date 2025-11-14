import 'reflect-metadata';
import { config } from 'dotenv';
import { DIContainer } from './shared/container';
import { DatabaseModule } from './infrastructure/database/database.module';
import { Logger } from './shared/logger';
import { registerDependencies } from './app.container';

config();

import './infrastructure/repositories/signal.repository';
import './infrastructure/repositories/symbol-metadata.repository';
import './infrastructure/services/binance-websocket.service';
import './infrastructure/telegram/telegram.bot';
import './infrastructure/http/binance-api.client';
import './presentation/telegram/handlers/command.handler';
import './presentation/telegram/handlers/signal.handler';

import { PumpScoutBot } from './app';

const logger = new Logger('Main');

async function bootstrap(): Promise<void> {
  let app: PumpScoutBot | null = null;
  
  try {
    logger.info('Starting Pump Scout Bot...');

    registerDependencies();
    await DatabaseModule.initialize();

    app = DIContainer.getInstance().get<PumpScoutBot>(PumpScoutBot);
    await app.start();

    logger.info('Pump Scout Bot started successfully');

    let isShuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (isShuttingDown) {
        logger.warn('Forced shutdown!');
        process.exit(1);
      }
      
      isShuttingDown = true;
      logger.info(`Received ${signal}, shutting down gracefully...`);
      
      const forceShutdownTimer = setTimeout(() => {
        logger.error('Graceful shutdown timeout, forcing exit');
        process.exit(1);
      }, 30000);

      try {
        if (app) {
          await app.stop();
        }
        clearTimeout(forceShutdownTimer);
      } catch (error) {
        logger.error('Error during shutdown:', error);
      } finally {
        try {
          await DatabaseModule.close();
        } catch (error) {
          logger.error('Error closing database:', error);
        }
        process.exit(0);
      }
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    
    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught Exception:', error);
      await shutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', async (reason, promise) => {
      logger.error('Unhandled Rejection:', { reason, promise });
      await shutdown('UNHANDLED_REJECTION');
    });
  } catch (error) {
    logger.error('Failed to start application:', error);
    try {
      if (app) {
        await app.stop();
      }
    } catch (stopError) {
      logger.error('Error stopping app:', stopError);
    }
    await DatabaseModule.close();
    process.exit(1);
  }
}

bootstrap();