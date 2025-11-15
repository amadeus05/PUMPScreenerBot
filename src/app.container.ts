import { DIContainer } from './shared/container';
import { SignalRepository } from './infrastructure/repositories/signal.repository';
import { SymbolMetadataRepository } from './infrastructure/repositories/symbol-metadata.repository';
import { TriggerRepository } from './infrastructure/repositories/trigger.repository';
import { UptimeService } from './infrastructure/services/uptime.service';

import { DataAggregatorService } from './infrastructure/services/data-aggregator.service';
import { NotificationService } from './infrastructure/services/notification.service';
import { TriggerEngineService } from './infrastructure/services/trigger-engine.service';

import { TelegramBotService } from './infrastructure/telegram/telegram.bot';
import { CommandHandler } from './presentation/telegram/handlers/command.handler';
import { SignalHandler } from './presentation/telegram/handlers/signal.handler';
import { PumpScoutBot } from './app';

import { CreateTriggerUseCase } from './application/use-cases/create-trigger.use-case';
import { GetTriggersUseCase } from './application/use-cases/get-triggers.use-case';
import { RemoveTriggerUseCase } from './application/use-cases/remove-trigger.use-case';
import {
  IDataAggregatorService,
  ITriggerEngineService,
} from './domain/interfaces/services.interface';

// Import market data providers
import { MarketDataGatewayService } from './infrastructure/market-data/market-data-gateway.service';
import { BinanceMarketDataProvider } from './infrastructure/market-data/providers/binance.provider';
import { BybitMarketDataProvider } from './infrastructure/market-data/providers/bybit.provider';
import { OKXMarketDataProvider } from './infrastructure/market-data/providers/okx.provider';
import {
  IMarketDataProvider,
  MarketType,
  ProviderConfig,
} from './domain/interfaces/market-data-provider.interface';
import { Logger } from './shared/logger';

const logger = new Logger('DependencyContainer');

export function registerDependencies(): void {
  const container = DIContainer.getInstance();

  // --- Register Repositories ---
  container.bind('ITriggerRepository', () => new TriggerRepository());
  container.bind('ISignalRepository', () => new SignalRepository());
  container.bind('ISymbolMetadataRepository', () => new SymbolMetadataRepository());

  // --- Register Use Cases ---
  container.bind(
    CreateTriggerUseCase,
    () => new CreateTriggerUseCase(container.get('ITriggerRepository')),
  );
  container.bind(
    GetTriggersUseCase,
    () => new GetTriggersUseCase(container.get('ITriggerRepository')),
  );
  container.bind(
    RemoveTriggerUseCase,
    () => new RemoveTriggerUseCase(container.get('ITriggerRepository')),
  );

  // --- Register Core Services & Handlers ---
  container.bind(UptimeService, () => new UptimeService());
  container.bind('IDataAggregatorService', () => new DataAggregatorService());

  // --- Configure Market Data Providers ---
  const providerConfigs = parseProviderConfigs();
  const marketDataGateway = new MarketDataGatewayService(container.get('IDataAggregatorService'));

  // Register all configured providers
  for (const config of providerConfigs) {
    const provider = createProvider(config);
    if (provider) {
      marketDataGateway.registerProvider(provider);
      logger.info(`✅ Enabled: ${config.exchange}-${config.marketType}`);
    } else {
      logger.warn(`⚠️ Unknown provider: ${config.exchange}`);
    }
  }

  if (providerConfigs.length === 0) {
    logger.warn('⚠️ No providers configured, using default: binance-spot');
    const defaultProvider = new BinanceMarketDataProvider('spot');
    marketDataGateway.registerProvider(defaultProvider);
  }

  container.bind('IMarketDataGateway', () => marketDataGateway);

  // --- Register Telegram Services ---
  container.bind(
    TelegramBotService,
    () => new TelegramBotService(process.env.TELEGRAM_BOT_TOKEN || ''),
  );
  container.bind(
    SignalHandler,
    () => new SignalHandler(container.get(TelegramBotService), container.get('ISignalRepository')),
  );
  container.bind(
    'INotificationService',
    () => new NotificationService(container.get(SignalHandler), container.get('ISignalRepository')),
  );

  container.bind(
    'ITriggerEngineService',
    () =>
      new TriggerEngineService(
        container.get('ITriggerRepository'),
        container.get('IDataAggregatorService'),
        container.get('INotificationService'),
        container.get(UptimeService),
      ),
  );

  const triggerEngine = container.get('ITriggerEngineService') as ITriggerEngineService;
  const dataAggregator = container.get('IDataAggregatorService') as IDataAggregatorService;
  dataAggregator.setTriggerEngine(triggerEngine);

  // --- Register Telegram Command Handler ---
  container.bind(
    CommandHandler,
    () =>
      new CommandHandler(
        container.get(TelegramBotService),
        container.get(CreateTriggerUseCase),
        container.get(GetTriggersUseCase),
        container.get(RemoveTriggerUseCase),
        container.get(UptimeService),
      ),
  );

  // --- Register Main App ---
  container.bind(
    PumpScoutBot,
    () =>
      new PumpScoutBot(
        container.get('IMarketDataGateway'),
        container.get('ITriggerEngineService'),
        container.get(TelegramBotService),
        container.get('ITriggerRepository'),
        container.get(CommandHandler),
      ),
  );
}

