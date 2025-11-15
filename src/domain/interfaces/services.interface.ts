import { Trigger } from '../entities/trigger.entity';

export interface IDataPoint {
  readonly timestamp: number;
  readonly price: number;
}

export interface IMetricChanges {
  readonly priceChangePercent: number;
  readonly currentPrice: number;
  readonly previousPrice: number; // NEW: for context
  readonly timeWindowSeconds: number; // NEW: actual time window measured
}

export interface IDataAggregatorService {
  updatePrice(symbol: string, price: number, timestamp: number): void;
  getMetricChanges(symbol: string, timeIntervalMinutes: number): IMetricChanges | null;
  getAllKnownSymbols(): string[];
  getHistoryLength(symbol: string): number;
  getCurrentPrice(symbol: string): number;
  setTriggerEngine(engine: ITriggerEngineService): void;
}

export interface IMarketDataGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getActiveProviders?(): string[];
  getProvidersHealth?(): Record<string, any>;
}

export interface ITriggerEngineService {
  start(): void;
  stop(): void;
  onPriceUpdate(symbol: string, price: number): Promise<void>;
}

export interface INotificationService {
  processTrigger(trigger: Trigger, symbol: string, metrics: IMetricChanges): Promise<void>;
}