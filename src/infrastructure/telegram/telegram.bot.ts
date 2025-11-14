import TelegramBot from 'node-telegram-bot-api';
import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { SignalDto } from '../../application/dto/signal.dto';

@Injectable()
export class TelegramBotService {
  private bot: TelegramBot;
  private readonly logger = new Logger(TelegramBotService.name);

  // ✅ NEW: Rate limiting for Telegram API (30 messages per second)
  private readonly messageQueue = new Map<number, Array<{ message: string; timestamp: number }>>();
  private readonly MAX_MESSAGES_PER_SECOND = 25; // Stay below 30 limit
  private readonly RATE_LIMIT_WINDOW_MS = 1000;

  constructor(token: string) {
    if (!token) {
      throw new Error('Telegram Bot Token is not provided!');
    }
    this.bot = new TelegramBot(token, { polling: true });
    this.setupErrorHandling();

    // ✅ NEW: Cleanup old queue entries every minute
    setInterval(() => this.cleanupQueues(), 60_000);
  }

  public getBot(): TelegramBot {
    return this.bot;
  }

  // ✅ FIX: Added rate limiting
  public async sendMessage(chatId: number, message: string): Promise<void> {
    try {
      // Check rate limit
      if (!(await this.checkRateLimit(chatId))) {
        this.logger.warn(`Rate limit exceeded for chat ${chatId}, message queued`);
        await this.delay(1000);
      }

      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });

      // Track message
      this.trackMessage(chatId);
    } catch (error) {
      this.logger.error(`Failed to send Telegram message to chat ${chatId}:`, error);
    }
  }

  // ✅ UPDATED: Removed quality parameter and simplified format
  public async sendSignal(
    chatId: number,
    signal: SignalDto,
    triggerIntervalMinutes?: number,
  ): Promise<void> {
    const message = this.formatSignalMessage(signal, triggerIntervalMinutes);
    await this.sendMessage(chatId, message);
  }

  // ✅ UPDATED: Removed quality indicator, cleaner format
  private formatSignalMessage(signal: SignalDto, triggerIntervalMinutes?: number): string {
    const formatPercent = (value: number): string => {
      const sign = value >= 0 ? '📈' : '📉';
      return `${sign} ${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
    };

    const timeStr = signal.timestamp.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const priceStr = this.formatPrice(signal.currentPrice);
    const prevPriceStr = this.formatPrice(signal.previousPrice);
    const intervalDisplay = triggerIntervalMinutes ? `${triggerIntervalMinutes}m` : '';

    // ✅ FIX: Changed to spot trading links (removed futures)
    const binanceLink = `https://www.binance.com/ru/trade/${signal.symbol}`;
    const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${signal.symbol}`;

    // ✅ NEW: Minimalist format without quality indicator
    return `
🚨 №${signal.signalNumber} - <a href="${binanceLink}">${signal.symbol}</a> ${intervalDisplay}
${formatPercent(signal.priceChangePercent)} <a href="${tradingViewLink}">Chart</a>
💵 ${prevPriceStr} → ${priceStr} • ⏰ ${timeStr}
    `.trim();
  }

  /**
   * Smart price formatting based on value magnitude
   */
  private formatPrice(price: number): string {
    if (price >= 1000) {
      return price.toFixed(2); // $1,234.56
    } else if (price >= 1) {
      return price.toFixed(4); // $12.3456
    } else if (price >= 0.01) {
      return price.toFixed(4); // $0.1234
    } else {
      return price.toFixed(6); // $0.000123
    }
  }

  // ✅ NEW: Rate limiting implementation
  private async checkRateLimit(chatId: number): Promise<boolean> {
    const now = Date.now();
    const queue = this.messageQueue.get(chatId) || [];

    // Remove messages outside the rate limit window
    const recentMessages = queue.filter((msg) => now - msg.timestamp < this.RATE_LIMIT_WINDOW_MS);

    if (recentMessages.length >= this.MAX_MESSAGES_PER_SECOND) {
      return false;
    }

    this.messageQueue.set(chatId, recentMessages);
    return true;
  }

  private trackMessage(chatId: number): void {
    const queue = this.messageQueue.get(chatId) || [];
    queue.push({ message: '', timestamp: Date.now() });
    this.messageQueue.set(chatId, queue);
  }

  // ✅ NEW: Cleanup old queue entries
  private cleanupQueues(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [chatId, queue] of this.messageQueue.entries()) {
      const recentMessages = queue.filter((msg) => now - msg.timestamp < this.RATE_LIMIT_WINDOW_MS);
      
      if (recentMessages.length === 0) {
        this.messageQueue.delete(chatId);
        cleaned++;
      } else {
        this.messageQueue.set(chatId, recentMessages);
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`🧹 Cleaned ${cleaned} empty message queues`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private setupErrorHandling(): void {
    this.bot.on('error', (error) => {
      this.logger.error('Telegram Bot error:', error);
    });

    this.bot.on('polling_error', (error) => {
      this.logger.error('Telegram Bot polling error:', error);
    });
  }

  public async stop(): Promise<void> {
    if (this.bot.isPolling()) {
      await this.bot.stopPolling();
    }
  }
}