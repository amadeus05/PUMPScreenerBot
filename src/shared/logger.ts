import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

export class Logger {
  private logger: winston.Logger;

  constructor(private context: string) {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      defaultMeta: { context },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
        }),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new DailyRotateFile({
          filename: 'combined-%DATE%.log',
          datePattern: 'YYYY-MM-DD-HH-mm', // Формат имени файла
          frequency: '5m', // Ротация каждые 5 минут
          maxSize: '10m', // Максимальный размер файла 10MB
          maxFiles: '3', // Хранить только 1 файл
          zippedArchive: false, // Не архивировать старые файлы
        }),
      ],
    });
  }

  info(message: string, meta?: any): void {
    this.logger.info(message, meta);
  }

  error(message: string, meta?: any): void {
    this.logger.error(message, meta);
  }

  warn(message: string, meta?: any): void {
    this.logger.warn(message, meta);
  }

  debug(message: string, meta?: any): void {
    this.logger.debug(message, meta);
  }
}
