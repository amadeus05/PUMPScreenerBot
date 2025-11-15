/**
 * Unified interface for all market data providers (exchanges)
 */
export interface IMarketDataProvider {
    /**
     * Unique identifier for the provider (e.g., 'binance-spot', 'binance-futures', 'bybit-futures')
     */
    readonly providerId: string;
  
    /**
     * Market type (spot or futures)
     */
    readonly marketType: MarketType;
  
    /**
     * Establish WebSocket connection to the exchange
     */
    connect(): Promise<void>;
  
    /**
     * Close WebSocket connection
     */
    disconnect(): Promise<void>;
  
    /**
     * Check if provider is currently connected
     */
    isConnected(): boolean;
  
    /**
     * Subscribe to price updates for specific symbols
     * @param symbols - Array of trading pairs (e.g., ['BTCUSDT', 'ETHUSDT'])
     */
    subscribe(symbols: string[]): Promise<void>;
  
    /**
     * Unsubscribe from price updates
     */
    unsubscribe(symbols: string[]): Promise<void>;
  
    /**
     * Get list of all available trading pairs on this exchange
     */
    getAvailableSymbols(): Promise<string[]>;
  
    /**
     * Register callback for price updates
     * @param callback - Function to call when price updates are received
     */
    onPriceUpdate(callback: PriceUpdateCallback): void;
  
    /**
     * Get health status of the connection
     */
    getHealthStatus(): ProviderHealthStatus;
  }
  
  export type MarketType = 'spot' | 'futures';
  
  export type PriceUpdateCallback = (data: PriceUpdateData) => void;
  
  export interface PriceUpdateData {
    providerId: string;
    marketType: MarketType;
    symbol: string;
    price: number;
    timestamp: number;
    volume?: number;
    quoteVolume?: number;
    markPrice?: number; // Only for futures
    fundingRate?: number; // Only for futures
  }
  
  export interface ProviderHealthStatus {
    providerId: string;
    marketType: MarketType;
    isConnected: boolean;
    lastUpdateTime: number;
    messageCount: number;
    reconnectAttempts: number;
    errorCount: number;
  }
  
  /**
   * Configuration for creating a market data provider
   */
  export interface ProviderConfig {
    exchange: string; // 'binance', 'bybit', 'okx'
    marketType: MarketType; // 'spot' or 'futures'
  }