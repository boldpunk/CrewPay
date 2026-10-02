import { describe, expect, it } from 'vitest';
import regJson from '../public/regulation.json';
import { availableAircraft, calculateMonth, findPosition } from '../src/calc/engine';
import { num, parseHours } from '../src/calc/format';
import { paymentSchedule } from '../src/calc/paydates';
import { DEFAULT_SETTINGS, type PeriodInput, type Regulation, type Settings } from '../src/calc/types';

const reg = regJson as Regulation;
const A319 = 0;
const A320 = 1;
const A330 = 2;
const B757 = 3;
const B767 = 4;

function pilot(overrides: Partial<PeriodInput> = {}): PeriodInput {
  return {
    category: 'pilot',
    positionId: 'pilot-instructor',
    aircraft: A320,
    hours: 60,
    nightHours: 20,
    holidayHours: 0,
    nightHolidayHours: 0,
    deadheadHours: 0,
    worked: 22,
    statusId: 'full',
    salary: 0,
    rate: 1_050_000,
    ...overrides,
  };
}

function cabin(overrides: Partial<PeriodInput> = {}): PeriodInput {
  return pilot({ category: 'cabin', positionId: 'fa', aircraft: -1, rate: 220_000, ...overrides });
}

function run(p: PeriodInput, settings: Settings = DEFAULT_SETTINGS, norm = 22) {
  return calculateMonth(reg, settings, { norm, periods: [p] });
}

function amounts(p: PeriodInput, settings?: Settings) {
  const r = run(p, settings);
  expect(r.errors).toEqual([]);
  return Object.fromEntries(r.periods[0].lines.map((l) => [l.ref, l.amount]));
}

describe('Контрольные примеры ТЗ (раздел 6) — приёмочные тесты', () => {
  it('Бортпроводник-инструктор, 60 ч / 20 ночь → 20 482 000', () => {
    const a = amounts(cabin({ positionId: 'fa-instructor' }));
    expect(a['п. 3.7']).toBe(17_556_000);
    expect(a['п. 3.8']).toBe(2_926_000);
    expect(run(cabin({ positionId: 'fa-instructor' })).total).toBe(20_482_000);
  });

  it('Бортпроводник-бригадир, 60 ч / 20 ночь → 17 402 000', () => {
    const a = amounts(cabin({ positionId: 'fa-purser' }));
    expect(a['п. 3.7']).toBe(14_916_000);
    expect(a['п. 3.8']).toBe(2_486_000);
    expect(run(cabin({ positionId: 'fa-purser' })).total).toBe(17_402_000);
  });

  it('Пилот-инструктор, A-320, 60 ч / 20 ночь → 63 787 500', () => {
    const a = amounts(pilot());
    expect(a['п. 2.6']).toBe(55_282_500);
    expect(a['п. 2.8']).toBeUndefined();
    expect(a['п. 2.10']).toBe(8_505_000);
    expect(run(pilot()).total).toBe(63_787_500);
  });

  it('Пилот-инструктор, A-319, 60 ч / 20 ночь → 69 300 000', () => {
    const a = amounts(pilot({ aircraft: A319 }));
    expect(a['п. 2.6']).toBe(60_060_000);
    expect(a['п. 2.10']).toBe(9_240_000);
    expect(run(pilot({ aircraft: A319 })).total).toBe(69_300_000);
  });

  it('Пилот-инструктор, A-320, 90 ч / 20 ночь → 103 425 000', () => {
    const a = amounts(pilot({ hours: 90 }));
    expect(a['п. 2.6']).toBe(55_282_500);
    expect(a['п. 2.8']).toBe(39_637_500);
    expect(a['п. 2.10']).toBe(8_505_000);
    expect(run(pilot({ hours: 90 })).total).toBe(103_425_000);
  });

  it('КВС с допуском тренировок, A-320, 60 ч / 20 ночь → 43 890 000', () => {
    const p = pilot({ positionId: 'captain-training' });
    const a = amounts(p);
    expect(a['п. 2.6']).toBe(21_000_000);
    expect(a['п. 2.8']).toBe(18_690_000);
    expect(a['п. 2.10']).toBe(4_200_000);
    expect(run(p).total).toBe(43_890_000);
  });
});

