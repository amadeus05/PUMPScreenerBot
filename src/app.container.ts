import { DIContainer } from './shared/container';
import { SignalRepository } from './infrastructure/repositories/signal.repository';
import { SymbolMetadataRepository } from './infrastructure/repositories/symbol-metadata.repository';
import { TriggerRepository } from './infrastructure/repositories/trigger.repository';
import { UptimeService } from './infrastructure/services/uptime.service';

import { DataAggregatorService } from './infrastructure/services/data-aggregator.service';
import { BinanceWebSocketService } from './infrastructure/services/binance-websocket.service';
import { NotificationService } from './infrastructure/services/notification.service';
import { TriggerEngineService } from './infrastructure/services/trigger-engine.service';

import { BinanceApiClient } from './infrastructure/http/binance-api.client';
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
  container.bind(
    'IMarketDataGateway',
    () => new BinanceWebSocketService(container.get('IDataAggregatorService')),
  );
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
  container.bind(BinanceApiClient, () => new BinanceApiClient());

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
