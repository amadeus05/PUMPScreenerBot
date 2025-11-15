import WebSocket from 'ws';
import { Injectable } from '../../../shared/decorators';
import { Logger } from '../../../shared/logger';
import {
  IMarketDataProvider,
  PriceUpdateCallback,
  PriceUpdateData,
  ProviderHealthStatus,
} from '../../../domain/interfaces/market-data-provider.interface';

const BINANCE_SPOT_STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const RECONNECT_DELAY = 5000;

@Injectable()
export class BinanceMarketDataProvider implements IMarketDataProvider {
  public readonly providerId = 'binance';
  private readonly logger = new Logger('BinanceProvider');

  private ws: WebSocket | null = null;
  private connected = false;
  private reconnecting = false;
  private callback: PriceUpdateCallback | null = null;

  private messageCount = 0;
  private errorCount = 0;
  private reconnectAttempts = 0;
  private lastUpdateTime = 0;

  public async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(BINANCE_SPOT_STREAM_URL);

        this.ws.on('open', () => {
          this.connected = true;
          this.reconnecting = false;
          this.reconnectAttempts = 0;
          this.logger.info(`${this.providerId}: Connected`);
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const messages = JSON.parse(data.toString());
            this.handleMessages(messages);
          } catch (error) {
            this.errorCount++;
            this.logger.error(`${this.providerId}: Parse error`, error);
          }
        });

        this.ws.on('error', (error) => {
          this.errorCount++;
          this.logger.error(`${this.providerId}: WebSocket error`, error);
          if (!this.connected) reject(error);
        });

        this.ws.on('close', () => {
          this.connected = false;
          this.logger.warn(`${this.providerId}: Connection closed`);
          this.handleReconnection();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.logger.info(`${this.providerId}: Disconnected`);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async subscribe(symbols: string[]): Promise<void> {
    // Binance stream already provides all symbols, no action needed
    this.logger.debug(`${this.providerId}: Subscription not needed (all symbols stream)`);
  }

  public async unsubscribe(symbols: string[]): Promise<void> {
    // Not applicable for Binance all-symbols stream
  }

  public async getAvailableSymbols(): Promise<string[]> {
    // Would require REST API call to /api/v3/exchangeInfo
    // For now, return empty array as we get symbols from stream
    return [];
  }

  public onPriceUpdate(callback: PriceUpdateCallback): void {
    this.callback = callback;
  }

  public getHealthStatus(): ProviderHealthStatus {
    return {
      providerId: this.providerId,
      isConnected: this.connected,
      lastUpdateTime: this.lastUpdateTime,
      messageCount: this.messageCount,
      reconnectAttempts: this.reconnectAttempts,
      errorCount: this.errorCount,
    };
  }

  private handleMessages(messages: any[]): void {
    if (!this.callback) return;

    for (const msg of messages) {
      try {
        const symbol = msg.s;
        if (!symbol?.endsWith('USDT')) continue;

        const price = parseFloat(msg.c);
        const timestamp = msg.E;

        if (symbol && price > 0 && timestamp) {
          this.messageCount++;
          this.lastUpdateTime = Date.now();

          const data: PriceUpdateData = {
            providerId: this.providerId,
            symbol,
            price,
            timestamp,
            volume: msg.v ? parseFloat(msg.v) : undefined,
            quoteVolume: msg.q ? parseFloat(msg.q) : undefined,
          };

          this.callback(data);
        }
      } catch (error) {
        this.errorCount++;
        this.logger.debug(`${this.providerId}: Message processing error`, error);
      }
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnecting || !this.connected) return;

    this.reconnecting = true;
    this.reconnectAttempts++;
    this.logger.info(`${this.providerId}: Reconnecting... (attempt ${this.reconnectAttempts})`);

    await this.disconnect();
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));

    try {
      await this.connect();
    } catch (error) {
      this.logger.error(`${this.providerId}: Reconnection failed`, error);
      this.reconnecting = false;
      this.handleReconnection();
    }
  }
}