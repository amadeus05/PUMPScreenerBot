import TelegramBot from 'node-telegram-bot-api';
import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { SignalDto, SignalQuality } from '../../application/dto/signal.dto';

@Injectable()
export class TelegramBotService {
  private bot: TelegramBot;
  private readonly logger = new Logger(TelegramBotService.name);

  constructor(token: string) {
    if (!token) {
      throw new Error('Telegram Bot Token is not provided!');
    }
    this.bot = new TelegramBot(token, { polling: true });
    this.setupErrorHandling();
  }

  public getBot(): TelegramBot {
    return this.bot;
  }

  public async sendMessage(chatId: number, message: string): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true, // ← ДОБАВЛЯЕМ ЭТУ СТРОКУ
      });
    } catch (error) {
      this.logger.error(`Failed to send Telegram message to chat ${chatId}:`, error);
    }
  }

  /**
   * Принимает на вход полный SignalDto и отправляет отформатированное сообщение.
   */
  public async sendSignal(
    chatId: number,
    signal: SignalDto,
    triggerIntervalMinutes?: number,
  ): Promise<void> {
    const message = this.formatSignalMessage(signal, triggerIntervalMinutes);
    await this.sendMessage(chatId, message);
  }

  private formatSignalMessage(signal: SignalDto, triggerIntervalMinutes?: number): string {
    const qualityEmoji = { strong: '🟢', medium: '🟡', weak: '🔴' };

    const formatPercent = (value: number): string => {
      const sign = value >= 0 ? '↗️' : '↘️';
      return `${sign} ${Math.abs(value).toFixed(2)}%`;
    };

    const timeStr = signal.timestamp.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit', // Add seconds for real-time feel
    });

    const priceStr = this.formatPrice(signal.currentPrice);
    const prevPriceStr = this.formatPrice(signal.previousPrice);
    const intervalDisplay = triggerIntervalMinutes ? `${triggerIntervalMinutes}m` : '';

    // Fix: Change to spot trading link
    const binanceLink = `https://www.binance.com/ru/trade/${signal.symbol}`;
    const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${signal.symbol}`;

    return `
  ${qualityEmoji[signal.quality]} №${signal.signalNumber} - <a href="${binanceLink}">${signal.symbol}</a> - ${intervalDisplay}
  <a href="${tradingViewLink}">Price: ${formatPercent(signal.priceChangePercent)}</a>
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
