// Журнал рейсов: каждый полёт вводится отдельно, итоги месяца считаются в минутах
// и переводятся в часы один раз — без накопления ошибок округления.
import type { Regulation } from './types';

export interface FlightForm {
  id: string;
  /** Дата вылета, YYYY-MM-DD. */
  date: string;
  /** Маршрут IATA: TAS-DXB (можно несколько плеч: TAS-DXB-TAS). */
  route: string;
  /** Полётное время, чч:мм. */
  block: string;
  /** Из них ночные, чч:мм. */
  night: string;
  /** Рабочее время (от явки до окончания), чч:мм — справочно. */
  duty: string;
  /** Перелёт пассажиром (Dead Head): идёт в DH, а не в налёт. */
  dh: boolean;
}

export interface FlightIssue {
  id: string;
  field: 'date' | 'route' | 'block' | 'night' | 'duty';
  message: string;
  /** Ошибка блокирует расчёт; предупреждение — нет. */
  severity: 'error' | 'warning';
}

export interface FlightTotals {
  count: number;
  flightMin: number;
  nightMin: number;
  holidayMin: number;
  nightHolidayMin: number;
  deadheadMin: number;
  dutyMin: number;
  /** Часы для калькулятора (до сотых). */
  hours: number;
  nightHours: number;
  holidayHours: number;
  nightHolidayHours: number;
  deadheadHours: number;
  dutyHours: number;
  /** Даты рейсов в праздники — для подсказки. */
  holidayDates: string[];
  issues: FlightIssue[];
}

/** «6:00», «06:00», «6.30» (часы.минуты), «6ч 30м», «6» → минуты; пусто → 0; ошибка → NaN. */
export function parseDuration(raw: string): number {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === '') return 0;
  let m = /^(\d{1,3})[:.](\d{1,2})$/.exec(s);
  if (m) return Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  m = /^(\d{1,3})\s*ч(?:\s*(\d{1,2})\s*м?)?$/.exec(s);
  if (m) return Number(m[2] ?? 0) < 60 ? Number(m[1]) * 60 + Number(m[2] ?? 0) : NaN;
  m = /^(\d{1,2})\s*м$/.exec(s);
  if (m) return Number(m[1]);
  if (/^\d{1,3}$/.test(s)) return Number(s) * 60;
  return NaN;
}

