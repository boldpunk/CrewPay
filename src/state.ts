import { findPosition, statusesFor } from './calc/engine';
import { parseHours, parseMoney } from './calc/format';
import type { FlightForm } from './calc/flights';
import type { Payslip } from './calc/payslip';
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
  /** Журнал рейсов; если не пуст — часы периода считаются из него. */
  flights: FlightForm[];
}

export interface ExtraForm {
  title: string;
  amount: string;
}

export type Theme = 'system' | 'light' | 'dark';

/** Расчётный листок, из которого заполнен месяц (хранится на сервере). */
export interface AttachedPayslip {
  id: string;
  filename: string;
  uploadedAt: string;
  parsed: Payslip;
}

export interface AppState {
  month: string;
  norm: string;
  periods: PeriodForm[];
  extras: ExtraForm[];
  active: number;
  settings: Settings;
  theme: Theme;
  payslip: AttachedPayslip | null;
}

/** Аккаунт на устройстве: данные из расчётного листка. */
export interface Profile {
  name: string;
  email: string;
  employeeId: string;
  organization: string;
  department: string;
  createdAt: string;
}

export interface HistoryEntry {
  month: string;
  savedAt: string;
  total: number;
  net: number;
  piece: number;
  time: number;
  extras: number;
  label: string;
  payslipId?: string | null;
  state: Pick<AppState, 'norm' | 'periods' | 'extras' | 'settings'>;
}

/** Резервная копия аккаунта: переносится на другое устройство файлом. */
export interface Backup {
  app: 'crewpay';
  version: 1;
  exportedAt: string;
  profile: Profile | null;
  state: AppState;
  history: HistoryEntry[];
  salaries: Record<string, string>;
}

const STATE_KEY = 'crewpay.state.v1';
const HISTORY_KEY = 'crewpay.history.v1';
const PROFILE_KEY = 'crewpay.profile.v1';
const SALARY_KEY = 'crewpay.salaries.v1';

export const EXTRA_PRESETS = ['Надбавка', 'Медицинский осмотр', 'Премия', 'Отпускные', 'Командировочные'];

export function currentMonth(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function defaultPeriod(reg: Regulation, category: Category = 'pilot'): PeriodForm {
  const isPilot = category === 'pilot';
  return {
    category,
    positionId: isPilot
      ? ((reg.pilot.guaranteed.find((g) => g.id === 'captain') ?? reg.pilot.guaranteed[0])?.id ?? '')
      : ((reg.cabin.positions.find((c) => c.id === 'fa') ?? reg.cabin.positions[0])?.id ?? ''),
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
    flights: [],
  };
}

export function defaultState(reg: Regulation): AppState {
  return {
    month: currentMonth(),
    norm: '',
    periods: [defaultPeriod(reg)],
    extras: [],
    active: 0,
    settings: { ...DEFAULT_SETTINGS },
    theme: 'system',
    payslip: null,
  };
}

/** Приводит сохранённое состояние к актуальному справочнику (должности могли измениться). */
export function sanitize(reg: Regulation, s: Partial<AppState>): AppState {
  const periods = (Array.isArray(s.periods) && s.periods.length ? s.periods : [defaultPeriod(reg)]).map((p) => {
    const base = defaultPeriod(reg, p.category === 'cabin' ? 'cabin' : 'pilot');
    const merged: PeriodForm = { ...base, ...p };
    if (!findPosition(reg, merged.category, merged.positionId)) merged.positionId = base.positionId;
    if (!statusesFor(reg, merged.category).some((st) => st.id === merged.statusId)) merged.statusId = base.statusId;
    if (!Number.isInteger(merged.aircraft) || merged.aircraft >= reg.aircraft.length) merged.aircraft = -1;
    merged.flights = Array.isArray(merged.flights)
      ? merged.flights
          .filter((f) => f && typeof f.id === 'string')
          .map((f) => ({
            id: f.id,
            date: String(f.date ?? ''),
            route: String(f.route ?? ''),
            block: String(f.block ?? ''),
            night: String(f.night ?? ''),
            duty: String(f.duty ?? ''),
            dh: Boolean(f.dh),
          }))
      : [];
    return merged;
  });
  const extras = Array.isArray(s.extras)
    ? s.extras
        .filter((x) => x && typeof x.title === 'string')
        .map((x) => ({ title: x.title, amount: String(x.amount ?? '') }))
    : [];
  return {
    month: typeof s.month === 'string' && /^\d{4}-\d{2}$/.test(s.month) ? s.month : currentMonth(),
    norm: typeof s.norm === 'string' ? s.norm : '',
    periods,
    extras,
    active: Math.min(Math.max(0, (s.active ?? 0) | 0), periods.length - 1),
    settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) },
    theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system',
    payslip:
      s.payslip && typeof s.payslip === 'object' && typeof s.payslip.id === 'string' && s.payslip.parsed
        ? s.payslip
        : null,
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
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно (приватный режим) — работаем без сохранения */
  }
}

export function hasSavedState(): boolean {
  return readJson(STATE_KEY) !== null || readJson(PROFILE_KEY) !== null;
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
  return Array.isArray(h) ? h.map((e) => ({ ...e, net: e.net ?? e.total, extras: e.extras ?? 0 })) : [];
}

export function saveHistory(entries: HistoryEntry[]) {
  writeJson(HISTORY_KEY, entries);
}

export function loadProfile(): Profile | null {
  return readJson<Profile>(PROFILE_KEY);
}

export function saveProfile(p: Profile | null) {
  writeJson(PROFILE_KEY, p);
}

/** Личные оклады по должностям: вводятся один раз и подставляются при выборе должности. */
export function loadSalaries(): Record<string, string> {
  return readJson<Record<string, string>>(SALARY_KEY) ?? {};
}

export function saveSalaries(s: Record<string, string>) {
  writeJson(SALARY_KEY, s);
}

export function makeBackup(
  profile: Profile | null,
  state: AppState,
  history: HistoryEntry[],
  salaries: Record<string, string>,
): Backup {
  return { app: 'crewpay', version: 1, exportedAt: new Date().toISOString(), profile, state, history, salaries };
}

export function parseBackup(reg: Regulation, data: unknown): Backup | null {
  const b = data as Backup;
  if (!b || b.app !== 'crewpay' || typeof b.state !== 'object') return null;
  return {
    app: 'crewpay',
    version: 1,
    exportedAt: String(b.exportedAt ?? ''),
    profile: b.profile && typeof b.profile === 'object' ? b.profile : null,
    state: sanitize(reg, b.state),
    history: Array.isArray(b.history) ? b.history : [],
    salaries: b.salaries && typeof b.salaries === 'object' ? b.salaries : {},
  };
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
    extras: s.extras.map((x) => ({ title: x.title, amount: parseMoney(x.amount) })),
  };
}