describe('ЧЛЭ с гарантированным налётом', () => {
  it('свыше 94,5 ч: ×2,0 заменяет оплату сверх гарантии (по умолчанию)', () => {
    const a = amounts(pilot({ positionId: 'captain', hours: 100, nightHours: 0 }));
    // S=1 050 000, k1=0,37, k5=1,68, G=50
    expect(a['п. 2.6']).toBe(1_050_000 * 0.37 * 50);
    expect(a['п. 2.8']).toBeCloseTo(1_050_000 * 1.68 * 44.5, 4);
    expect(a['п. 2.12']).toBeCloseTo(1_050_000 * 2 * 1.68 * 5.5, 4);
  });

  it('свыше 94,5 ч: режим «доплата поверх»', () => {
    const a = amounts(pilot({ positionId: 'captain', hours: 100, nightHours: 0 }), {
      ...DEFAULT_SETTINGS,
      over94Mode: 'additive',
    });
    expect(a['п. 2.8']).toBeCloseTo(1_050_000 * 1.68 * 50, 4);
    expect(a['п. 2.12']).toBeCloseTo(1_050_000 * 2 * 1.68 * 5.5, 4);
  });

  it('ровно 94,5 ч — без доплаты п. 2.12', () => {
    const a = amounts(pilot({ hours: 94.5, nightHours: 0 }));
    expect(a['п. 2.12']).toBeUndefined();
    expect(a['п. 2.8']).toBeCloseTo(1_050_000 * 1.51 * 29.5, 4);
  });

  it('праздничные часы — доплата ×1 по коэф. табл. 2-1; ночь в праздник исключается из ночных', () => {
    const a = amounts(pilot({ hours: 60, nightHours: 20, holidayHours: 10, nightHolidayHours: 4 }));
    expect(a['п. 2.10']).toBeCloseTo(1_050_000 * 0.81 * 0.5 * 16, 4);
    expect(a['п. 2.11']).toBeCloseTo(1_050_000 * 0.81 * 10, 4);
  });

  it('гарантия пропорциональна отработанному времени', () => {
    const r = run(pilot({ hours: 40, nightHours: 0, worked: 11 }));
    expect(r.periods[0].lines[0].amount).toBeCloseTo(1_050_000 * 0.81 * 32.5, 4);
  });

  it('статус «до допуска» ×0,5 и «до 1000 ч» ×0,75', () => {
    expect(run(pilot({ statusId: 'before' })).total).toBe(Math.round(63_787_500 * 0.5));
    expect(run(pilot({ statusId: 'under1000' })).total).toBe(Math.round(63_787_500 * 0.75));
  });

  it('налёт 0 ч — сдельная часть 0 (п. 4.2), оклад платится', () => {
    const r = run(pilot({ hours: 0, nightHours: 0, salary: 5_000_000 }));
    expect(r.piece).toBe(0);
    expect(r.time).toBe(5_000_000);
    expect(r.total).toBe(5_000_000);
  });

  it('прочерк в табл. 2-1 — ошибка', () => {
    const r = run(pilot({ positionId: 'captain', aircraft: A319 }));
    expect(r.errors.length).toBe(1);
    expect(r.total).toBe(0);
  });

  it('пилот-инструктор на B-757: прочерк в 2-5 — гарантия платится, сверх гарантии нет, предупреждение', () => {
    const r = run(pilot({ aircraft: B757, hours: 80, nightHours: 0 }));
    expect(r.errors).toEqual([]);
    expect(r.periods[0].lines.map((l) => l.ref)).toEqual(['п. 2.6']);
    expect(r.warnings.length).toBe(1);
  });

  it('доступные типы ВС фильтруются по прочеркам', () => {
    expect(availableAircraft(reg, findPosition(reg, 'pilot', 'pilot-examiner'))).toEqual([A330, B767]);
    expect(availableAircraft(reg, findPosition(reg, 'pilot', 'pilot-instructor'))).toEqual([0, 1, 2, 3, 4]);
    expect(availableAircraft(reg, findPosition(reg, 'pilot', 'technical-pilot'))).toEqual([A320, A330, B767]);
  });
});

