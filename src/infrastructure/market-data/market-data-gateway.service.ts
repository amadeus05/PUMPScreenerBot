import { Inject, Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import {
  IMarketDataGateway,
  IDataAggregatorService,
} from '../../domain/interfaces/services.interface';
import {
  IMarketDataProvider,
  PriceUpdateData,
} from '../../domain/interfaces/market-data-provider.interface';

/**
 * Composite Gateway that manages multiple market data providers
 * and aggregates data from all active sources
 */
@Injectable()
export class MarketDataGatewayService implements IMarketDataGateway {
  private readonly logger = new Logger('MarketDataGateway');
  private providers: IMarketDataProvider[] = [];
  private isConnected = false;

  constructor(
    @Inject('IDataAggregatorService')
    private readonly dataAggregator: IDataAggregatorService,
  ) {}

  /**
   * Register a market data provider
   */
  public registerProvider(provider: IMarketDataProvider): void {
    if (this.providers.some((p) => p.providerId === provider.providerId)) {
      this.logger.warn(`Provider ${provider.providerId} already registered`);
      return;
    }

    this.providers.push(provider);
    
    // Set up price update callback
    provider.onPriceUpdate((data: PriceUpdateData) => {
      this.handlePriceUpdate(data);
    });

    this.logger.info(`Registered provider: ${provider.providerId}`);
  }

  /**
   * Connect all registered providers
   */
  public async connect(): Promise<void> {
    if (this.isConnected) {
      this.logger.warn('Gateway already connected');
      return;
    }

    if (this.providers.length === 0) {
      throw new Error('No providers registered');
    }

    this.logger.info(`Connecting ${this.providers.length} providers...`);

    const results = await Promise.allSettled(
      this.providers.map((provider) => provider.connect())
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (successful === 0) {
      throw new Error('All providers failed to connect');
    }

    this.isConnected = true;
    this.logger.info(
      `Gateway connected: ${successful} successful, ${failed} failed`
    );

    // Start health monitoring
    this.startHealthMonitoring();
  }

  /**
   * Disconnect all providers
   */
  public async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    this.logger.info('Disconnecting all providers...');

    await Promise.allSettled(
      this.providers.map((provider) => provider.disconnect())
    );

    this.isConnected = false;
    this.stopHealthMonitoring();
    this.logger.info('Gateway disconnected');
  }

  /**
   * Get list of active providers
   */
  public getActiveProviders(): string[] {
    return this.providers
      .filter((p) => p.isConnected())
      .map((p) => p.providerId);
  }

  /**
   * Get health status of all providers
   */
  public getProvidersHealth(): Record<string, any> {
    const health: Record<string, any> = {};
    
    for (const provider of this.providers) {
      health[provider.providerId] = provider.getHealthStatus();
    }
    
    return health;
  }

  private handlePriceUpdate(data: PriceUpdateData): void {
    try {
      // Forward to data aggregator
      this.dataAggregator.updatePrice(data.symbol, data.price, data.timestamp);
    } catch (error) {
      this.logger.error(
        `Error processing price update from ${data.providerId}:`,
        error
      );
    }
  }

  private healthMonitorTimer: NodeJS.Timeout | null = null;

  private startHealthMonitoring(): void {
    // Log health status every 5 minutes
    this.healthMonitorTimer = setInterval(() => {
      this.logHealthStatus();
    }, 5 * 60 * 1000);
  }

  private stopHealthMonitoring(): void {
    if (this.healthMonitorTimer) {
      clearInterval(this.healthMonitorTimer);
      this.healthMonitorTimer = null;
    }
  }

  private logHealthStatus(): void {
    const health = this.getProvidersHealth();
    const active = this.getActiveProviders();

    this.logger.info(
      `Gateway Health: ${active.length}/${this.providers.length} providers active`
    );

    for (const [providerId, status] of Object.entries(health)) {
      const emoji = status.isConnected ? '✅' : '❌';
      this.logger.info(
        `${emoji} ${providerId}: ` +
        `msgs=${status.messageCount} ` +
        `errors=${status.errorCount} ` +
        `reconnects=${status.reconnectAttempts}`
      );
    }
  }
}