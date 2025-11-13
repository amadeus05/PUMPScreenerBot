import { Inject, Injectable } from '../../shared/decorators';
import { ITriggerRepository } from '../../domain/interfaces/repositories.interface';

@Injectable()
export class RemoveTriggerUseCase {
  constructor(
    @Inject('ITriggerRepository')
    private readonly triggerRepository: ITriggerRepository,
  ) {}

  public async execute(id: number, userId: number): Promise<boolean> {
    return this.triggerRepository.remove(id, userId);
  }
}
