import { findPosition, statusesFor } from './calc/engine';
import { parseHours, parseMoney } from './calc/format';
import type { Category, MonthInput, PeriodInput, Regulation, Settings } from './calc/types';
import { DEFAULT_SETTINGS } from './calc/types';

/** Поля формы хранятся как введённые строки, чтобы не мешать набору. */
export interface PeriodForm {
  category: Category;
  positionId: string;
  aircraft: number;
  hours: string;
  nightHours: string;
  holidayHours: string;
  nightHolidayHours: string;
  deadheadHours: string;
  worked: string;
  statusId: string;
  salary: string;
  rate: string;
}

export interface AppState {
  month: string;
  norm: string;
  periods: PeriodForm[];
  active: number;
  settings: Settings;
}

export interface HistoryEntry {
  month: string;
  savedAt: string;
  total: number;
  piece: number;
  time: number;
  label: string;
  state: Pick<AppState, 'norm' | 'periods' | 'settings'>;
}

const STATE_KEY = 'crewpay.state.v1';
const HISTORY_KEY = 'crewpay.history.v1';

export function currentMonth(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function defaultPeriod(reg: Regulation, category: Category = 'pilot'): PeriodForm {
  const isPilot = category === 'pilot';
  return {
    category,
    positionId: isPilot
      ? (reg.pilot.guaranteed.find((g) => g.id === 'captain') ?? reg.pilot.guaranteed[0])?.id ?? ''
      : (reg.cabin.positions.find((c) => c.id === 'fa') ?? reg.cabin.positions[0])?.id ?? '',
    aircraft: -1,
    hours: '',
    nightHours: '',
    holidayHours: '',
    nightHolidayHours: '',
    deadheadHours: '',
    worked: '',
    statusId: statusesFor(reg, category)[0]?.id ?? '',
    salary: '',
    rate: String(isPilot ? reg.pilot.defaultRate : reg.cabin.defaultRate),
  };
}

export function defaultState(reg: Regulation): AppState {
  return {
    month: currentMonth(),
    norm: '',
    periods: [defaultPeriod(reg)],
    active: 0,
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Приводит сохранённое состояние к актуальному справочнику (должности могли измениться). */
export function sanitize(reg: Regulation, s: AppState): AppState {
  const periods = (Array.isArray(s.periods) && s.periods.length ? s.periods : [defaultPeriod(reg)]).map((p) => {
    const base = defaultPeriod(reg, p.category === 'cabin' ? 'cabin' : 'pilot');
    const merged: PeriodForm = { ...base, ...p };
    if (!findPosition(reg, merged.category, merged.positionId)) merged.positionId = base.positionId;
    if (!statusesFor(reg, merged.category).some((st) => st.id === merged.statusId)) merged.statusId = base.statusId;
    if (!Number.isInteger(merged.aircraft) || merged.aircraft >= reg.aircraft.length) merged.aircraft = -1;
    return merged;
  });
  return {
    month: /^\d{4}-\d{2}$/.test(s.month) ? s.month : currentMonth(),
    norm: typeof s.norm === 'string' ? s.norm : '',
    periods,
    active: Math.min(Math.max(0, s.active | 0), periods.length - 1),
    settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) },
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно (приватный режим) — работаем без сохранения */
  }
}

export function loadState(reg: Regulation): AppState {
  const saved = readJson<AppState>(STATE_KEY);
  return saved ? sanitize(reg, saved) : defaultState(reg);
}

export function saveState(s: AppState) {
  writeJson(STATE_KEY, s);
}

export function loadHistory(): HistoryEntry[] {
  const h = readJson<HistoryEntry[]>(HISTORY_KEY);
  return Array.isArray(h) ? h : [];
}

export function saveHistory(entries: HistoryEntry[]) {
  writeJson(HISTORY_KEY, entries);
}

export function toMonthInput(s: AppState): MonthInput {
  const norm = parseHours(s.norm);
  const single = s.periods.length === 1;
  return {
    norm,
    periods: s.periods.map<PeriodInput>((p) => ({
      category: p.category,
      positionId: p.positionId,
      aircraft: p.aircraft,
      hours: parseHours(p.hours),
      nightHours: parseHours(p.nightHours),
      holidayHours: parseHours(p.holidayHours),
      nightHolidayHours: parseHours(p.nightHolidayHours),
      deadheadHours: parseHours(p.deadheadHours),
      // Для одного периода пустое «отработано» = полный месяц.
      worked: single && p.worked.trim() === '' ? norm : parseHours(p.worked),
      statusId: p.statusId,
      salary: parseMoney(p.salary),
      rate: parseMoney(p.rate),
    })),
  };
}
