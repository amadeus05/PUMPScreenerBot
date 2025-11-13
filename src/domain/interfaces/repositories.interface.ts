// src/domain/interfaces/repositories.interface.ts

import { Signal } from '../entities/signal.entity';
import { SymbolMetadata } from '../entities/symbol-metadata.entity';
import { Trigger } from '../entities/trigger.entity';
import { CreateTriggerDto } from '../../application/dto/create-trigger.dto';

export interface ITriggerRepository {
  init(): Promise<void>;
  getAllActive(): Trigger[];
  findByUserId(userId: number): Promise<Trigger[]>;
  save(dto: CreateTriggerDto): Promise<Trigger>;
  remove(id: number, userId: number): Promise<boolean>;
}

export interface ISignalRepository {
  getLast24HoursSignalCount(userId: number): Promise<number>;
  getLast24HoursSignalCountByTriggerAndSymbol(triggerId: number, symbol: string): Promise<number>;
  getLast24HoursSignalCountBySymbol(userId: number, symbol: string): Promise<number>;
  save(signal: Signal): Promise<Signal>;
  findRecentBySymbol(symbol: string, hours: number): Promise<Signal[]>;
}

export interface ISymbolMetadataRepository {
  findAllActive(): Promise<SymbolMetadata[]>;
  findBySymbol(symbol: string): Promise<SymbolMetadata | null>;
  save(metadata: SymbolMetadata): Promise<SymbolMetadata>;
  updateActiveSymbols(symbols: string[]): Promise<void>;
}
