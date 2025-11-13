import { Inject, Injectable } from '../../shared/decorators';
import { ITriggerRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';

@Injectable()
export class GetTriggersUseCase {
  constructor(
    @Inject('ITriggerRepository')
    private readonly triggerRepository: ITriggerRepository,
  ) {}

  public async execute(userId: number): Promise<Trigger[]> {
    return this.triggerRepository.findByUserId(userId);
  }
}
