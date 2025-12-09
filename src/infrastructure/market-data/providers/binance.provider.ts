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

const BINANCE_SPOT_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const BINANCE_FUTURES_EXCHANGE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_SPOT_STREAM_BASE = 'wss://stream.binance.com:9443/stream';
const BINANCE_FUTURES_STREAM_BASE = 'wss://fstream.binance.com/stream';

const BATCH_SIZE = 30;
const LOAD_SYMBOLS_RETRIES = 5;

@Injectable()
export class BinanceMarketDataProvider implements IMarketDataProvider {
  public readonly providerId: string;
  public readonly marketType: MarketType;
  private readonly logger: Logger;

  private wsList: WebSocket[] = [];
  private reconnectTimers = new Set<NodeJS.Timeout>();
  private connected = false;
  private intentionalDisconnect = false;
  private callback: PriceUpdateCallback | null = null;

  private symbols = new Set<string>();
  private readyPromise: Promise<void>;

  private messageCount = 0;
  private errorCount = 0;
  private reconnectAttempts = 0;
  private lastUpdateTime = 0;

  constructor(marketType: MarketType = 'spot') {
    this.marketType = marketType;
    this.providerId = `binance-${marketType}`;
    this.logger = new Logger(this.providerId);
    this.readyPromise = this.loadSymbolsWithRetry();
  }

  private async loadSymbolsWithRetry(): Promise<void> {
    let lastErr: any;
    for (let attempt = 1; attempt <= LOAD_SYMBOLS_RETRIES; attempt++) {
      try {
        await this.loadSymbols();
        return;
      } catch (e) {
        lastErr = e;
        this.logger.warn(`loadSymbols attempt ${attempt} failed`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    this.logger.error('Failed to load symbols after retries', lastErr);
    throw lastErr;
  }

  private async loadSymbols(): Promise<void> {
    const url =
      this.marketType === 'futures'
        ? BINANCE_FUTURES_EXCHANGE_INFO_URL
        : BINANCE_SPOT_EXCHANGE_INFO_URL;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'BinanceMarketDataProvider/1.0' },
      signal: (AbortSignal as any).timeout ? AbortSignal.timeout(10_000) : undefined,
    });

    if (!res.ok) throw new Error(`Exchange info fetch failed: ${res.status}`);

    const data: any = await res.json();
    this.symbols.clear();

    for (const s of data.symbols || []) {
      if (this.marketType === 'futures') {
        if (
          s.contractType === 'PERPETUAL' &&
          s.marginAsset === 'USDT' &&
          s.status === 'TRADING'
        ) {
          this.symbols.add(s.symbol);
        }
      } else {
        if (s.status === 'TRADING' && s.symbol.endsWith('USDT')) {
          this.symbols.add(s.symbol);
        }
      }
    }

    this.logger.info(`Loaded ${this.symbols.size} ${this.marketType} symbols`);
  }

  private createBatchWS(batch: string[]): WebSocket {
    const streamName = this.marketType === 'futures' ? 'ticker' : 'ticker';
    const streams = batch.map((s) => `${s.toLowerCase()}@${streamName}`).join('/');
    const baseUrl =
      this.marketType === 'futures' ? BINANCE_FUTURES_STREAM_BASE : BINANCE_SPOT_STREAM_BASE;
    const url = `${baseUrl}?streams=${streams}`;

    const ws = new WebSocket(url);
    let closedByUs = false;

    ws.on('open', () => {
      this.logger.debug(`Batch WS connected (${batch.length} symbols)`);
    });

    ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    ws.on('error', (err) => {
      this.logger.error('Batch WS error', err);
    });

    ws.on('close', () => {
      if (closedByUs) return;
      this.logger.warn(`Batch WS closed — reconnecting in 3s (${batch.length} symbols)`);
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(timer);
        if (this.intentionalDisconnect || !this.connected) return;
        try {
          const newWs = this.createBatchWS(batch);
          const idx = this.wsList.indexOf(ws);
          if (idx !== -1) this.wsList[idx] = newWs;
          else this.wsList.push(newWs);
        } catch (e) {
          this.logger.error('Failed to recreate batch WS', e);
        }
      }, 3000);
      this.reconnectTimers.add(timer);
    });

    Object.defineProperty(ws, '_closeGracefully', {
      value: () => {
        closedByUs = true;
        try {
          ws.terminate();
        } catch (e) {}
      },
      writable: false,
    });

    return ws;
  }

  private subscribeToBatches(): void {
    // Закрываем существующие соединения
    this.wsList.forEach((ws: any) => {
      try {
        if (typeof ws._closeGracefully === 'function') ws._closeGracefully();
        else ws.terminate();
      } catch (e) {}
    });
    this.wsList = [];

    const symbolsArray = Array.from(this.symbols);
    for (let i = 0; i < symbolsArray.length; i += BATCH_SIZE) {
      const batch = symbolsArray.slice(i, i + BATCH_SIZE);
      const ws = this.createBatchWS(batch);
      this.wsList.push(ws);
    }

    this.logger.info(
      `Subscribed to ${symbolsArray.length} symbols in ${this.wsList.length} batches`
    );
  }

  private handleMessage(raw: string): void {
    if (!this.callback) return;

    try {
      const msg = JSON.parse(raw);
      // Для батч стримов данные приходят в формате { stream: "...", data: {...} }
      const ticker = msg.data;

      if (!ticker) return;

      const symbol: string = ticker.s || ticker.S;
      if (!symbol?.endsWith('USDT')) return;

      if (this.marketType === 'futures') {
        if (symbol.includes('_') || !this.symbols.has(symbol)) return;
      } else {
        if (!this.symbols.has(symbol)) return;
      }

      const price = parseFloat(ticker.c || ticker.C);
      if (isNaN(price) || price <= 0) return;

      this.messageCount++;
      this.lastUpdateTime = Date.now();

      const update: PriceUpdateData = {
        providerId: this.providerId,
        marketType: this.marketType,
        symbol,
        price,
        timestamp: ticker.E || Date.now(),
      };

      if (this.marketType === 'futures') {
        if (ticker.p) update.markPrice = parseFloat(ticker.p);
        if (ticker.r) update.fundingRate = parseFloat(ticker.r);
      }

      try {
        this.callback(update);
      } catch (e) {
        this.logger.error('Callback error in handleMessage', e);
      }
    } catch (e) {
      this.errorCount++;
      this.logger.debug('Message parse error', e);
    }
  }

  public async connect(): Promise<void> {
    if (this.connected) return;

    await this.readyPromise;

    this.connected = true;
    this.reconnectAttempts = 0;
    this.intentionalDisconnect = false;

    this.subscribeToBatches();
    this.logger.info(`Connected to Binance ${this.marketType}`);
  }

  public async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.connected = false;

    // Очищаем все pending reconnect таймеры
    this.reconnectTimers.forEach((timer) => clearTimeout(timer));
    this.reconnectTimers.clear();

    // Закрываем все WebSocket соединения
    this.wsList.forEach((ws: any) => {
      try {
        if (typeof ws._closeGracefully === 'function') ws._closeGracefully();
        else ws.terminate();
      } catch (e) {}
    });
    this.wsList = [];

    this.logger.info('Disconnected');
  }

  public async unsubscribe(): Promise<void> {
    await this.disconnect();
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async subscribe(): Promise<void> {
    // Уже подписаны при connect
  }

  public async getAvailableSymbols(): Promise<string[]> {
    await this.readyPromise;
    return Array.from(this.symbols);
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

}
