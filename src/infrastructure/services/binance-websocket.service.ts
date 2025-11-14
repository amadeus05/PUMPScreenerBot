import WebSocket from 'ws';
import { Inject, Injectable } from '../../shared/decorators';
import {
  IMarketDataGateway,
  IDataAggregatorService,
} from '../../domain/interfaces/services.interface';
import { Logger } from '../../shared/logger';

const SPOT_STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const RECONNECT_DELAY = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;
const HEARTBEAT_INTERVAL = 30000;

interface BinanceTickerMessage {
  e: string; // Event type
  E: number; // Event time
  s: string; // Symbol
  c: string; // Close price
  o: string; // Open price
  h: string; // High price
  l: string; // Low price
  v: string; // Base asset volume
  q: string; // Quote asset volume
}

@Injectable()
export class BinanceWebSocketService implements IMarketDataGateway {
  private readonly logger = new Logger(BinanceWebSocketService.name);
  private spotWs: WebSocket | null = null;
  private isConnected = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastMessageTime = Date.now();
  
  private messageCount = 0;
  private errorCount = 0;
  private lastErrorReset = Date.now();

  constructor(
    @Inject('IDataAggregatorService')
    private readonly dataAggregator: IDataAggregatorService,
  ) {}

  public async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      await this.connectToSpotStream();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.logger.info('WebSocket connection established');
    } catch (error) {
      this.logger.error('Failed to establish WebSocket connection:', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnected = false;
    this.stopHeartbeat();
    
    if (this.spotWs) {
      this.spotWs.close();
      this.spotWs = null;
    }
    
    this.logger.info('WebSocket connection closed');
  }

  private async connectToSpotStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.spotWs = new WebSocket(SPOT_STREAM_URL);

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
        if (this.spotWs) {
          this.spotWs.terminate();
        }
      }, 10000);

      this.spotWs.on('open', () => {
        clearTimeout(timeout);
        this.logger.info('Spot WebSocket connection opened');
        this.lastMessageTime = Date.now();
        resolve();
      });

      this.spotWs.on('message', (data: WebSocket.Data) => {
        this.lastMessageTime = Date.now();
        this.handleMessage(data);
      });

      this.spotWs.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error('WebSocket error:', error);
        this.errorCount++;
        reject(error);
      });

      this.spotWs.on('close', (code, reason) => {
        clearTimeout(timeout);
        this.logger.warn(`WebSocket closed: code=${code}, reason=${reason}`);
        this.handleReconnection();
      });

      this.spotWs.on('ping', () => {
        this.spotWs?.pong();
      });
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const raw = data.toString();
      
      if (!raw || raw.length === 0) {
        this.logger.debug('Received empty message');
        return;
      }

      let messages: BinanceTickerMessage[];
      
      try {
        messages = JSON.parse(raw);
      } catch (parseError) {
        this.logger.error('Failed to parse WebSocket message:', parseError);
        this.errorCount++;
        return;
      }

      if (!Array.isArray(messages)) {
        this.logger.warn('Received non-array message');
        return;
      }

      this.handleSpotMessages(messages);
      
      if (Date.now() - this.lastErrorReset > 60000) {
        this.errorCount = 0;
        this.lastErrorReset = Date.now();
      }
    } catch (error) {
      this.logger.error('Error handling WebSocket message:', error);
      this.errorCount++;
      
      if (this.errorCount > 10) {
        this.logger.error('Too many errors, reconnecting...');
        this.handleReconnection();
      }
    }
  }

  private handleSpotMessages(messages: BinanceTickerMessage[]): void {
    let validCount = 0;
    let invalidCount = 0;

    for (const message of messages) {
      try {
        if (!this.isValidMessage(message)) {
          invalidCount++;
          continue;
        }

        const symbol = message.s;
        
        if (!symbol.endsWith('USDT')) {
          continue;
        }

        const price = parseFloat(message.c);
        const timestamp = message.E;

        if (!Number.isFinite(price) || price <= 0) {
          this.logger.debug(`Invalid price for ${symbol}: ${message.c}`);
          invalidCount++;
          continue;
        }

        if (!Number.isFinite(timestamp) || timestamp <= 0) {
          this.logger.debug(`Invalid timestamp for ${symbol}: ${message.E}`);
          invalidCount++;
          continue;
        }

        this.dataAggregator.updatePrice(symbol, price, timestamp);
        validCount++;

        this.messageCount++;
        if (this.messageCount % 1000 === 0) {
          const symbols = this.dataAggregator.getAllKnownSymbols();
          this.logger.debug(
            `📈 Processed ${this.messageCount} updates, ` +
            `${symbols.length} active symbols, ` +
            `errors: ${this.errorCount}`
          );
        }
      } catch (error) {
        this.logger.debug('Error processing message:', error);
        invalidCount++;
      }
    }

    if (invalidCount > validCount * 0.1 && invalidCount > 10) {
      this.logger.warn(
        `High invalid message rate: ${invalidCount}/${validCount + invalidCount}`
      );
    }
  }

  private isValidMessage(message: any): message is BinanceTickerMessage {
    return (
      message &&
      typeof message === 'object' &&
      typeof message.s === 'string' &&
      message.s.length > 0 &&
      typeof message.c === 'string' &&
      typeof message.E === 'number'
    );
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const timeSinceLastMessage = Date.now() - this.lastMessageTime;
      
      if (timeSinceLastMessage > HEARTBEAT_INTERVAL * 2) {
        this.logger.warn(
          `No messages for ${(timeSinceLastMessage / 1000).toFixed(0)}s, reconnecting...`
        );
        this.handleReconnection();
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.isReconnecting || !this.isConnected) return;

    this.isReconnecting = true;
    this.reconnectAttempts++;

    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.logger.error('Max reconnection attempts reached, giving up');
      this.isConnected = false;
      this.isReconnecting = false;
      return;
    }

    const delay = Math.min(
      RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      60000
    );

    this.logger.info(
      `Reconnecting (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${delay}ms...`
    );

    await this.disconnect();
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.connect();
      this.isReconnecting = false;
      this.logger.info('Reconnection successful');
    } catch (error) {
      this.logger.error('Reconnection failed:', error);
      this.isReconnecting = false;
      this.handleReconnection();
    }
  }
}