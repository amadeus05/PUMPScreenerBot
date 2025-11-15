import WebSocket from 'ws';
import { Injectable } from '../../../shared/decorators';
import { Logger } from '../../../shared/logger';
import {
  IMarketDataProvider,
  MarketType,
  PriceUpdateCallback,
  PriceUpdateData,
  ProviderHealthStatus,
} from '../../../domain/interfaces/market-data-provider.interface';

const BINANCE_SPOT_STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const BINANCE_FUTURES_STREAM_URL = 'wss://fstream.binance.com/ws/!ticker@arr';
const RECONNECT_DELAY = 5000;

@Injectable()
export class BinanceMarketDataProvider implements IMarketDataProvider {
  public readonly providerId: string;
  public readonly marketType: MarketType;
  private readonly logger: Logger;
  private readonly streamUrl: string;

  private ws: WebSocket | null = null;
  private connected = false;
  private reconnecting = false;
  private callback: PriceUpdateCallback | null = null;

  private messageCount = 0;
  private errorCount = 0;
  private reconnectAttempts = 0;
  private lastUpdateTime = 0;

  constructor(marketType: MarketType = 'spot') {
    this.marketType = marketType;
    this.providerId = `binance-${marketType}`;
    this.logger = new Logger(this.providerId);
    this.streamUrl = marketType === 'futures' ? BINANCE_FUTURES_STREAM_URL : BINANCE_SPOT_STREAM_URL;
  }

  public async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      try {
        this.logger.info(`Connecting to ${this.streamUrl}...`);
        this.ws = new WebSocket(this.streamUrl);

        this.ws.on('open', () => {
          this.connected = true;
          this.reconnecting = false;
          this.reconnectAttempts = 0;
          this.logger.info(`Connected to Binance ${this.marketType}`);
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const messages = JSON.parse(data.toString());
            this.handleMessages(messages);
          } catch (error) {
            this.errorCount++;
            this.logger.error('Parse error:', error);
          }
        });

        this.ws.on('error', (error) => {
          this.errorCount++;
          this.logger.error('WebSocket error:', error);
          if (!this.connected) reject(error);
        });

        this.ws.on('close', () => {
          this.connected = false;
          this.logger.warn('Connection closed');
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
    this.logger.info('Disconnected');
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async subscribe(symbols: string[]): Promise<void> {
    // Binance all-ticker stream doesn't need subscription
    this.logger.debug('Subscription not needed (all symbols stream)');
  }

  public async unsubscribe(symbols: string[]): Promise<void> {
    // Not applicable
  }

  public async getAvailableSymbols(): Promise<string[]> {
    return [];
  }

  public onPriceUpdate(callback: PriceUpdateCallback): void {
    this.callback = callback;
  }

  public getHealthStatus(): ProviderHealthStatus {
    return {
      providerId: this.providerId,
      marketType: this.marketType,
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
        
        // Filter only USDT pairs
        if (!symbol?.endsWith('USDT')) continue;
        
        // For futures: exclude quarterly contracts (e.g., BTCUSDT_250328)
        if (this.marketType === 'futures' && symbol.includes('_')) continue;

        const price = parseFloat(msg.c);
        const timestamp = msg.E;

        if (symbol && price > 0 && timestamp) {
          this.messageCount++;
          this.lastUpdateTime = Date.now();

          const data: PriceUpdateData = {
            providerId: this.providerId,
            marketType: this.marketType,
            symbol,
            price,
            timestamp,
            volume: msg.v ? parseFloat(msg.v) : undefined,
            quoteVolume: msg.q ? parseFloat(msg.q) : undefined,
          };

          // Futures-specific fields
          if (this.marketType === 'futures') {
            data.markPrice = msg.p ? parseFloat(msg.p) : undefined;
            data.fundingRate = msg.r ? parseFloat(msg.r) : undefined;
          }

          this.callback(data);
        }
      } catch (error) {
        this.errorCount++;
        this.logger.debug('Message processing error:', error);
      }
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnecting || !this.connected) return;

    this.reconnecting = true;
    this.reconnectAttempts++;
    this.logger.info(`Reconnecting... (attempt ${this.reconnectAttempts})`);

    await this.disconnect();
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));

    try {
      await this.connect();
    } catch (error) {
      this.logger.error('Reconnection failed:', error);
      this.reconnecting = false;
      this.handleReconnection();
    }
  }
}