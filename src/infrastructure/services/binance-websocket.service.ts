import WebSocket from 'ws';
import { Inject, Injectable } from '../../shared/decorators';
import {
  IMarketDataGateway,
  IDataAggregatorService,
} from '../../domain/interfaces/services.interface';
import { Logger } from '../../shared/logger';

const FUTURES_STREAM_URL = 'wss://fstream.binance.com/ws/!miniTicker@arr';
const RECONNECT_DELAY = 5000;

// Описываем интерфейс входящего сообщения от Binance MiniTicker
// Документация: https://binance-docs.github.io/apidocs/futures/en/#individual-symbol-mini-ticker-streams
interface IBinanceMiniTicker {
  e: string; // Event type (например, "24hrMiniTicker")
  E: number; // Event time
  s: string; // Symbol (например, "BTCUSDT")
  c: string; // Close price (Внимание: приходит как строка!)
  o: string; // Open price
  h: string; // High price
  l: string; // Low price
  v: string; // Total traded base asset volume
  q: string; // Total traded quote asset volume
}

@Injectable()
export class BinanceWebSocketService implements IMarketDataGateway {
  private readonly logger = new Logger(BinanceWebSocketService.name);
  private futuresWs: WebSocket | null = null;
  private isConnected = false;
  private isReconnecting = false;
  private messageCount = 0;

  constructor(
    @Inject('IDataAggregatorService')
    private readonly dataAggregator: IDataAggregatorService,
  ) {}

  public async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      await this.connectToFuturesStream();
      this.isConnected = true;
      this.logger.info('WebSocket connection established (Futures)');
    } catch (error: unknown) {
      // Типизируем ошибку как unknown и приводим к строке или Error при логировании
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to establish WebSocket connection: ${errorMessage}`);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnected = false;
    if (this.futuresWs) {
      this.futuresWs.close();
      this.futuresWs = null;
    }
    this.logger.info('WebSocket connection closed');
  }

  private async connectToFuturesStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.futuresWs = new WebSocket(FUTURES_STREAM_URL);

      this.futuresWs.on('open', () => {
        this.logger.info('Futures WebSocket connection opened');
        resolve();
      });

      this.futuresWs.on('message', (data: WebSocket.Data) => {
        try {
          // Явное приведение типа после парсинга
          const parsedData = JSON.parse(data.toString());
          
          // Проверка, что это массив (так как мы слушаем @arr стрим)
          if (Array.isArray(parsedData)) {
            // Утверждаем тип как массив тикеров
            this.handleMessages(parsedData as IBinanceMiniTicker[]);
          }
        } catch (error: unknown) {
           const errorMessage = error instanceof Error ? error.message : String(error);
           this.logger.error(`Error parsing WebSocket message: ${errorMessage}`);
        }
      });

      this.futuresWs.on('error', (error: Error) => {
        this.logger.error(`WebSocket error: ${error.message}`);
        reject(error);
      });

      this.futuresWs.on('close', () => {
        this.logger.warn('WebSocket closed');
        this.handleReconnection();
      });
    });
  }

  // Аргумент теперь строго типизирован
  private handleMessages(messages: IBinanceMiniTicker[]): void {
    for (const message of messages) {
      try {
        const symbol = message.s;

        // Фильтрация только USDT пар
        if (!symbol.endsWith('USDT')) continue;

        // Преобразование строки в число
        const price = parseFloat(message.c);
        const timestamp = message.E;

        // Проверка на NaN и валидность данных
        if (symbol && !isNaN(price) && price > 0) {
          this.messageCount = (this.messageCount || 0) + 1;
          
          if (this.messageCount % 1000 === 0) {
            this.logger.debug(
              `📈 Processed ${this.messageCount} futures price updates, active symbols: ${this.dataAggregator.getAllKnownSymbols().length}`,
            );
          }

          this.dataAggregator.updatePrice(symbol, price, timestamp);
        }
      } catch (error: unknown) {
         // В цикле лучше не спамить логами, но если нужно - используем debug
         // const errorMessage = error instanceof Error ? error.message : String(error);
         // this.logger.debug(`Error processing specific message: ${errorMessage}`);
      }
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.isReconnecting || !this.isConnected) return;

    this.isReconnecting = true;
    this.logger.info('Reconnecting to Futures...');

    await this.disconnect();
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));

    try {
      await this.connect();
      this.isReconnecting = false;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Reconnection failed: ${errorMessage}`);
      
      this.isReconnecting = false;
      // Рекурсивный вызов с задержкой через setTimeout чтобы не переполнить стек, 
      // но в данном паттерне async/await это допустимо, если есть внешний контроль
      this.handleReconnection();
    }
  }
}