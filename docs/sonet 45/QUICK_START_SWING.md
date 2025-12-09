# ⚡ Быстрый старт: Swing Detection

## 🎯 Что это?

**Swing Low → Swing High Detector** - правильный pump-алгоритм, который детектирует движения цены от локальных минимумов к максимумам (и наоборот).

## 🚀 Быстрая настройка

### Шаг 1: Добавьте в ваш `.env` файл:

```bash
# Базовая настройка (рекомендуется)
SWING_LOOKBACK=2
MIN_MOVEMENT_DURATION_MS=30000
CONFIRMATION_POINTS=2
USE_CLOSE_CONFIRMATION=true
```

### Шаг 2: Всё! Бот готов к работе

## 📊 Что делает каждый параметр?

### `SWING_LOOKBACK` (по умолчанию: 2)
Сколько свечей проверять для подтверждения экстремума
- **1** = Агрессивно (много точек, быстрая реакция)
- **2** = Сбалансированно (рекомендуется)
- **3** = Консервативно (только явные экстремумы)

### `MIN_MOVEMENT_DURATION_MS` (по умолчанию: 30000)
Минимальная длительность движения в миллисекундах
- **15000** = 15 секунд (для быстрых движений)
- **30000** = 30 секунд (рекомендуется)
- **60000** = 1 минута (для медленных трендов)

### `CONFIRMATION_POINTS` (по умолчанию: 2)
Сколько точек должны подтвердить движение
- **0** = Без подтверждения
- **1** = Минимальное
- **2-3** = Строгое (рекомендуется)

### `USE_CLOSE_CONFIRMATION` (по умолчанию: true)
Требовать подтверждение движения
- **true** = Да (рекомендуется)
- **false** = Нет (детектирует всё)

## 🎛️ Готовые профили

### 💚 Консервативный (минимум ложных срабатываний)
```bash
SWING_LOOKBACK=3
MIN_MOVEMENT_DURATION_MS=60000
CONFIRMATION_POINTS=3
USE_CLOSE_CONFIRMATION=true
```

### 💙 Сбалансированный (рекомендуется)
```bash
SWING_LOOKBACK=2
MIN_MOVEMENT_DURATION_MS=30000
CONFIRMATION_POINTS=2
USE_CLOSE_CONFIRMATION=true
```

### 💛 Агрессивный (максимум чувствительности)
```bash
SWING_LOOKBACK=1
MIN_MOVEMENT_DURATION_MS=15000
CONFIRMATION_POINTS=1
USE_CLOSE_CONFIRMATION=true
```

## ✅ Что детектирует

- ✅ Реальные pump движения (от минимума к максимуму)
- ✅ Реальные dump движения (от максимума к минимуму)
- ✅ Устойчивые тренды с подтверждением
- ✅ Значимые ценовые движения

## ❌ Что фильтрует

- ❌ Хвостики свечей (wicks)
- ❌ Кратковременные всплески
- ❌ Фейковые скачки без подтверждения
- ❌ Шум и случайные колебания

## 🔍 Проверка работы

### 1. Включите DEBUG режим:
```bash
DEBUG=true
```

### 2. Смотрите логи:
```
✅ BTCUSDT 5m -> 2.341234% (up:2.341234% down:0%)
Swing detection: 3 lows, 5 highs
```

### 3. Используйте методы мониторинга:
```typescript
// Визуализация бакетов
dataAggregator.visualizeBuckets('BTCUSDT');

// Статистика здоровья
const stats = dataAggregator.getHealthStats();
console.log('Warmup rejects:', stats.warmupRejects);
console.log('Fallbacks used:', stats.fallbacksUsed);

// Проверка покрытия
const health = dataAggregator.getBucketHealth('BTCUSDT', 40);
console.log('Coverage:', health.coveragePercent + '%');
```

## 📈 Пример реального движения

```
График показывает рост +4.11% за 32 минуты

Настройки:
SWING_LOOKBACK=2
MIN_MOVEMENT_DURATION_MS=30000

Результат:
✅ Swing Low обнаружен в начале роста
✅ Swing High обнаружен на пике
✅ Длительность: 32 минуты (> 30 секунд)
✅ Движение подтверждено последующими свечами
✅ Триггер сработает!
```

## 🆘 Частые вопросы

### Бот не детектирует движения?
- Увеличьте `SWING_LOOKBACK` до 1
- Уменьшите `MIN_MOVEMENT_DURATION_MS`
- Уменьшите `CONFIRMATION_POINTS`

### Слишком много ложных срабатываний?
- Увеличьте `SWING_LOOKBACK` до 3
- Увеличьте `MIN_MOVEMENT_DURATION_MS`
- Увеличьте `CONFIRMATION_POINTS`

### Бот детектирует слишком поздно?
- Уменьшите `SWING_LOOKBACK` до 1
- Уменьшите `CONFIRMATION_POINTS` до 1

## 📚 Дополнительная информация

- **Подробное объяснение:** `SWING_DETECTION_EXPLAINED.md`
- **Все настройки:** `ANTI_FAKE_SPIKE_SETTINGS.md`
- **Примеры конфигураций:** `env.anti-fake-spike.example`

## 🎉 Готово!

Ваш бот теперь использует **правильный pump-алгоритм** с профессиональным Swing Detection! 🚀

