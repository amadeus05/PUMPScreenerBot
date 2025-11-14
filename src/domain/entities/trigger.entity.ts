import { Direction } from '@domain/types/direction.type';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('triggers')
export class Trigger {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ name: 'user_id', type: 'integer' })
  userId!: number;

  @Column({ type: 'text' })
  direction!: Direction;

  @Column({ name: 'price_change_percent', type: 'decimal', precision: 10, scale: 4 })
  priceChangePercent!: number;

  @Column({ name: 'time_interval_minutes', type: 'integer' })
  timeIntervalMinutes!: number;

  @Column({ name: 'notification_limit_seconds', type: 'integer' })
  notificationLimitSeconds!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}