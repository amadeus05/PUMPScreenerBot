import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';

@Injectable()
export class UptimeService {
  private readonly logger = new Logger(UptimeService.name);
  private readonly startTime = Date.now();

  public getUptime(): string {
    const uptimeMs = Date.now() - this.startTime;
    const seconds = Math.floor(uptimeMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  public getStartTime(): number {
    return this.startTime;
  }
}
