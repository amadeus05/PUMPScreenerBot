import WebSocket from 'ws';
import { Inject, Injectable } from '../../shared/decorators';
import {
  IMarketDataGateway,
  IDataAggregatorService,
} from '../../domain/interfaces/services.interface';
import { Logger } from '../../shared/logger';

const SPOT_STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const RECONNECT_DELAY = 5000;

@Injectable()
export class BinanceWebSocketService implements IMarketDataGateway {
  private readonly logger = new Logger(BinanceWebSocketService.name);
  private spotWs: WebSocket | null = null;
  private isConnected = false;
  private isReconnecting = false;

  // ADD: Missing property for message counting
  private messageCount = 0;

  constructor(
    @Inject('IDataAggregatorService')
    private readonly dataAggregator: IDataAggregatorService,
  ) {}

  public async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      await this.connectToSpotStream();
      this.isConnected = true;
      this.logger.info('WebSocket connection established');
    } catch (error) {
      this.logger.error('Failed to establish WebSocket connection:', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnected = false;
    if (this.spotWs) {
      this.spotWs.close();
      this.spotWs = null;
    }
    this.logger.info('WebSocket connection closed');
  }

  private async connectToSpotStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.spotWs = new WebSocket(SPOT_STREAM_URL);

      this.spotWs.on('open', () => {
        this.logger.info('Spot WebSocket connection opened');
        resolve();
      });

      this.spotWs.on('message', (data: WebSocket.Data) => {
        try {
          const messages = JSON.parse(data.toString());
          this.handleSpotMessages(messages);
        } catch (error) {
          this.logger.error('Error parsing WebSocket message:', error);
        }
      });

      this.spotWs.on('error', (error) => {
        this.logger.error('WebSocket error:', error);
        reject(error);
      });

      this.spotWs.on('close', () => {
        this.logger.warn('WebSocket closed');
        this.handleReconnection();
      });
    });
  }

  private handleSpotMessages(messages: any[]): void {
    for (const message of messages) {
      try {
        const symbol = message.s;

        if (!symbol.endsWith('USDT')) continue;

        const price = parseFloat(message.c);
        const timestamp = message.E;

        if (symbol && price > 0) {
          // ADD: Periodic status log (every 1000 messages to avoid spam)
          this.messageCount = (this.messageCount || 0) + 1;
          if (this.messageCount % 1000 === 0) {
            this.logger.debug(
              `📈 Processed ${this.messageCount} price updates, active symbols: ${this.dataAggregator.getAllKnownSymbols().length}`,
            );
          }

          this.dataAggregator.updatePrice(symbol, price, timestamp);
        }
      } catch (error) {
        this.logger.debug('Error processing message:', error);
      }
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.isReconnecting || !this.isConnected) return;

    this.isReconnecting = true;
    this.logger.info('Reconnecting...');

    await this.disconnect();
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));

    try {
      await this.connect();
      this.isReconnecting = false;
    } catch (error) {
      this.logger.error('Reconnection failed:', error);
      this.isReconnecting = false;
      this.handleReconnection();
    }
  }
}
