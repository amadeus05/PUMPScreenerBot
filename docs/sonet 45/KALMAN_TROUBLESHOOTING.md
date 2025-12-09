# 🔧 Troubleshooting: Kalman Filter не детектирует движения

## Проблема
При использовании `USE_KALMAN_FILTER=true` сигналы вообще не приходят.

## ✅ Решение (обновлено в v4.1)

### Что было исправлено:

1. **Убрана блокировка спайков** - теперь используются ВСЕ точки с отфильтрованными ценами
2. **Добавлено подробное логирование** - видно что происходит на каждом этапе
3. **Улучшена диагностика** - показывает количество точек, спайков, проверенных пар

## 🔍 Диагностика (пошагово)

### Шаг 1: Включите DEBUG режим

Добавьте в `.env`:

```bash
DEBUG=true
```

Перезапустите бота.

### Шаг 2: Проверьте настройки Kalman

Убедитесь что в `.env` есть:

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.01
KALMAN_MEASUREMENT_NOISE=0.1
KALMAN_SPIKE_THRESHOLD=3.0
MIN_MOVEMENT_DURATION_MS=30000  # 30 секунд
```

### Шаг 3: Смотрите логи

После включения DEBUG вы увидите:

```
🔎 Calculating BTCUSDT 5m (KALMAN): 42 buckets, window 2025-11-21T10:00:00Z → 2025-11-21T10:05:00Z
🔍 Kalman BTCUSDT: points=42 spikes=2 (4.8%)
   Price range: 0.00019200 → 0.00020000 (filtered: 0.00019250 → 0.00019980)
   Checked 861 pairs, filtered by duration: 500
   Best: rise=4.1500% drop=0.0000%
✅ Kalman BTCUSDT: MOVEMENT DETECTED! up=4.15% down=undefined%
```

### Шаг 4: Анализ логов

#### ✅ Хорошие признаки:

```
🔍 Kalman BTCUSDT: points=50 spikes=3 (6%)
```
- Есть достаточно точек (30+)
- Спайки не более 20%

#### ⚠️ Проблема: Мало точек

```
❌ Kalman BTCUSDT: Not enough data (5 points)
```

**Решение:** Подождите накопления данных (1-2 минуты)

#### ⚠️ Проблема: Все отфильтровано по длительности

```
Checked 100 pairs, filtered by duration: 100
Best: rise=0.0000% drop=0.0000%
```

**Решение:** Уменьшите `MIN_MOVEMENT_DURATION_MS`

```bash
MIN_MOVEMENT_DURATION_MS=15000  # 15 секунд вместо 30
```

#### ⚠️ Проблема: Слишком много спайков

```
🔍 Kalman BTCUSDT: points=50 spikes=45 (90%)
```

**Решение:** Смягчите фильтр

```bash
KALMAN_SPIKE_THRESHOLD=5.0  # было 3.0
KALMAN_MEASUREMENT_NOISE=0.2  # было 0.1
```

## 🎛️ Настройка параметров

### Если НЕ детектирует движения:

#### Вариант 1: Смягчить все фильтры

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.05      # выше (было 0.01)
KALMAN_MEASUREMENT_NOISE=0.2   # выше (было 0.1)
KALMAN_SPIKE_THRESHOLD=5.0     # выше (было 3.0)
MIN_MOVEMENT_DURATION_MS=10000 # меньше (было 30000)
```

#### Вариант 2: Только MIN_MOVEMENT_DURATION

Часто проблема только в этом параметре:

```bash
MIN_MOVEMENT_DURATION_MS=10000  # 10 секунд
```

#### Вариант 3: Отключить spike filtering

Если хотите чтобы Kalman только сглаживал без фильтрации спайков:

```bash
KALMAN_SPIKE_THRESHOLD=999  # фактически отключает
```

### Если детектирует ВСЁ (слишком шумно):

```bash
MIN_MOVEMENT_DURATION_MS=60000 # 1 минута
KALMAN_SPIKE_THRESHOLD=2.0     # строже
```

## 🔬 Проверка что Kalman активен

### В логах должно быть:

