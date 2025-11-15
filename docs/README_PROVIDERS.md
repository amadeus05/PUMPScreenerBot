# Market Data Providers Configuration

## Overview

The bot supports multiple cryptocurrency exchange data sources simultaneously:
- **Binance** (Spot market)
- **Bybit** (Spot market v5)
- **OKX** (Spot market v5)

You can use one or multiple exchanges at the same time for redundancy and data aggregation.

---

## Configuration

### Single Exchange (Default)
```bash
MARKET_DATA_PROVIDERS=binance
```

### Multiple Exchanges
```bash
# Use Binance and Bybit together
MARKET_DATA_PROVIDERS=binance,bybit

# Use all three exchanges
MARKET_DATA_PROVIDERS=binance,bybit,okx
```

---

## How It Works

### Data Flow
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Binance   │────▶│             │     │             │
│  WebSocket  │     │   Gateway   │────▶│ Aggregator  │
└─────────────┘     │   Service   │     │  Service    │
                    │             │     └─────────────┘
┌─────────────┐     │             │            │
│    Bybit    │────▶│             │            ▼
│  WebSocket  │     │             │     ┌─────────────┐
└─────────────┘     │             │     │   Trigger   │
                    │             │     │   Engine    │
┌─────────────┐     │             │     └─────────────┘
│     OKX     │────▶│             │
│  WebSocket  │     │             │
└─────────────┘     └─────────────┘
```

### Key Features

1. **Automatic Reconnection**: Each provider handles reconnections independently
2. **Health Monitoring**: Real-time status tracking for each exchange
3. **Data Deduplication**: Aggregator handles price updates from multiple sources
4. **Fallback Support**: If one exchange fails, others continue working
5. **Performance**: Each provider runs in parallel without blocking

---

## Provider Details

### Binance

- **WebSocket URL**: `wss://stream.binance.com:9443/ws/!miniTicker@arr`
- **Stream Type**: All USDT pairs (automatic)
- **Update Frequency**: Real-time (< 1s)
- **Reconnection**: Automatic with 5s delay
- **Notes**: Most liquid exchange, recommended as primary source

### Bybit

- **WebSocket URL**: `wss://stream.bybit.com/v5/public/spot`
- **Stream Type**: Subscription-based (tickers)
- **Update Frequency**: Real-time
- **Reconnection**: Automatic with 5s delay
- **Ping Interval**: 20s (required)
- **Notes**: Requires explicit symbol subscription

### OKX

- **WebSocket URL**: `wss://ws.okx.com:8443/ws/v5/public`
- **Stream Type**: Subscription-based (tickers)
- **Update Frequency**: Real-time
- **Reconnection**: Automatic with 5s delay
- **Ping Interval**: 25s (required)
- **Symbol Format**: Uses dashes (BTC-USDT)
- **Notes**: High-quality data, good redundancy option

---

## Use Cases

### Single Exchange (Lowest Latency)
```bash
MARKET_DATA_PROVIDERS=binance
```

**Pros:**
- Simplest configuration
- Lowest latency
- Minimal resource usage

**Cons:**
- Single point of failure
- No data redundancy

---

### Dual Exchange (Recommended)
```bash
MARKET_DATA_PROVIDERS=binance,bybit
```

**Pros:**
- Redundancy: If Binance goes down, Bybit continues
- Data validation: Compare prices across exchanges
- Better uptime

**Cons:**
- Slightly higher resource usage
- More network connections

---

### Triple Exchange (Maximum Reliability)
```bash
MARKET_DATA_PROVIDERS=binance,bybit,okx
```

**Pros:**
- Maximum redundancy
- Best for production environments
- Cross-exchange arbitrage detection possible

**Cons:**
- Higher resource usage (3x WebSocket connections)
- More complex monitoring

---

## Monitoring

### Health Check Command
```bash
# In Telegram bot
/uptime
```

Shows:
- Number of active providers
- Connection status
- Message counts
- Error statistics

### Logs
```bash
# Gateway logs show provider status
[MarketDataGateway] Gateway Health: 2/2 providers active
[MarketDataGateway] ✅ binance: msgs=12450 errors=0 reconnects=0
[MarketDataGateway] ✅ bybit: msgs=8730 errors=0 reconnects=0
```

---

## Troubleshooting

### Provider Not Connecting

**Check logs:**
```bash
tail -f combined-*.log | grep "Provider"
```

**Common issues:**
1. Invalid exchange name in ENV (must be lowercase)
2. Network firewall blocking WebSocket
3. Exchange API maintenance

**Solution:**
- Remove problematic provider from `MARKET_DATA_PROVIDERS`
- Bot will continue with remaining providers

### High Error Count
```bash
[BybitProvider] WebSocket error: Connection timeout
```

**Possible causes:**
1. Network instability
2. Exchange rate limiting
3. Invalid subscription

**Solution:**
- Providers automatically reconnect
- Check exchange status page
- Reduce number of active providers

### Missing Price Updates

**Check:**
1. Are any providers connected?
2. Are symbols filtered correctly? (USDT pairs only)
3. Check aggregator logs for data flow

---

## Performance Considerations

### Memory Usage

Each provider adds approximately:
- **5-10 MB** baseline memory
- **0.5 MB per 1000 symbols** tracked

### Network Usage

Each provider consumes:
- **Binance**: ~50 KB/s (all symbols stream)
- **Bybit**: ~10-20 KB/s (subscription-based)
- **OKX**: ~10-20 KB/s (subscription-based)

### CPU Usage

Negligible impact (< 1% per provider)

---

## Adding New Providers

To add support for other exchanges:

1. Create new provider file:
```typescript
src/infrastructure/market-data/providers/new-exchange.provider.ts
```

2. Implement `IMarketDataProvider` interface

3. Register in factory:
```typescript
// app.container.ts
case 'newexchange':
  return new NewExchangeMarketDataProvider();
```

4. Update documentation

---

## Best Practices

1. **Start with one provider** (binance) and test thoroughly
2. **Add second provider** (bybit) for redundancy in production
3. **Monitor health status** regularly via logs and `/uptime`
4. **Use environment-specific configs**:
   - Development: 1 provider
   - Staging: 2 providers
   - Production: 2-3 providers
5. **Set up alerts** for connection failures

---

## FAQ

**Q: Can I mix spot and futures data?**  
A: No, currently only spot USDT pairs are supported.

**Q: Will duplicate data from multiple exchanges cause duplicate alerts?**  
A: No, the aggregator deduplicates by symbol. Latest price from any source is used.

**Q: Which exchange should I use as primary?**  
A: Binance is recommended for highest liquidity and reliability.

**Q: Can I add/remove providers without restarting?**  
A: No, provider configuration requires bot restart.

**Q: Do all providers need to connect for the bot to start?**  
A: No, at least one provider must connect successfully. Others can fail and bot continues.