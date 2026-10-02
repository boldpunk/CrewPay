export type Category = 'pilot' | 'cabin';
export type Coef = number | null;

export interface Status {
  id: string;
  label: string;
  factor: number;
  ref: string;
}

export interface GuaranteedPosition {
  id: string;
  label: string;
  salary?: number | null;
  guaranteedHours: number;
  /** Табл. 2-1, по индексу типа ВС; null — прочерк (сочетание недоступно). */
  k1: Coef[];
  /** Табл. 2-5, по индексу типа ВС. */
  k5: Coef[];
}

export interface LabeledPosition {
  id: string;
  label: string;
  ref?: string;
  /** Оклад по штатному расписанию, сум; null — не задан. */
  salary?: number | null;
}

export interface CabinPosition {
  id: string;
  label: string;
  salary?: number | null;
  /** Табл. 3-1, до 70 ч. */
  k3: number;
  /** Табл. 3-2, свыше 70 ч. */
  k3over: number;
}

export interface Regulation {
  regulation: {
    code: string;
    edition: number;
    revision: number;
    effectiveFrom: string;
    title: string;
  };
  aircraft: string[];
  constants: {
    nightMultiplier: number;
    holidayExtraMultiplier: number;
    pilotThresholdHours: number;
    pilotThresholdMultiplier: number;
    cabinTier1Hours: number;
    cabinSanitaryHours: number;
    cabinSanitaryMultiplier: number;
    minimumWage: number;
    /** Доля оплаты перелёта Dead Head (0,5 — 50 %). 0 — не оплачивается. */
    deadheadMultiplier: number;
    /** НДФЛ, включая ИНПС. */
    incomeTaxRate: number;
    /** ИНПС — справочно, входит в НДФЛ. */
    inpsRate: number;
  };
  pilot: {
    defaultRate: number;
    statuses: Status[];
    guaranteed: GuaranteedPosition[];
    normative: { normHours: number; k: Coef[]; positions: LabeledPosition[] };
    fixedSalary: LabeledPosition[];
  };
  cabin: {
    defaultRate: number;
    statuses: Status[];
    positions: CabinPosition[];
    includedInSalary: { ref: string; hours: number; positions: LabeledPosition[] };
    fixedSalary: LabeledPosition[];
  };
  paymentDays: {
    salaryDay: number;
    pieceDay: number;
    /** "MM-DD" — нерабочие праздничные дни (подвижные праздники добавляются как "YYYY-MM-DD"). */
    publicHolidays: string[];
  };
}

/** Спорные места Положения (раздел 8 ТЗ) — переключатели. */
export interface Settings {
  /** П. 2.12: ×2,0 заменяет оплату сверх гарантии ('replace') или начисляется поверх ('additive'). */
  over94Mode: 'replace' | 'additive';
  /** Пропорция по отработанному времени: по дням или по часам нормы. */
  proportionBasis: 'days' | 'hours';
}

export const DEFAULT_SETTINGS: Settings = {
  over94Mode: 'replace',
  proportionBasis: 'days',
};

export interface PeriodInput {
  category: Category;
  positionId: string;
  /** Индекс типа ВС в Regulation.aircraft, либо -1, если не выбран. */
  aircraft: number;
  hours: number;
  nightHours: number;
  holidayHours: number;
  /** Ночные часы, выполненные в праздничный день (входят и в ночные, и в праздничные). */
  nightHolidayHours: number;
  deadheadHours: number;
  /** Отработано дней (или часов — см. Settings.proportionBasis) в этом периоде. */
  worked: number;
  statusId: string;
  /** Должностной оклад, сум; 0 — не указан. */
  salary: number;
  /** Часовая ставка, сум. */
  rate: number;
}

/** Начисление, которое Положение не рассчитывает (надбавка, медосмотр, премия): вводится суммой из листка. */
export interface ExtraInput {
  title: string;
  amount: number;
}

export interface MonthInput {
  /** Норма рабочего времени месяца (дни или часы). */
  norm: number;
  periods: PeriodInput[];
  extras?: ExtraInput[];
}

export type PositionKind = 'guaranteed' | 'normative' | 'fixed' | 'cabin' | 'cabinIncluded';

export interface ResolvedPosition {
  kind: PositionKind;
  category: Category;
  id: string;
  label: string;
  needsAircraft: boolean;
  guaranteed?: GuaranteedPosition;
  cabin?: CabinPosition;
  ref?: string;
}

export interface Line {
  /** Вид начисления. */
  title: string;
  /** Пункт Положения. */
  ref: string;
  /** Формула с подставленными числами. */
  formula: string;
  /** Сумма, сум (без округления). */
  amount: number;
  part: 'piece' | 'time' | 'extra' | 'info';
}

export interface Hint {
  label: string;
  hours: number;
}

export interface PeriodResult {
  lines: Line[];
  piece: number;
  time: number;
  errors: string[];
  warnings: string[];
  notes: string[];
  hints: Hint[];
}

export interface MonthResult {
  periods: PeriodResult[];
  piece: number;
  time: number;
  /** Прочие начисления (надбавки и т. п.). */
  extras: number;
  /** Начислено всего (брутто), до тийинов. */
  total: number;
  /** НДФЛ (включая ИНПС). */
  tax: number;
  /** ИНПС — справочно, входит в tax. */
  inps: number;
  /** К выплате. */
  net: number;
  errors: string[];
  warnings: string[];
}
