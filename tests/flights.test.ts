import { describe, expect, it } from 'vitest';
import regJson from '../data/regulation.json';
import { type FlightForm, formatDuration, parseDuration, parseQuickLine, summarizeFlights } from '../src/calc/flights';
import type { Regulation } from '../src/calc/types';

const reg = regJson as Regulation;
let n = 0;
const f = (o: Partial<FlightForm>): FlightForm => ({
  id: String(++n),
  date: '2026-08-05',
  route: 'TAS-DXB',
  block: '',
  night: '',
  duty: '',
  dh: false,
  ...o,
});

describe('Длительности', () => {
  it('разбор и формат', () => {
    expect(parseDuration('6:00')).toBe(360);
    expect(parseDuration('3:02')).toBe(182);
    expect(parseDuration('09:42')).toBe(582);
    expect(parseDuration('6.30')).toBe(390);
    expect(parseDuration('6ч 30м')).toBe(390);
    expect(parseDuration('7')).toBe(420);
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('6:75')).toBeNaN();
    expect(parseDuration('abc')).toBeNaN();
    expect(formatDuration(3372)).toBe('56:12');
  });
});

describe('Журнал рейсов', () => {
  it('суммирует в минутах и переводит в часы один раз', () => {
    const t = summarizeFlights(reg, '2026-08', [
      f({ route: 'TAS-DXB', block: '3:02', night: '1:01', duty: '4:40' }),
      f({ route: 'DXB-TAS', block: '3:02', night: '1:01', duty: '4:40', date: '2026-08-06' }),
      f({ route: 'TAS-IST', block: '5:20', duty: '6:50', date: '2026-08-10' }),
    ]);
    expect(t.count).toBe(3);
    expect(t.flightMin).toBe(684);
    expect(t.hours).toBe(11.4);
    expect(t.nightHours).toBe(2.03);
    expect(t.dutyHours).toBe(16.17);
    expect(t.issues).toEqual([]);
  });

  it('пример: TAS-DXB 6:00, ночные 3:02, рабочее 9:42', () => {
    const t = summarizeFlights(reg, '2026-08', [f({ block: '6:00', night: '3:02', duty: '9:42' })]);
    expect(t.hours).toBe(6);
    expect(t.nightHours).toBe(3.03);
    expect(t.dutyHours).toBe(9.7);
  });

  it('рейс в праздник идёт в праздничные, его ночь — в «ночь в праздник»', () => {
    const t = summarizeFlights(reg, '2026-09', [f({ date: '2026-09-01', block: '6:00', night: '2:00' })]);
    expect(t.holidayHours).toBe(6);
    expect(t.nightHolidayHours).toBe(2);
    expect(t.holidayDates).toEqual(['2026-09-01']);
  });

  it('Dead Head не входит в налёт', () => {
    const t = summarizeFlights(reg, '2026-08', [
      f({ block: '6:00', night: '1:00' }),
      f({ route: 'DXB-TAS', block: '4:10', night: '2:00', dh: true }),
    ]);
    expect(t.hours).toBe(6);
    expect(t.nightHours).toBe(1);
    expect(t.deadheadHours).toBe(4.17);
  });

  it('ошибки и предупреждения', () => {
    const t = summarizeFlights(reg, '2026-08', [
      f({ id: 'a', block: '2:00', night: '3:00' }),
      f({ id: 'b', block: 'x' }),
      f({ id: 'c', block: '5:00', duty: '4:00', date: '2026-07-31' }),
      f({ id: 'd', route: '', block: '', night: '', duty: '' }),
    ]);
    expect(t.count).toBe(1);
    expect(t.issues.filter((i) => i.severity === 'error').map((i) => i.id)).toEqual(['a', 'b']);
    expect(t.issues.filter((i) => i.severity === 'warning').map((i) => i.field).sort()).toEqual(['date', 'duty']);
  });
});

describe('Быстрый ввод строкой', () => {
  it('полная строка с датой', () => {
    expect(parseQuickLine('05.08 TAS-DXB 6:00 3:02 9:42', '2026-08')).toEqual({
      date: '2026-08-05',
      route: 'TAS-DXB',
      block: '6:00',
      night: '3:02',
      duty: '9:42',
      dh: false,
    });
  });
  it('день числом, метки н/р, Dead Head', () => {
    expect(parseQuickLine('12 tas-ist 5:20 р6:50', '2026-08')).toMatchObject({ date: '2026-08-12', route: 'TAS-IST', block: '5:20', duty: '6:50', night: '' });
    expect(parseQuickLine('DH DXB-TAS 4:10', '2026-08')).toMatchObject({ dh: true, route: 'DXB-TAS', block: '4:10', date: null });
  });
  it('мусор не превращается в рейс', () => {
    expect(parseQuickLine('привет', '2026-08')).toBeNull();
  });
});
