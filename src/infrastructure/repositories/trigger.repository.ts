import { Repository } from 'typeorm';
import { Injectable } from '../../shared/decorators';
import { AppDataSource } from '../database/database.module';
import { Trigger } from '../../domain/entities/trigger.entity';
import { ITriggerRepository } from '../../domain/interfaces/repositories.interface';
import { CreateTriggerDto } from '../../application/dto/create-trigger.dto';

@Injectable()
export class TriggerRepository implements ITriggerRepository {
  private readonly repository: Repository<Trigger>;
  private activeTriggersCache: Trigger[] = [];

  constructor() {
    this.repository = AppDataSource.getRepository(Trigger);
  }

  public async init(): Promise<void> {
    await this.loadTriggersIntoCache();
  }

  public getAllActive(): Trigger[] {
    return this.activeTriggersCache;
  }

  public async findByUserId(userId: number): Promise<Trigger[]> {
    return this.repository.find({ where: { userId, isActive: true } });
  }

  public async save(dto: CreateTriggerDto): Promise<Trigger> {
    const newTrigger = this.repository.create(dto);
    const savedTrigger = await this.repository.save(newTrigger);

    // Немедленно обновляем кэш, чтобы триггер начал работать без перезапуска
    this.activeTriggersCache.push(savedTrigger);

    return savedTrigger;
  }

  public async remove(id: number, userId: number): Promise<boolean> {
    const result = await this.repository.delete({ id, userId });

    if (result.affected && result.affected > 0) {
      // Удаляем из кэша
      this.activeTriggersCache = this.activeTriggersCache.filter((t) => t.id !== id);
      return true;
    }
    return false;
  }

  private async loadTriggersIntoCache(): Promise<void> {
    this.activeTriggersCache = await this.repository.find({
      where: { isActive: true },
    });
  }
}
