# 📊 Configuration Guide

Basic Configuration (Required)

envTELEGRAM_BOT_TOKEN=your_token_here
LOG_LEVEL=info
Performance Tuning (Optional)
env# For high-load systems (many triggers)
MAX_CONCURRENT_CHECKS=10
MIN_CHECK_INTERVAL_MS=2000

# For low-resource systems

MAX_CONCURRENT_CHECKS=3
MIN_CHECK_INTERVAL_MS=500
Memory Management
env# Adjust based on available RAM
MAX_RAW_POINTS=2000      # ~5MB per 100 symbols
MAX_DATA_AGE_MINUTES=60  # Keep last hour

# 🎮 Bot Commands

User Commands

/start          - Welcome message & help
/add            - Create new trigger
/my_triggers    - View your triggers
/uptime         - Bot status & uptime
/status         - Alias for /uptime
Trigger Creation
/add [direction] [percent] [interval] [cooldown]

Examples:

/add up 5 15 60      # Alert on 5% increase over 15 minutes
/add down 3 10 120   # Alert on 3% decrease over 10 minutes

# 🔍 Monitoring

Health Check Logs

bash# Look for these in logs every 5 minutes
🏥 Health Check: 5 triggers, 150 symbols, 0 pending, uptime: 2h 15m

# WebSocket stats every 1000 messages

📈 Processed 1000 updates, 150 active symbols, errors: 0

# Notification stats every 5 minutes

📊 Notification Stats (last 5m): Sent: 23, Cooldown hits: 7

Performance Metrics

bash# Check with system tools
htop           # CPU & Memory
netstat -an    # Network connections
du -h *.sqlite # Database size

# 🐛 Troubleshooting

Issue: High Memory Usage
Symptoms: Memory growing over time
Solution:
envMAX_RAW_POINTS=1000
MAX_DATA_AGE_MINUTES=30
CLEANUP_INTERVAL_MS=15000
Issue: Slow Trigger Processing
Symptoms: Delayed notifications
Solution:
envMAX_CONCURRENT_CHECKS=10
MIN_CHECK_INTERVAL_MS=500
Issue: WebSocket Disconnections
Symptoms: Frequent reconnections in logs
Solution:
envWS_RECONNECT_DELAY=10000
MAX_RECONNECT_ATTEMPTS=10
HEARTBEAT_INTERVAL=60000
Issue: Database Locked
Symptoms: "Database is locked" errors
Solution:

Only one bot instance per database file
Check for zombie processes: ps aux | grep node

# 📈 Production Deployment

Using PM2

bash# Install PM2
npm install -g pm2

# Start bot
pm2 start npm --name "pump-scout-bot" -- run start

# Monitor
pm2 monit

# Logs
pm2 logs pump-scout-bot

# Restart
pm2 restart pump-scout-bot

# Auto-restart on system boot
pm2 startup
pm2 save

# 🔒 Security Considerations
API Token Security

Never commit .env file
Use environment-specific tokens
Rotate tokens regularly

Database Security

Backup regularly
Use file permissions (chmod 600)
Consider encryption at rest

Rate Limiting

Telegram: Built-in rate limiting
Binance: 3 RPS limit implemented
User notifications: Configurable cooldown

# 🚧 Known Limitations

SQLite Concurrency: Single-writer only
WebSocket Reconnects: Max 5 attempts before manual restart
Trigger Limit: No hard limit, but recommended <100 per user
Symbol Limit: Automatically tracks all USDT pairs (~150)

# 🔮 Future Enhancements

Multiple exchange support (Bybit, OKX)
Advanced signal filtering (volume, RSI)
Web dashboard for monitoring
Backtesting framework
Multi-user management system
API for external integrations