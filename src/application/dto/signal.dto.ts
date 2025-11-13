export type SignalQuality = 'strong' | 'medium' | 'weak';

export class SignalDto {
  constructor(
    public readonly signalNumber: number,
    public readonly symbol: string,
    public readonly priceChangePercent: number,
    public readonly currentPrice: number,
    public readonly previousPrice: number, // NEW: track where it came from
    public readonly timestamp: Date,
    public readonly quality: SignalQuality,
    public readonly triggerIntervalMinutes?: number,
  ) {}
}
