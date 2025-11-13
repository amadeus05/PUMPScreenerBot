import { Inject, Injectable } from '../../shared/decorators';
import { ITriggerRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { CreateTriggerDto } from '../dto/create-trigger.dto';

@Injectable()
export class CreateTriggerUseCase {
  constructor(
    @Inject('ITriggerRepository')
    private readonly triggerRepository: ITriggerRepository,
  ) {}

  public async execute(dto: CreateTriggerDto): Promise<Trigger> {
    // Здесь можно добавить бизнес-логику, например, проверку,
    // не превысил ли пользователь лимит на количество триггеров.
    return this.triggerRepository.save(dto);
  }
}
