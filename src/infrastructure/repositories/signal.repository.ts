import { Repository } from 'typeorm';
import { Injectable } from '../../shared/decorators';
import { AppDataSource } from '../database/database.module';
import { Signal } from '../../domain/entities/signal.entity';
import { ISignalRepository } from '../../domain/interfaces/repositories.interface';

@Injectable()
export class SignalRepository implements ISignalRepository {
  private repository: Repository<Signal>;

  constructor() {
    this.repository = AppDataSource.getRepository(Signal);
  }

  async getLast24HoursSignalCount(userId: number): Promise<number> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.repository
      .createQueryBuilder('signal')
      .where('signal.createdAt >= :date', { date: twentyFourHoursAgo })
      // .andWhere('signal.userId = :userId', { userId }) // TODO: раскомментировать позже
      .getCount();
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
      .orderBy('signal.createdAt', 'DESC') // Добавил сортировку, чтобы свежие были первыми
      .getMany();
  }

  async getLast24HoursSignalCountBySymbol(userId: number, symbol: string): Promise<number> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.repository
      .createQueryBuilder('signal')
      .where('signal.symbol = :symbol', { symbol })
      .andWhere('signal.createdAt >= :date', { date: twentyFourHoursAgo })
      // .andWhere('signal.userId = :userId', { userId }) // TODO
      .getCount();
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

  // OPTIMIZED: Агрегация на стороне БД
  async getSignalStats(userId: number): Promise<{
    total24h: number;
    bySymbol: Map<string, number>;
    topSymbols: Array<{ symbol: string; count: number }>;
  }> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 1. Получаем сгруппированную статистику одним запросом
    // SQL аналог: SELECT symbol, COUNT(*) as cnt FROM signal WHERE ... GROUP BY symbol
    const rawStats = await this.repository
      .createQueryBuilder('signal')
      .select('signal.symbol', 'symbol')
      .addSelect('COUNT(signal.id)', 'cnt') // Считаем количество ID
      .where('signal.createdAt >= :date', { date: twentyFourHoursAgo })
      .groupBy('signal.symbol')
      .getRawMany(); 
      // getRawMany вернет массив объектов вида: [{ symbol: 'BTCUSDT', cnt: '15' }, ...]

    // 2. Преобразуем данные для возврата (mapping)
    let total24h = 0;
    const bySymbol = new Map<string, number>();

    const formattedStats = rawStats.map((item) => {
      // TypeORM часто возвращает COUNT как строку, поэтому нужно parseInt
      const count = parseInt(item.cnt, 10);
      const symbol = item.symbol;

      total24h += count;
      bySymbol.set(symbol, count);

      return { symbol, count };
    });

    // 3. Сортируем для topSymbols (если БД не сортировала)
    const topSymbols = formattedStats
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total24h,
      bySymbol,
      topSymbols,
    };
  }
}