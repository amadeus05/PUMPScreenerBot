import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('symbol_metadata')
export class SymbolMetadata {
  @PrimaryColumn({ type: 'varchar' })
  symbol!: string;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  baseVolume!: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  quoteVolume!: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  openInterest!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
