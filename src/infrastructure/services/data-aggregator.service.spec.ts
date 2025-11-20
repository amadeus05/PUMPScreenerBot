// data-aggregator-clean-debug.spec.ts - ЧИСТЫЙ ДЕБАГ БЕЗ ПРИВАТНЫХ МЕТОДОВ

import { DataAggregatorService } from './data-aggregator.service';

describe('DataAggregatorService — Чистый дебаг', () => {
  let service: DataAggregatorService;

  beforeEach(() => {
    process.env.DEBUG = 'true';
    process.env.MIN_TRIGGER_PERCENT = '1.0';
    process.env.MIN_BUCKET_SAMPLES = '1';
    service = new DataAggregatorService();
    
    (service as any).ensureSymbolLimit = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });


test('УНИВЕРСАЛЬНЫЙ ТЕСТ АЛГОРИТМА - ИСПРАВЛЕННЫЙ', () => {
  console.log('🎯 УНИВЕРСАЛЬНЫЙ ТЕСТ АЛГОРИТМА - ИСПРАВЛЕННЫЙ');
  
  // 1. Устанавливаем фиксированное время
  const baseTime = Date.UTC(2025, 10, 19, 12, 0, 0, 0); // 12:00:00
  jest.setSystemTime(baseTime);
  
  const now = Date.now();
  console.log('Текущее время:', new Date(now).toISOString());
  
  // 2. Создаем данные с ЗАПАСОМ по времени
  const bucketSize = 60000;
  
  // ИСПРАВЛЕНИЕ: добавляем запас в 1 минуту к возрасту данных
  const candle1Time = now - 4 * bucketSize; // 12 минут назад (было 3)
  const candle2Time = now - 3 * bucketSize; // 9 минут назад (было 2)  
  const candle3Time = now - 2 * bucketSize; // 6 минут назад (было 1)
  
  console.log('Создаем свечи с запасом:');
  console.log('Свеча 1:', new Date(candle1Time).toISOString(), '(4 минуты назад)');
  console.log('Свеча 2:', new Date(candle2Time).toISOString(), '(3 минуты назад)');
  console.log('Свеча 3:', new Date(candle3Time).toISOString(), '(2 минуты назад)');
  
  // Создаем восходящий тренд
  service.updatePrice('UNIVERSAL', 100, candle1Time + 1000);
  service.updatePrice('UNIVERSAL', 101, candle1Time + 59000);
  
  service.updatePrice('UNIVERSAL', 101, candle2Time + 1000);
  service.updatePrice('UNIVERSAL', 102, candle2Time + 59000);
  
  service.updatePrice('UNIVERSAL', 102, candle3Time + 1000);
  service.updatePrice('UNIVERSAL', 104, candle3Time + 59000);
  
  const health = service.getHealthStats();
  console.log('Health:', health);
  
  // Проверяем что данные достаточно старые
  const firstSeen = service['firstSeen'].get('UNIVERSAL')!;
  const dataAge = now - firstSeen;
  console.log(`Возраст данных: ${dataAge}ms (${Math.floor(dataAge/60000)} минут)`);
  
  const coverage = service.getBucketHealth('UNIVERSAL', 3);
  console.log('Coverage для 3 минут:', coverage);
  
  console.log('=== ВЫЗЫВАЕМ getMetricChanges ===');
  const result = service.getMetricChanges('UNIVERSAL', 3);
  console.log('🎯 РЕЗУЛЬТАТ:', result);
  
  expect(result).not.toBeNull();
  console.log('✅ ТЕСТ ПРОЙДЕН!');
});

test('ТЕСТ С 15-СЕКУНДНЫМИ БАКЕТАМИ - ИСПРАВЛЕННЫЙ', () => {
  console.log('🎯 ТЕСТ С 15-СЕКУНДНЫМИ БАКЕТАМИ - ИСПРАВЛЕННЫЙ');
  
  const baseTime = Date.UTC(2025, 10, 19, 12, 0, 0, 0);
  jest.setSystemTime(baseTime);
  
  const now = Date.now();
  const bucketSize = 15000;
  
  // ИСПРАВЛЕНИЕ: добавляем запас для 1-минутного окна
  const candle1Time = now - 5 * bucketSize; // 75 секунд назад (было 45)
  const candle2Time = now - 4 * bucketSize; // 60 секунд назад (было 30)
  const candle3Time = now - 3 * bucketSize; // 45 секунд назад (было 15)
  
  console.log('Создаем 15-секундные свечи с запасом:');
  
  service.updatePrice('FAST', 100, candle1Time + 1000);
  service.updatePrice('FAST', 102, candle1Time + 14000);
  
  service.updatePrice('FAST', 102, candle2Time + 1000);
  service.updatePrice('FAST', 104, candle2Time + 14000);
  
  service.updatePrice('FAST', 104, candle3Time + 1000);
  service.updatePrice('FAST', 106, candle3Time + 14000);
  
  const health = service.getHealthStats();
  console.log('Health:', health);
  
  // Проверяем возраст данных
  const firstSeen = service['firstSeen'].get('FAST')!;
  const dataAge = now - firstSeen;
  console.log(`Возраст данных: ${dataAge}ms (требуется > 60000ms для 1 минуты)`);
  
  const result = service.getMetricChanges('FAST', 1);
  console.log('Результат для 1 минуты:', result);
  
  expect(result).not.toBeNull();
});

test('ПРОВЕРКА ЛОГИКИ ЗАКРЫТИЯ СВЕЧЕЙ ЧЕРЕЗ ОТЛАДКУ', () => {
  console.log('🎯 ТЕСТ: Логика закрытия свечей через отладку');
  
  // Устанавливаем время
  const baseTime = Date.UTC(2025, 10, 19, 12, 0, 30, 0); // 12:00:30.000
  jest.setSystemTime(baseTime);
  
  const now = Date.now();
  console.log('Текущее время:', new Date(now).toISOString());
  
  const alignToMinute = (timestamp: number) => {
    return Math.floor(timestamp / 60000) * 60000;
  };
  
  // Создаем несколько свечей
  const candles = [
    { time: alignToMinute(now - 3 * 60000), name: '11:57-11:58', open: 100, close: 102 }, // +2%
    { time: alignToMinute(now - 2 * 60000), name: '11:58-11:59', open: 102, close: 105 }, // +2.94%
    { time: alignToMinute(now - 1 * 60000), name: '11:59-12:00', open: 105, close: 108 }, // +2.86%
  ];
  
  candles.forEach(candle => {
    const candleEnd = candle.time + 60000;
    const isClosed = candleEnd <= now;
    
    console.log(`\n${candle.name}:`);
    console.log(`  Бакет: ${new Date(candle.time).toISOString()} -> ${new Date(candleEnd).toISOString()}`);
    console.log(`  Закрыта: ${isClosed} (${candleEnd} <= ${now})`);
    
    service.updatePrice('DEBUG_TEST', candle.open, candle.time + 1000);
    service.updatePrice('DEBUG_TEST', candle.close, candle.time + 59000);
  });
  
  // Проверяем какие свечи алгоритм считает закрытыми
  console.log('\n=== ОТЛАДКА: Какие свечи алгоритм видит как закрытые ===');
  
  const map = service['buckets1m'].get('DEBUG_TEST');
  if (map) {
    const keys = map.getSortedKeys();
    const windowStart = now - 3 * 60000; // 3 минуты назад
    
    console.log(`Окно: ${new Date(windowStart).toISOString()} -> ${new Date(now).toISOString()}`);
    
    keys.forEach(key => {
      const candleEnd = key + 60000;
      const isInWindow = key >= windowStart;
      const isClosed = candleEnd <= now;
      
      console.log(`Бакет ${new Date(key).toISOString()}: inWindow=${isInWindow}, closed=${isClosed}`);
    });
  }
  
  // Проверяем результат
  console.log('\n=== РЕЗУЛЬТАТ ДЛЯ 3 МИНУТ ===');
  const result = service.getMetricChanges('DEBUG_TEST', 3);
  console.log('Результат:', result);
  
  // Все свечи закрыты, поэтому должен найти лучшее изменение
  expect(result).not.toBeNull();
  console.log('✅ Все свечи закрыты (как и ожидалось)');
});

test('ТЕСТ РЕАЛЬНОЙ НЕЗАКРЫТОЙ СВЕЧИ', () => {
  console.log('🎯 ТЕСТ: Реальная незакрытая свеча');
  
  // Создаем сервис с отключенной warmup проверкой для тестирования
  const testService = new DataAggregatorService();
  
  // Устанавливаем время ВНУТРИ свечи
  const candleStart = Date.UTC(2025, 10, 19, 11, 58, 0, 0); // 11:58:00.000
  const currentTime = candleStart + 30000; // 11:58:30.000 - ВНУТРИ свечи!
  jest.setSystemTime(currentTime);
  
  console.log('Текущее время:', new Date(currentTime).toISOString());
  
  // Создаем свечу которая СЕЙЧАС активна (незакрытая)
  const candleTime = Math.floor(currentTime / 60000) * 60000; // 11:58:00.000
  const candleEnd = candleTime + 60000; // 11:59:00.000
  
  console.log('\nСоздаем свечу:');
  console.log(`  Бакет: ${new Date(candleTime).toISOString()} -> ${new Date(candleEnd).toISOString()}`);
  console.log(`  Закрыта? ${candleEnd <= currentTime}`);
  console.log(`  Текущее время ВНУТРИ свечи!`);
  
  testService.updatePrice('REAL_OPEN_TEST', 100, candleTime + 1000);
  testService.updatePrice('REAL_OPEN_TEST', 103, candleTime + 59000); // +3%
  
  // Создаем старую закрытую свечу для контекста
  const oldCandleTime = candleTime - 2 * 60000; // 11:56:00.000
  testService.updatePrice('REAL_OPEN_TEST', 90, oldCandleTime + 1000);
  testService.updatePrice('REAL_OPEN_TEST', 91, oldCandleTime + 59000);
  
  // Вручную проверяем логику закрытия
  console.log('\n=== РУЧНАЯ ПРОВЕРКА ЛОГИКИ ===');
  const map = testService['buckets1m'].get('REAL_OPEN_TEST');
  if (map) {
    const keys = map.getSortedKeys();
    
    keys.forEach(key => {
      const b = map.get(key)!;
      const bucketEnd = key + 60000;
      const isClosed = bucketEnd <= currentTime;
      
      console.log(`Бакет ${new Date(key).toISOString()}:`);
      console.log(`  open=${b.open}, close=${b.close}, change=${(((b.close - b.open) / b.open) * 100).toFixed(2)}%`);
      console.log(`  closed=${isClosed} (${bucketEnd} <= ${currentTime})`);
    });
  }
  
  // Тестируем - незакрытая свеча должна игнорироваться
  console.log('\n=== ТЕСТИРУЕМ АЛГОРИТМ ===');
  const result = testService.getMetricChanges('REAL_OPEN_TEST', 2);
  console.log('Результат для 2 минут:', result);
  
  // Должен быть null, так как нет закрытых свечей в окне
  // (единственная свеча в окне - незакрытая)
  expect(result).toBeNull();
  
  console.log('✅ ТЕСТ ПРОЙДЕН: Незакрытая свеча игнорируется алгоритмом!');
});
});