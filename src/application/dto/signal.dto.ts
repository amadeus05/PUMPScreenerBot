// ✅ REMOVED: SignalQuality type - not needed anymore
// export type SignalQuality = 'strong' | 'medium' | 'weak';

export class SignalDto {
  constructor(
    public readonly signalNumber: number,
    public readonly symbol: string,
    public readonly priceChangePercent: number,
    public readonly currentPrice: number,
    public readonly previousPrice: number,
    public readonly timestamp: Date,
    public readonly triggerIntervalMinutes?: number,
  ) {}
}