describe('ЧЛЭ с нормативным налётом (п. 2.7)', () => {
  it('норматив выполнен → S × 3,34 × 20', () => {
    const r = run(pilot({ positionId: 'pilot-inspector', hours: 25, nightHours: 10, holidayHours: 5 }));
    expect(r.periods[0].lines.filter((l) => l.part === 'piece').map((l) => l.amount)).toEqual([
      1_050_000 * 3.34 * 20,
    ]);
  });

  it('норматив не выполнен → 0 и предупреждение', () => {
    const r = run(pilot({ positionId: 'pilot-inspector', hours: 19.9, nightHours: 0 }));
    expect(r.piece).toBe(0);
    expect(r.warnings.length).toBe(1);
  });

  it('норматив пропорционален отработанному времени', () => {
    const r = run(pilot({ positionId: 'technical-pilot', hours: 10, nightHours: 0, worked: 11 }));
    expect(r.piece).toBeCloseTo(1_050_000 * 3.34 * 10, 4);
  });
});

describe('ЧКЭ', () => {
  it('ступени 70 / 100 ч и санитарная норма', () => {
    const a = amounts(cabin({ hours: 110, nightHours: 0 }));
    expect(a['п. 3.7']).toBe(220_000 * 70);
    expect(a['п. 3.7.1']).toBeCloseTo(220_000 * 0.65 * 30, 4);
    expect(a['п. 3.10']).toBeCloseTo(220_000 * 2 * 10, 4);
  });

  it('должности п. 3.2 — сдельная часть 0, предупреждение при налёте > 30 ч', () => {
    const r = run(cabin({ positionId: 'fa-methodist', hours: 35, nightHours: 0, salary: 4_000_000 }));
    expect(r.piece).toBe(0);
    expect(r.total).toBe(4_000_000);
    expect(r.warnings.length).toBe(1);
  });

  it('предупреждение МРОТ до допуска', () => {
    const r = run(cabin({ statusId: 'before', hours: 5, nightHours: 0 }));
    expect(r.total).toBe(550_000);
    expect(r.warnings.some((w) => w.includes('МРОТ'))).toBe(true);
  });
});

describe('Валидации', () => {
  it('N + F − (ночь в праздник) ≤ H', () => {
    expect(run(pilot({ hours: 10, nightHours: 6, holidayHours: 6 })).errors.length).toBeGreaterThan(0);
    expect(run(pilot({ hours: 10, nightHours: 6, holidayHours: 6, nightHolidayHours: 2 })).errors).toEqual([]);
  });

  it('отработано > нормы — ошибка', () => {
    expect(run(pilot({ worked: 23 })).errors.length).toBe(1);
  });

  it('перевод в течение месяца (п. 2.15): сумма двух расчётов', () => {
    const r = calculateMonth(reg, DEFAULT_SETTINGS, {
      norm: 22,
      periods: [
        pilot({ positionId: 'first-officer', worked: 11, hours: 30, nightHours: 0 }),
        pilot({ positionId: 'captain', worked: 11, hours: 30, nightHours: 0 }),
      ],
    });
    expect(r.errors).toEqual([]);
    const fo = 1_050_000 * 0.14 * 25 + 1_050_000 * 1.02 * 5;
    const cpt = 1_050_000 * 0.37 * 25 + 1_050_000 * 1.68 * 5;
    expect(r.total).toBe(Math.round(fo + cpt));
  });

  it('итог — до тийинов, как в расчётном листке', () => {
    const r = run(cabin({ hours: 0.1, nightHours: 0, rate: 220_005 }));
    expect(r.periods[0].lines[0].amount).toBeCloseTo(22_000.5, 6);
    expect(r.total).toBe(22_000.5);
  });
});

