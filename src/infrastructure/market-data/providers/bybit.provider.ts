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

const BYBIT_SPOT_STREAM_URL = 'wss://stream.bybit.com/v5/public/spot';
const BYBIT_FUTURES_STREAM_URL = 'wss://stream.bybit.com/v5/public/linear';
const RECONNECT_DELAY = 5000;
const PING_INTERVAL = 20000;

@Injectable()
export class BybitMarketDataProvider implements IMarketDataProvider {
  public readonly providerId: string;
  public readonly marketType: MarketType;
  private readonly logger: Logger;
  private readonly streamUrl: string;

  private ws: WebSocket | null = null;
  private connected = false;
  private reconnecting = false;
  private callback: PriceUpdateCallback | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  private messageCount = 0;
  private errorCount = 0;
  private reconnectAttempts = 0;
  private lastUpdateTime = 0;
  private subscribedSymbols: string[] = [];

  constructor(marketType: MarketType = 'spot') {
    this.marketType = marketType;
    this.providerId = `bybit-${marketType}`;
    this.logger = new Logger(this.providerId);
    this.streamUrl = marketType === 'futures' ? BYBIT_FUTURES_STREAM_URL : BYBIT_SPOT_STREAM_URL;
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
          this.startPingInterval();
          this.logger.info(`Connected to Bybit ${this.marketType}`);
          
          if (this.subscribedSymbols.length > 0) {
            this.subscribe(this.subscribedSymbols);
          }
          
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
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
          this.stopPingInterval();
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
    this.stopPingInterval();
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
    if (!this.connected || !this.ws) {
      this.subscribedSymbols = symbols;
      return;
    }

    const topics = symbols.map((symbol) => `tickers.${symbol}`);
    
    const subscribeMsg = {
      op: 'subscribe',
      args: topics,
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    this.subscribedSymbols = symbols;
    this.logger.info(`Subscribed to ${symbols.length} symbols`);
  }

  public async unsubscribe(symbols: string[]): Promise<void> {
    if (!this.connected || !this.ws) return;

    const topics = symbols.map((symbol) => `tickers.${symbol}`);
    
    const unsubscribeMsg = {
      op: 'unsubscribe',
      args: topics,
    };

    this.ws.send(JSON.stringify(unsubscribeMsg));
    this.subscribedSymbols = this.subscribedSymbols.filter((s) => !symbols.includes(s));
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

  private handleMessage(message: any): void {
    if (message.op === 'pong') return;

    if (message.op === 'subscribe' && message.success) {
      this.logger.debug('Subscription confirmed');
      return;
    }

    if (message.topic?.startsWith('tickers.') && message.data) {
      this.handleTickerData(message.data);
    }
  }

  private handleTickerData(data: any): void {
    if (!this.callback) return;

    try {
      const symbol = data.symbol;
      if (!symbol?.endsWith('USDT')) return;

      const price = parseFloat(data.lastPrice);
      const timestamp = parseInt(data.time) || Date.now();

      if (symbol && price > 0) {
        this.messageCount++;
        this.lastUpdateTime = Date.now();

        const updateData: PriceUpdateData = {
          providerId: this.providerId,
          marketType: this.marketType,
          symbol,
          price,
          timestamp,
          volume: data.volume24h ? parseFloat(data.volume24h) : undefined,
          quoteVolume: data.turnover24h ? parseFloat(data.turnover24h) : undefined,
        };

        // Futures-specific fields
        if (this.marketType === 'futures') {
          updateData.markPrice = data.markPrice ? parseFloat(data.markPrice) : undefined;
          updateData.fundingRate = data.fundingRate ? parseFloat(data.fundingRate) : undefined;
        }

        this.callback(updateData);
      }
    } catch (error) {
      this.errorCount++;
      this.logger.debug('Ticker processing error:', error);
    }
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, PING_INTERVAL);
  }

  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
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