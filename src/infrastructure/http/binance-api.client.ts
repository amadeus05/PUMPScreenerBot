import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';

interface BinanceExchangeInfo {
  symbols: Array<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    contractType: string;
  }>;
}

interface BinanceOpenInterest {
  symbol: string;
  openInterest: string;
}

@Injectable()
export class BinanceApiClient {
  private readonly baseUrl = 'https://fapi.binance.com';
  private readonly logger = new Logger(BinanceApiClient.name);
  private requestQueue: Array<() => Promise<any>> = [];
  private isProcessing = false;
  private readonly RPS_LIMIT = 3;
  private lastRequestTime = 0;

  constructor() {
    this.logger.info('BinanceApiClient initialized');
    this.processQueue();
  }

  async getUsdtPairs(): Promise<string[]> {
    try {
      this.logger.info('Fetching USDT pairs from Binance...');
      const exchangeInfo = await this.makeRequest<BinanceExchangeInfo>('/fapi/v1/exchangeInfo');

      const pairs = exchangeInfo.symbols
        .filter(
          (symbol) =>
            symbol.status === 'TRADING' &&
            symbol.quoteAsset === 'USDT' &&
            symbol.contractType === 'PERPETUAL',
        )
        .map((symbol) => symbol.symbol);

      this.logger.info(`Found ${pairs.length} active USDT pairs`);
      return pairs;
    } catch (error) {
      this.logger.error('Failed to get USDT pairs:', error);
      // Fallback to major pairs
      return [
        'BTCUSDT',
        'ETHUSDT',
        'BNBUSDT',
        'ADAUSDT',
        'XRPUSDT',
        'SOLUSDT',
        'DOTUSDT',
        'DOGEUSDT',
        'AVAXUSDT',
        'MATICUSDT',
        'LTCUSDT',
        'LINKUSDT',
        'ATOMUSDT',
        'XLMUSDT',
        'BCHUSDT',
      ];
    }
  }

  async getOpenInterest(symbol: string): Promise<number> {
    try {
      const data = await this.makeRequest<BinanceOpenInterest>('/fapi/v1/openInterest', { symbol });
      return parseFloat(data.openInterest);
    } catch (error) {
      this.logger.error(`Failed to get open interest for ${symbol}:`, error);
      return 0;
    }
  }

  async getTopSymbolsByOI(limit: number = 50): Promise<string[]> {
    this.logger.info(`Getting top ${limit} symbols by Open Interest...`);

    try {
      const allSymbols = await this.getUsdtPairs();

      if (allSymbols.length === 0) {
        throw new Error('No symbols available');
      }

      // For initial implementation, return first N symbols
      // In production, you'd implement actual OI-based sorting
      const topSymbols = allSymbols.slice(0, limit);

      this.logger.info(`Selected ${topSymbols.length} symbols for monitoring`);
      return topSymbols;
    } catch (error) {
      this.logger.error('Failed to get top symbols by OI:', error);

      // Comprehensive fallback list
      return [
        'BTCUSDT',
        'ETHUSDT',
        'BNBUSDT',
        'ADAUSDT',
        'XRPUSDT',
        'SOLUSDT',
        'DOTUSDT',
        'DOGEUSDT',
        'AVAXUSDT',
        'MATICUSDT',
        'LTCUSDT',
        'LINKUSDT',
        'ATOMUSDT',
        'XLMUSDT',
        'BCHUSDT',
        'ETCUSDT',
        'FILUSDT',
        'THETAUSDT',
        'VETUSDT',
        'TRXUSDT',
        'EOSUSDT',
        'XMRUSDT',
        'XTZUSDT',
        'ALGOUSDT',
        'ZECUSDT',
      ].slice(0, limit);
    }
  }

  private async makeRequest<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });

    return new Promise((resolve, reject) => {
      const request = async () => {
        try {
          await this.rateLimit();

          this.logger.debug(`Making request to: ${url.toString()}`);
          const response = await fetch(url.toString());

          if (response.status === 429) {
            this.logger.warn('Rate limit hit, retrying...');
            await this.delay(2000);
            return request();
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const data = (await response.json()) as T;
          resolve(data);
        } catch (error) {
          reject(error);
        }
      };

      this.requestQueue.push(request);
      this.processQueue();
    });
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minInterval = 1000 / this.RPS_LIMIT;

    if (timeSinceLastRequest < minInterval) {
      await this.delay(minInterval - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.requestQueue.length > 0) {
        const request = this.requestQueue.shift();
        if (request) {
          await request();
          await this.delay(1000 / this.RPS_LIMIT);
        }
      }
    } catch (error) {
      this.logger.error('Error processing request queue:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
