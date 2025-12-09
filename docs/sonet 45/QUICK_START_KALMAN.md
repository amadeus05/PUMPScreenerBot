# ⚡ Быстрый старт: Kalman Filter

## 🚀 Что это?

**Kalman Filter** - алгоритм из навигации ракет для детектирования движений цены **без задержки** и с автоматической фильтрацией спайков.

## 🎯 Главное преимущество

**НУЛЕВАЯ ЗАДЕРЖКА** vs Swing Detection (2-3 свечи) и Moving Average (5-20 свечей)

## ⚡ За 30 секунд

### Шаг 1: Добавьте в `.env`:

```bash
USE_KALMAN_FILTER=true
```

### Шаг 2: Всё! 🎉

Kalman работает с дефолтными настройками.

## 🎛️ Дефолтные настройки

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.01        # умеренная изменчивость
KALMAN_MEASUREMENT_NOISE=0.1     # стандартный шум
KALMAN_SPIKE_THRESHOLD=3.0       # 99.7% данных нормальны
MIN_MOVEMENT_DURATION_MS=30000   # 30 секунд минимум
```

## 🎮 Готовые профили

### 💚 BTC/ETH (волатильные)

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.05
KALMAN_MEASUREMENT_NOISE=0.15
KALMAN_SPIKE_THRESHOLD=2.5
MIN_MOVEMENT_DURATION_MS=15000
```

### 💙 Альткоины (низкая ликвидность)

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.1
KALMAN_MEASUREMENT_NOISE=0.5
KALMAN_SPIKE_THRESHOLD=2.0
MIN_MOVEMENT_DURATION_MS=30000
```

### 💛 Скальпинг (быстрые движения)

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.02
KALMAN_MEASUREMENT_NOISE=0.1
KALMAN_SPIKE_THRESHOLD=3.0
MIN_MOVEMENT_DURATION_MS=10000
```

## ✅ Что детектирует

- ✅ Реальные движения цены **мгновенно** (zero-lag)
- ✅ Монотонные тренды (без откатов)
- ✅ Быстрые pumps/dumps
- ✅ Автоматически адаптируется к рынку

## ❌ Что фильтрует

- ❌ Спайки и выбросы (автоматически)
- ❌ Хвостики свечей
- ❌ Краткосрочный шум
- ❌ Ложные движения

## 🔍 Проверка работы

### 1. Включите DEBUG:

```bash
DEBUG=true
```

### 2. Смотрите логи:

```
Kalman spike detected: innovation=12.345678, threshold=3.456789
✅ BTCUSDT 5m -> 2.341234% (up:2.341234% down:0%)
Health: ... kalmanSpikes=15 kalmanFilters=42
```

### 3. Статистика:

```typescript
const stats = dataAggregator.getHealthStats();
console.log('Spikes filtered:', stats.kalmanSpikesFiltered);
console.log('Active filters:', stats.kalmanActiveFilters);
```

## 🆚 Когда использовать

### ✅ Используйте Kalman если:

- Нужна минимальная задержка
- Торгуете на быстрых таймфреймах (1-5 мин)
- Цена часто движется монотонно
- Важна каждая секунда

### ❌ Используйте Swing если:

- Нужна максимальная точность
- Торгуете на средних/длинных таймфреймах (15+ мин)
- Хотите следовать структуре рынка
- Нужна работа "из коробки"

## 🔧 Тонкая настройка (опционально)

### Слишком много спайков пропускается?

```bash
KALMAN_SPIKE_THRESHOLD=2.0  # строже (было 3.0)
```

### Пропускает быстрые движения?

```bash
KALMAN_PROCESS_NOISE=0.05  # выше (было 0.01)
```

### Слишком много фильтрует?

```bash
KALMAN_MEASUREMENT_NOISE=0.2  # выше (было 0.1)
```

## 📊 Пример на вашем графике

**Движение:** +4.11% за 32 минуты

**С Kalman:**

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.02
KALMAN_MEASUREMENT_NOISE=0.1
KALMAN_SPIKE_THRESHOLD=3.0
MIN_MOVEMENT_DURATION_MS=30000
```

**Результат:**

```
✅ Детектирует: +4.11% (мгновенно, без задержки)
✅ Фильтрует: все спайки и хвостики
✅ Задержка: 0 свечей (vs 2-3 у Swing)
```

## 🆘 Частые вопросы

### Как переключиться обратно на Swing?

```bash
USE_KALMAN_FILTER=false
```

### Можно ли использовать оба?

Нет, только один режим активен. Выберите:
- `USE_KALMAN_FILTER=true` → Kalman (zero-lag)
- `USE_KALMAN_FILTER=false` → Swing (структурный)

### Какой режим лучше?

Зависит от стратегии:
- **Kalman** = скорость + монотонные тренды
- **Swing** = точность + структура рынка

Попробуйте оба и выберите по результатам!

## 📚 Дополнительная информация

- **Полное руководство:** `KALMAN_FILTER_GUIDE.md`
- **Примеры конфигураций:** `env.anti-fake-spike.example`
- **Swing Detection:** `SWING_DETECTION_EXPLAINED.md`

## 🚀 Готово!

Ваш бот теперь использует **алгоритмы из навигации космических кораблей** для детектирования движений цены! 🛸

**Zero-lag. Rocket science. Production-ready.** 💯

