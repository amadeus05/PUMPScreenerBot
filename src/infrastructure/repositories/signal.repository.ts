import { Repository } from 'typeorm';
import { Inject, Injectable } from '../../shared/decorators';
import { AppDataSource } from '../database/database.module';
import { Signal } from '../../domain/entities/signal.entity';
import { ISignalRepository } from '../../domain/interfaces/repositories.interface';

@Injectable()
export class SignalRepository implements ISignalRepository {
  private repository: Repository<Signal>;

  constructor() {
    this.repository = AppDataSource.getRepository(Signal);
  }

  // Принимаем userId, но пока не используем, т.к. в Signal нет этого поля.
  // Это позволит остальному коду работать корректно.
  async getLast24HoursSignalCount(userId: number): Promise<number> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return (
      this.repository
        .createQueryBuilder('signal')
        .where('signal.createdAt >= :date', { date: twentyFourHoursAgo })
        // TODO: Добавить `andWhere('signal.userId = :userId', { userId })` когда поле будет добавлено
        .getCount()
    );
  }

  async save(signal: Signal): Promise<Signal> {
    return this.repository.save(signal);
  }

  async findRecentBySymbol(symbol: string, hours: number): Promise<Signal[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.repository
      .createQueryBuilder('signal')
      .where('signal.symbol = :symbol', { symbol })
      .andWhere('signal.createdAt >= :since', { since })
      .getMany();
  }

  async getLast24HoursSignalCountBySymbol(userId: number, symbol: string): Promise<number> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return (
      this.repository
        .createQueryBuilder('signal')
        .where('signal.symbol = :symbol', { symbol })
        .andWhere('signal.createdAt >= :date', { date: twentyFourHoursAgo })
        // TODO: Добавить userId когда поле будет в Signal entity
        .getCount()
    );
  }

  async getLast24HoursSignalCountByTriggerAndSymbol(
    triggerId: number,
    symbol: string,
  ): Promise<number> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.repository
      .createQueryBuilder('signal')
      .where('signal.triggerId = :triggerId', { triggerId })
      .andWhere('signal.symbol = :symbol', { symbol })
      .andWhere('signal.createdAt >= :date', { date: twentyFourHoursAgo })
      .getCount();
  }

  // NEW: Get signal statistics for debugging
  async getSignalStats(userId: number): Promise<{
    total24h: number;
    bySymbol: Map<string, number>;
    topSymbols: Array<{ symbol: string; count: number }>;
  }> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Get all signals in last 24 hours
    const signals = await this.repository
      .createQueryBuilder('signal')
      .where('signal.createdAt >= :date', { date: twentyFourHoursAgo })
      .getMany();

    // Count by symbol
    const bySymbol = new Map<string, number>();
    for (const signal of signals) {
      const count = bySymbol.get(signal.symbol) || 0;
      bySymbol.set(signal.symbol, count + 1);
    }

    // Get top symbols
    const topSymbols = Array.from(bySymbol.entries())
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total24h: signals.length,
      bySymbol,
      topSymbols,
    };
  }
}