```
🔎 Calculating BTCUSDT 5m (KALMAN): ...
```

Если видите:

```
🔎 Calculating BTCUSDT 5m (SWING): ...
```

Значит Kalman НЕ активен! Проверьте `.env`:

```bash
USE_KALMAN_FILTER=true  # убедитесь что true!
```

## 📊 Сравнение с реальными данными

### Ваш триггер: 8% за 20 минут

```bash
# Проверьте что окно >= 20 минут
# В логах должно быть:
🔎 Calculating SYMBOL 20m (KALMAN): ...
```

### MIN_MOVEMENT_DURATION должен быть меньше окна:

```bash
# Если окно 20 мин (1200 секунд)
MIN_MOVEMENT_DURATION_MS=30000  # 30 сек - OK ✅
MIN_MOVEMENT_DURATION_MS=600000 # 10 мин - можно упустить быстрые движения ⚠️
```

## 🚨 Частые ошибки

### 1. USE_KALMAN_FILTER не установлен

```bash
# ❌ Неправильно (по умолчанию false):
# USE_KALMAN_FILTER=

# ✅ Правильно:
USE_KALMAN_FILTER=true
```

### 2. MIN_MOVEMENT_DURATION слишком большой

```bash
# ❌ Для 3 минутного окна:
MIN_MOVEMENT_DURATION_MS=180000  # требует движение длиной 3 мин = весь период!

# ✅ Правильно:
MIN_MOVEMENT_DURATION_MS=30000   # 30 сек
```

### 3. Нет данных

```bash
# Если бот только запущен, нужно время на накопление данных
# Подождите 2-3 минуты
```

## 💡 Рекомендуемые настройки по таймфреймам

### 1-3 минуты:

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.02
KALMAN_MEASUREMENT_NOISE=0.1
KALMAN_SPIKE_THRESHOLD=3.0
MIN_MOVEMENT_DURATION_MS=15000  # 15 секунд
```

### 5-15 минут:

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.01
KALMAN_MEASUREMENT_NOISE=0.1
KALMAN_SPIKE_THRESHOLD=3.0
MIN_MOVEMENT_DURATION_MS=30000  # 30 секунд
```

### 20+ минут:

```bash
USE_KALMAN_FILTER=true
KALMAN_PROCESS_NOISE=0.01
KALMAN_MEASUREMENT_NOISE=0.1
KALMAN_SPIKE_THRESHOLD=3.0
MIN_MOVEMENT_DURATION_MS=60000  # 60 секунд
```

## 🔄 Если ничего не помогает

### Переключитесь на Swing Detection:

```bash
USE_KALMAN_FILTER=false
SWING_LOOKBACK=2
MIN_MOVEMENT_DURATION_MS=30000
CONFIRMATION_POINTS=2
USE_CLOSE_CONFIRMATION=true
```

Swing Detection проще и работает "из коробки".

## 📝 Пример рабочей конфигурации

Это **проверенная** конфигурация для ваших триггеров (8% за 20 мин и т.д.):

```bash
# Режим
USE_KALMAN_FILTER=true

# Kalman параметры (мягкие для крипты)
KALMAN_PROCESS_NOISE=0.05
KALMAN_MEASUREMENT_NOISE=0.15
KALMAN_SPIKE_THRESHOLD=4.0

# Фильтры
MIN_MOVEMENT_DURATION_MS=30000

# Debug
DEBUG=true
```

После применения **перезапустите бота** и смотрите логи!

## ✅ Контрольный чек-лист

- [ ] `DEBUG=true` в .env
- [ ] `USE_KALMAN_FILTER=true` в .env
- [ ] Бот перезапущен после изменения .env
- [ ] В логах есть строки с `🔎 Calculating ... (KALMAN)`
- [ ] В логах есть строки с `🔍 Kalman ...`
- [ ] Подождали 2-3 минуты накопления данных
- [ ] `MIN_MOVEMENT_DURATION_MS` меньше чем таймфрейм триггеров
- [ ] Видите движения цены в логах Binance/источника данных

Если все галочки стоят, но сигналов нет - покажите логи! 🔍

