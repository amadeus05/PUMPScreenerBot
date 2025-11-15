import WebSocket from 'ws';
import { Injectable } from '../../../shared/decorators';
import { Logger } from '../../../shared/logger';
import {
  IMarketDataProvider,
  PriceUpdateCallback,
  PriceUpdateData,
  ProviderHealthStatus,
} from '../../../domain/interfaces/market-data-provider.interface';

const OKX_SPOT_STREAM_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const RECONNECT_DELAY = 5000;
const PING_INTERVAL = 25000; // OKX requires ping every 30s

@Injectable()
export class OKXMarketDataProvider implements IMarketDataProvider {
  public readonly providerId = 'okx';
  private readonly logger = new Logger('OKXProvider');

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

  public async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(OKX_SPOT_STREAM_URL);

        this.ws.on('open', () => {
          this.connected = true;
          this.reconnecting = false;
          this.reconnectAttempts = 0;
          this.startPingInterval();
          this.logger.info(`${this.providerId}: Connected`);
          
          // Resubscribe after reconnect
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
          this.stopPingInterval();
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
    this.stopPingInterval();
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
    if (!this.connected || !this.ws) {
      this.subscribedSymbols = symbols;
      return;
    }

    // OKX format: BTC-USDT instead of BTCUSDT
    const args = symbols.map((symbol) => ({
      channel: 'tickers',
      instId: symbol.replace('USDT', '-USDT'),
    }));

    const subscribeMsg = {
      op: 'subscribe',
      args,
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    this.subscribedSymbols = symbols;
    this.logger.info(`${this.providerId}: Subscribed to ${symbols.length} symbols`);
  }

  public async unsubscribe(symbols: string[]): Promise<void> {
    if (!this.connected || !this.ws) return;

    const args = symbols.map((symbol) => ({
      channel: 'tickers',
      instId: symbol.replace('USDT', '-USDT'),
    }));

    const unsubscribeMsg = {
      op: 'unsubscribe',
      args,
    };

    this.ws.send(JSON.stringify(unsubscribeMsg));
    this.subscribedSymbols = this.subscribedSymbols.filter((s) => !symbols.includes(s));
  }

  public async getAvailableSymbols(): Promise<string[]> {
    // Would require REST API call to /api/v5/public/instruments
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

  private handleMessage(message: any): void {
    // Handle pong response
    if (message.event === 'pong') {
      return;
    }

    // Handle subscription confirmation
    if (message.event === 'subscribe') {
      this.logger.debug(`${this.providerId}: Subscription confirmed`);
      return;
    }

    // Handle ticker data
    if (message.arg?.channel === 'tickers' && message.data) {
      for (const ticker of message.data) {
        this.handleTickerData(ticker);
      }
    }
  }

  private handleTickerData(data: any): void {
    if (!this.callback) return;

    try {
      // Convert OKX format BTC-USDT to BTCUSDT
      const symbol = data.instId?.replace('-', '');
      if (!symbol?.endsWith('USDT')) return;

      const price = parseFloat(data.last);
      const timestamp = parseInt(data.ts) || Date.now();

      if (symbol && price > 0) {
        this.messageCount++;
        this.lastUpdateTime = Date.now();

        const updateData: PriceUpdateData = {
          providerId: this.providerId,
          symbol,
          price,
          timestamp,
          volume: data.vol24h ? parseFloat(data.vol24h) : undefined,
          quoteVolume: data.volCcy24h ? parseFloat(data.volCcy24h) : undefined,
        };

        this.callback(updateData);
      }
    } catch (error) {
      this.errorCount++;
      this.logger.debug(`${this.providerId}: Ticker processing error`, error);
    }
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws) {
        this.ws.send('ping');
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