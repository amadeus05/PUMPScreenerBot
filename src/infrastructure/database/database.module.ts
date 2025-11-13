import { DataSource } from 'typeorm';
import { Signal } from '../../domain/entities/signal.entity';
import { SymbolMetadata } from '../../domain/entities/symbol-metadata.entity';
import { Trigger } from '../../domain/entities/trigger.entity';
import { Logger } from '../../shared/logger';

const logger = new Logger('DatabaseModule');

export const AppDataSource = new DataSource({
  type: 'sqlite',
  database: 'database.sqlite',
  synchronize: true, // Для разработки. В продакшене лучше использовать миграции.
  logging: false,
  entities: [Trigger, Signal, SymbolMetadata],
  migrations: [],
  subscribers: [],
});

export class DatabaseModule {
  static async initialize(): Promise<void> {
    try {
      await AppDataSource.initialize();
      logger.info('Database connection established');
    } catch (error) {
      logger.error('Database connection failed:', error);
      throw error;
    }
  }

  static async close(): Promise<void> {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}
