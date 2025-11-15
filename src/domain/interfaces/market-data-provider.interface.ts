/**
 * Unified interface for all market data providers (exchanges)
 */
export interface IMarketDataProvider {
    /**
     * Unique identifier for the provider (e.g., 'binance', 'bybit', 'okx')
     */
    readonly providerId: string;
  
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
  
  export type PriceUpdateCallback = (data: PriceUpdateData) => void;
  
  export interface PriceUpdateData {
    providerId: string;
    symbol: string;
    price: number;
    timestamp: number;
    volume?: number;
    quoteVolume?: number;
  }
  
  export interface ProviderHealthStatus {
    providerId: string;
    isConnected: boolean;
    lastUpdateTime: number;
    messageCount: number;
    reconnectAttempts: number;
    errorCount: number;
  }