export function formatDuration(min: number): string {
  if (!Number.isFinite(min)) return '—';
  const sign = min < 0 ? '−' : '';
  const a = Math.round(Math.abs(min));
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

const toHours = (min: number) => Math.round((min / 60) * 100) / 100;

export function normalizeRoute(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[–—→>\s/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function validRoute(route: string): boolean {
  return /^[A-Z]{3}(-[A-Z]{3})+$/.test(route);
}

export function isPublicHoliday(reg: Regulation, date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const md = date.slice(5);
  return reg.paymentDays.publicHolidays.includes(md) || reg.paymentDays.publicHolidays.includes(date);
}

export function summarizeFlights(reg: Regulation, month: string, flights: FlightForm[]): FlightTotals {
  const t: FlightTotals = {
    count: 0,
    flightMin: 0,
    nightMin: 0,
    holidayMin: 0,
    nightHolidayMin: 0,
    deadheadMin: 0,
    dutyMin: 0,
    hours: 0,
    nightHours: 0,
    holidayHours: 0,
    nightHolidayHours: 0,
    deadheadHours: 0,
    dutyHours: 0,
    holidayDates: [],
    issues: [],
  };
  for (const f of flights) {
    const empty = !f.route.trim() && !f.block.trim() && !f.night.trim() && !f.duty.trim();
    if (empty) continue;
    const issue = (field: FlightIssue['field'], message: string, severity: FlightIssue['severity'] = 'error') =>
      t.issues.push({ id: f.id, field, message, severity });

    const block = parseDuration(f.block);
    const night = parseDuration(f.night);
    const duty = parseDuration(f.duty);
    const route = normalizeRoute(f.route);

    if (f.route.trim() && !validRoute(route)) issue('route', 'Маршрут — коды аэропортов через дефис: TAS-DXB', 'warning');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) issue('date', 'Укажите дату вылета');
    else if (month && f.date.slice(0, 7) !== month) issue('date', 'Дата не в расчётном месяце', 'warning');
    if (Number.isNaN(block)) issue('block', 'Полётное время — в формате 6:00');
    else if (block <= 0) issue('block', 'Укажите полётное время');
    else if (block > 20 * 60) issue('block', 'Больше 20 часов — проверьте', 'warning');
    if (Number.isNaN(night)) issue('night', 'Ночные — в формате 3:02');
    else if (block > 0 && night > block) issue('night', 'Ночных больше, чем полётного времени');
    if (Number.isNaN(duty)) issue('duty', 'Рабочее время — в формате 9:42');
    else if (duty > 0 && block > 0 && duty < block) issue('duty', 'Рабочее время меньше полётного', 'warning');

    if ([block, night, duty].some(Number.isNaN) || block <= 0 || night > block) continue;
    t.count++;
    t.dutyMin += duty;
    if (f.dh) {
      t.deadheadMin += block;
      continue;
    }
    t.flightMin += block;
    t.nightMin += night;
    if (isPublicHoliday(reg, f.date)) {
      t.holidayMin += block;
      t.nightHolidayMin += night;
      if (!t.holidayDates.includes(f.date)) t.holidayDates.push(f.date);
    }
  }
  t.hours = toHours(t.flightMin);
  t.nightHours = toHours(t.nightMin);
  t.holidayHours = toHours(t.holidayMin);
  t.nightHolidayHours = toHours(t.nightHolidayMin);
  t.deadheadHours = toHours(t.deadheadMin);
  t.dutyHours = toHours(t.dutyMin);
  return t;
}

export interface QuickLine {
  date: string | null;
  route: string;
  block: string;
  night: string;
  duty: string;
  dh: boolean;
}

/**
 * Быстрый ввод строкой: «05.08 TAS-DXB 6:00 3:02 9:42», «TAS-DXB 6:00 н3:02 р9:42», «DH DXB-TAS 4:10».
 * Времена по порядку: полётное, ночные, рабочее; метки «н»/«р» задают поле явно.
 */
export function parseQuickLine(raw: string, month: string): QuickLine | null {
  const s = raw.trim();
  if (!s) return null;
  const out: QuickLine = { date: null, route: '', block: '', night: '', duty: '', dh: false };
  const year = month.slice(0, 4);
  const mon = month.slice(5, 7);
  const times: string[] = [];
  for (const tok of s.split(/[\s,;]+/).filter(Boolean)) {
    const up = tok.toUpperCase();
    if (/^(DH|DHD|ДХ|ПАСС)$/.test(up)) {
      out.dh = true;
      continue;
    }
    let m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/.exec(tok);
    // Дата — только первым токеном (до маршрута и времени): «05.08» иначе не отличить от времени.
    if (m && !out.date && !out.route && !times.length && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1 && Number(m[1]) <= 31) {
      const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : year;
      out.date = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      continue;
    }
    if (/^[A-Za-zА-Яа-я]{3}([-–—>/][A-Za-z]{3})+$/.test(tok) && /[A-Za-z]/.test(tok)) {
      out.route = normalizeRoute(tok);
      continue;
    }
    m = /^([нрnr])[:=]?(\d{1,3}[:.]\d{2})$/i.exec(tok);
    if (m) {
      if (/[нn]/i.test(m[1])) out.night = m[2].replace('.', ':');
      else out.duty = m[2].replace('.', ':');
      continue;
    }
    if (/^\d{1,3}:\d{2}$/.test(tok)) {
      times.push(tok);
      continue;
    }
    m = /^(\d{1,2})$/.exec(tok);
    if (m && !out.date && !times.length && !out.route) {
      out.date = `${year}-${mon}-${m[1].padStart(2, '0')}`;
      continue;
    }
  }
  const slots: ('block' | 'night' | 'duty')[] = ['block', 'night', 'duty'];
  for (const tm of times) {
    const slot = slots.find((k) => !out[k]);
    if (slot) out[slot] = tm;
  }
  if (!out.route && !out.block) return null;
  return out;
}
