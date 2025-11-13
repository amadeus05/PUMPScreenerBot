import { Direction } from '@domain/types/direction.type';
import { IsIn, IsInt, IsNumber, IsPositive, Max, Min } from 'class-validator';

export class CreateTriggerDto {
  userId!: number;

  @IsIn(['up', 'down'])
  direction!: Direction;

  @IsNumber({}, { message: 'Процент изменения цены должен быть числом' })
  @IsPositive({ message: 'Процент изменения цены должен быть положительным' })
  @Min(0.1)
  @Max(100)
  priceChangePercent!: number; // Changed from oiChangePercent

  @IsInt({ message: 'Интервал должен быть целым числом' })
  @IsPositive({ message: 'Интервал должен быть положительным' })
  @Min(1)
  @Max(30)
  timeIntervalMinutes!: number;

  @IsInt({ message: 'Лимит уведомлений должен быть целым числом' })
  @IsPositive({ message: 'Лимит уведомлений должен быть положительным' })
  @Min(10)
  notificationLimitSeconds!: number;
}
