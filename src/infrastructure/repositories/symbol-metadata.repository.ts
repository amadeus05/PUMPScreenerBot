import { Repository } from 'typeorm';
import { Injectable } from '../../shared/decorators';
import { AppDataSource } from '../database/database.module';
import { SymbolMetadata } from '../../domain/entities/symbol-metadata.entity';
import { ISymbolMetadataRepository } from '../../domain/interfaces/repositories.interface';

@Injectable()
export class SymbolMetadataRepository implements ISymbolMetadataRepository {
  private repository: Repository<SymbolMetadata>;

  constructor() {
    this.repository = AppDataSource.getRepository(SymbolMetadata);
  }

  async findAllActive(): Promise<SymbolMetadata[]> {
    return this.repository.find({ where: { isActive: true } });
  }

  async findBySymbol(symbol: string): Promise<SymbolMetadata | null> {
    return this.repository.findOne({ where: { symbol } });
  }

  async save(metadata: SymbolMetadata): Promise<SymbolMetadata> {
    return this.repository.save(metadata);
  }

  async updateActiveSymbols(symbols: string[]): Promise<void> {
    // Фильтруем только USDT пары
    const usdtSymbols = symbols.filter((symbol) => symbol.endsWith('USDT'));

    await this.repository
      .createQueryBuilder()
      .update(SymbolMetadata)
      .set({ isActive: false })
      .where('symbol NOT IN (:...symbols)', { symbols: usdtSymbols })
      .execute();

    for (const symbol of usdtSymbols) {
      const existing = await this.findBySymbol(symbol);
      if (!existing) {
        const metadata = new SymbolMetadata();
        metadata.symbol = symbol;
        metadata.isActive = true;
        await this.save(metadata);
      } else if (!existing.isActive) {
        existing.isActive = true;
        await this.save(existing);
      }
    }
  }
}
