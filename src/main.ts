import 'reflect-metadata';

import express from 'express';
import type { Request, Response } from 'express';

import { config } from 'dotenv';
import { DIContainer } from './shared/container';
import { DatabaseModule } from './infrastructure/database/database.module';
import { Logger } from './shared/logger';
import { registerDependencies } from './app.container';

// Load environment variables
config();

// Import all necessary classes to ensure decorators are executed
import './infrastructure/repositories/signal.repository';
import './infrastructure/repositories/symbol-metadata.repository';
import './infrastructure/telegram/telegram.bot';
import './presentation/telegram/handlers/command.handler';
import './presentation/telegram/handlers/signal.handler';

import { PumpScoutBot } from './app';

const server = express();
const PORT: number = Number(process.env.PORT) || 8000; // Render требует переменную PORT

// Здоровье бота
server.get('/health', (_req: Request, res: Response) => {
  res.status(200).send('Pump Scout Bot is alive!');
});

server.get('/', (_req: Request, res: Response) => {
  res.send('<h1>Я на связи!</h1><p>/health — <- проверить пульс <3 </p>');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Fake Express server listening on port ${PORT}`);
});

const logger = new Logger('Main');

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', `promise: ${promise}, reason: ${reason}`);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  try {
    logger.info('Starting Pump Scout Bot...');

    // Register all dependencies
    registerDependencies();

    // Initialize database
    await DatabaseModule.initialize();

    // Start the application
    const app: PumpScoutBot = DIContainer.getInstance().get<PumpScoutBot>(PumpScoutBot);
    await app.start();

    logger.info('Pump Scout Bot started successfully');

    // Graceful shutdown
    let isShuttingDown = false; // prevent double shutdown
    const shutdown = async (signal: string): Promise<void> => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info(`Received ${signal}, shutting down gracefully...`);
      try {
        await app.stop();
      } finally {
        await DatabaseModule.close();
        process.exit(0);
      }
    };

    // Use .once to avoid multiple handler invocations
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    logger.error('Failed to start application:', error);
    await DatabaseModule.close();
    process.exit(1);
  }
}

bootstrap();