/**
 * Parse provider configurations from environment variables
 *
 * Supported formats:
 * 1. MARKET_DATA_PROVIDERS=binance,bybit,okx
 *    MARKET_TYPE=spot (or futures)
 *    → All exchanges use the same market type
 *
 * 2. BINANCE_MARKET_TYPE=futures
 *    BYBIT_MARKET_TYPE=spot
 *    OKX_MARKET_TYPE=futures
 *    → Each exchange has its own market type
 *
 * 3. MARKET_DATA_PROVIDERS=binance:futures,bybit:spot,okx:futures
 *    → Inline configuration (highest priority)
 */
function parseProviderConfigs(): ProviderConfig[] {
  const configs: ProviderConfig[] = [];

  // Get enabled exchanges
  const providersEnv = process.env.MARKET_DATA_PROVIDERS || '';

  if (!providersEnv) {
    // No configuration, return empty (will use default)
    return configs;
  }

  const providers = providersEnv
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  // Global market type (fallback)
  const globalMarketType = (process.env.MARKET_TYPE?.toLowerCase() || 'spot') as MarketType;

  for (const provider of providers) {
    // Check if inline format: "binance:futures"
    if (provider.includes(':')) {
      const [exchange, marketType] = provider.split(':');

      if (!isValidMarketType(marketType)) {
        logger.warn(`Invalid market type "${marketType}" for ${exchange}, using spot`);
        configs.push({ exchange: exchange.trim(), marketType: 'spot' });
      } else {
        configs.push({
          exchange: exchange.trim(),
          marketType: marketType.trim() as MarketType,
        });
      }
      continue;
    }

    // Check for exchange-specific env var: BINANCE_MARKET_TYPE
    const exchangeUpperCase = provider.toUpperCase();
    const specificMarketType = process.env[`${exchangeUpperCase}_MARKET_TYPE`]?.toLowerCase();

    if (specificMarketType && isValidMarketType(specificMarketType)) {
      configs.push({
        exchange: provider,
        marketType: specificMarketType as MarketType,
      });
    } else {
      // Use global market type
      configs.push({
        exchange: provider,
        marketType: globalMarketType,
      });
    }
  }

  return configs;
}

/**
 * Validate market type string
 */
function isValidMarketType(type: string): boolean {
  return type === 'spot' || type === 'futures';
}

/**
 * Factory function to create provider instances based on configuration
 */
function createProvider(config: ProviderConfig): IMarketDataProvider | null {
  const { exchange, marketType } = config;

  switch (exchange) {
    case 'binance':
      return new BinanceMarketDataProvider(marketType);

    case 'bybit':
      return new BybitMarketDataProvider(marketType);

    case 'okx':
      return new OKXMarketDataProvider(marketType);

    default:
      return null;
  }
}