describe('Форматирование и ввод', () => {
  it('разделитель тысяч — пробел', () => {
    expect(num(63_787_500)).toBe('63 787 500');
    expect(num(1234.5)).toBe('1 234,5');
  });
  it('часы: десятичные и чч:мм', () => {
    expect(parseHours('65,5')).toBe(65.5);
    expect(parseHours('65.5')).toBe(65.5);
    expect(parseHours('65:30')).toBe(65.5);
    expect(parseHours('')).toBe(0);
    expect(parseHours('abc')).toBeNaN();
  });
});

describe('Сроки выплат', () => {
  it('сентябрь 2026 → оклад 15.10 (чт), сдельная 30.10 (пт)', () => {
    const s = paymentSchedule(reg, '2026-09')!;
    expect(s.salary.toDateString()).toBe(new Date(2026, 9, 15).toDateString());
    expect(s.piece.toDateString()).toBe(new Date(2026, 9, 30).toDateString());
  });
  it('выходной переносится на канун; февраль без 30-го', () => {
    // Январь 2027 → февраль 2027: 15.02 — пн; 28.02 — вс → 26.02 (пт)
    const s = paymentSchedule(reg, '2027-01')!;
    expect(s.salary.toDateString()).toBe(new Date(2027, 1, 15).toDateString());
    expect(s.piece.toDateString()).toBe(new Date(2027, 1, 26).toDateString());
  });
});

describe('Сверка с реальным расчётным листком (август 2026, бортпроводник-инструктор)', () => {
  // Норма 25 дн., отработано 23, оклад 9 500 000; налёт 56,2 ч, ночь 0,79 ч,
  // Dead Head 6,9 ч фактически (в листке — 3,45 оплачиваемых часа, «50%»),
  // надбавка и медосмотр — суммами из листка.
  const r = calculateMonth(reg, DEFAULT_SETTINGS, {
    norm: 25,
    periods: [
      cabin({
        positionId: 'fa-instructor',
        hours: 56.2,
        nightHours: 0.79,
        deadheadHours: 6.9,
        worked: 23,
        salary: 9_500_000,
      }),
    ],
    extras: [
      { title: 'Надбавка', amount: 1_852_718.49 },
      { title: 'Медицинский осмотр', amount: 2_671_132.14 },
    ],
  });
  const byTitle = Object.fromEntries(r.periods[0].lines.map((l) => [l.title, l.amount]));

  it('построчно совпадает с листком', () => {
    expect(r.errors).toEqual([]);
    expect(byTitle['Должностной оклад']).toBe(8_740_000);
    expect(byTitle['Налёт до 70 ч']).toBe(16_444_120);
    expect(byTitle['Ночной налёт']).toBe(115_577);
    expect(byTitle['Перелёт Dead Head (50 %)']).toBe(1_009_470);
    expect(r.extras).toBe(4_523_850.63);
  });

  it('начислено, НДФЛ, ИНПС и к выплате совпадают до тийина', () => {
    expect(r.total).toBe(30_833_017.63);
    expect(r.tax).toBe(3_699_962.12);
    expect(r.inps).toBe(30_833.02);
    expect(r.net).toBe(27_133_055.51);
  });
});

describe('Dead Head и прочие начисления', () => {
  it('пилот: Dead Head по коэф. табл. 2-1 × 50 %', () => {
    const a = amounts(pilot({ deadheadHours: 4 }));
    expect(a['п. 2.13']).toBeCloseTo(1_050_000 * 0.81 * 4 * 0.5, 4);
  });
  it('норматив: Dead Head справочно', () => {
    const r = run(pilot({ positionId: 'pilot-inspector', hours: 25, nightHours: 0, deadheadHours: 4 }));
    expect(r.periods[0].lines.find((l) => l.ref === 'п. 2.13')!.amount).toBe(0);
  });
  it('отрицательная надбавка — ошибка', () => {
    const r = calculateMonth(reg, DEFAULT_SETTINGS, {
      norm: 22,
      periods: [pilot()],
      extras: [{ title: 'Надбавка', amount: -5 }],
    });
    expect(r.errors.length).toBe(1);
  });
});
