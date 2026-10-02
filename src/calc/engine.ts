import { clean, coef, hours as h, money, num } from './format';
import type {
  Category,
  Hint,
  Line,
  MonthInput,
  MonthResult,
  PeriodInput,
  PeriodResult,
  Regulation,
  ResolvedPosition,
  Settings,
  Status,
} from './types';

const pos = (x: number) => Math.max(0, x);

/** Все должности категории в порядке отображения. */
export function positionsFor(reg: Regulation, category: Category): ResolvedPosition[] {
  if (category === 'pilot') {
    return [
      ...reg.pilot.guaranteed.map<ResolvedPosition>((g) => ({
        kind: 'guaranteed',
        category,
        id: g.id,
        label: g.label,
        needsAircraft: true,
        guaranteed: g,
      })),
      ...reg.pilot.normative.positions.map<ResolvedPosition>((p) => ({
        kind: 'normative',
        category,
        id: p.id,
        label: p.label,
        needsAircraft: true,
      })),
      ...reg.pilot.fixedSalary.map<ResolvedPosition>((p) => ({
        kind: 'fixed',
        category,
        id: p.id,
        label: p.label,
        needsAircraft: false,
        ref: p.ref,
      })),
    ];
  }
  return [
    ...reg.cabin.positions.map<ResolvedPosition>((c) => ({
      kind: 'cabin',
      category,
      id: c.id,
      label: c.label,
      needsAircraft: false,
      cabin: c,
    })),
    ...reg.cabin.includedInSalary.positions.map<ResolvedPosition>((p) => ({
      kind: 'cabinIncluded',
      category,
      id: p.id,
      label: p.label,
      needsAircraft: false,
      ref: reg.cabin.includedInSalary.ref,
    })),
    ...reg.cabin.fixedSalary.map<ResolvedPosition>((p) => ({
      kind: 'fixed',
      category,
      id: p.id,
      label: p.label,
      needsAircraft: false,
      ref: p.ref,
    })),
  ];
}

export function findPosition(reg: Regulation, category: Category, id: string): ResolvedPosition | undefined {
  return positionsFor(reg, category).find((p) => p.id === id);
}

export function statusesFor(reg: Regulation, category: Category): Status[] {
  return category === 'pilot' ? reg.pilot.statuses : reg.cabin.statuses;
}

/** Индексы типов ВС, доступных для должности (без прочерка в таблице). */
export function availableAircraft(reg: Regulation, position: ResolvedPosition | undefined): number[] {
  if (!position || !position.needsAircraft) return [];
  const row =
    position.kind === 'guaranteed' ? position.guaranteed!.k1 : position.kind === 'normative' ? reg.pilot.normative.k : [];
  return row.flatMap((k, i) => (k === null ? [] : [i]));
}

function emptyResult(): PeriodResult {
  return { lines: [], piece: 0, time: 0, errors: [], warnings: [], notes: [], hints: [] };
}

function validateHours(p: PeriodInput, r: PeriodResult) {
  const fields: [number, string][] = [
    [p.hours, 'Фактический налёт'],
    [p.nightHours, 'Ночной налёт'],
    [p.holidayHours, 'Праздничный налёт'],
    [p.nightHolidayHours, 'Ночной в праздник'],
    [p.deadheadHours, 'Dead Head'],
    [p.worked, 'Отработано'],
    [p.salary, 'Оклад'],
    [p.rate, 'Часовая ставка'],
  ];
  for (const [v, name] of fields) {
    if (!Number.isFinite(v)) r.errors.push(`${name}: введите число.`);
    else if (v < 0) r.errors.push(`${name}: значение не может быть отрицательным.`);
  }
  if (r.errors.length) return;
  if (p.rate === 0) r.errors.push('Часовая ставка должна быть больше 0.');
  if (p.nightHours > p.hours) r.errors.push('Ночной налёт не может превышать фактический.');
  if (p.holidayHours > p.hours) r.errors.push('Праздничный налёт не может превышать фактический.');
  if (p.nightHolidayHours > Math.min(p.nightHours, p.holidayHours))
    r.errors.push('«Ночь в праздник» не может превышать ни ночные, ни праздничные часы.');
  if (r.errors.length) return;
  if (clean(p.nightHours + p.holidayHours - p.nightHolidayHours) > clean(p.hours))
    r.errors.push('Ночные + праздничные часы (без учёта пересечения) превышают фактический налёт.');
}

/** Расчёт одного периода (при переводе в течение месяца — п. 2.15 — периодов несколько). */
export function calculatePeriod(
  reg: Regulation,
  settings: Settings,
  norm: number,
  p: PeriodInput,
): PeriodResult {
  const r = emptyResult();
  const c = reg.constants;
  const unit = settings.proportionBasis === 'days' ? 'дн.' : 'ч';

  const position = findPosition(reg, p.category, p.positionId);
  if (!position) {
    r.errors.push('Выберите должность.');
    return r;
  }
  const status = statusesFor(reg, p.category).find((s) => s.id === p.statusId);
  if (!status) r.errors.push('Выберите статус допуска.');

  if (!Number.isFinite(norm) || norm <= 0) r.errors.push('Норма рабочего времени месяца должна быть больше 0.');
  validateHours(p, r);
  if (Number.isFinite(norm) && norm > 0 && p.worked > norm)
    r.errors.push('Отработано не может превышать норму месяца.');

  let ac = -1;
  if (position.needsAircraft) {
    if (p.aircraft < 0 || p.aircraft >= reg.aircraft.length) r.errors.push('Выберите тип ВС.');
    else if (!availableAircraft(reg, position).includes(p.aircraft))
      r.errors.push(`Сочетание «${position.label}» × ${reg.aircraft[p.aircraft]} не предусмотрено Положением.`);
    else ac = p.aircraft;
  }
  if (r.errors.length || !status) return r;

  const Kc = status.factor;
  const P = p.worked / norm;
  const Pstr = `${num(p.worked)}/${num(norm)}`;
  const S = p.rate * Kc;
  const Sstr = Kc === 1 ? money(p.rate) : `${money(p.rate)} × ${num(Kc)}`;
  const H = p.hours;
  const Nn = clean(p.nightHours - p.nightHolidayHours);
  const F = p.holidayHours;

  const add = (line: Line) => r.lines.push({ ...line, amount: clean(line.amount) });

  // --- Сдельная часть ---
  if (position.kind === 'fixed') {
    r.notes.push(
      `Должность с фиксированным окладом (${position.ref}): сдельной части нет, калькулятор показывает только оклад.`,
    );
  } else if (position.kind === 'cabinIncluded') {
    r.notes.push(
      `${position.ref}: налёт до ${reg.cabin.includedInSalary.hours} ч включён в оклад, сдельная часть не начисляется.`,
    );
    if (H > reg.cabin.includedInSalary.hours)
      r.warnings.push(
        `Налёт ${h(H)} ч больше ${reg.cabin.includedInSalary.hours} ч: оплата сверх этого Положением не определена — уточните в экономическом отделе.`,
      );
  } else if (H === 0) {
    r.notes.push('Налёт 0 ч — сдельная часть не начисляется (п. 4.2).');
  } else if (position.kind === 'guaranteed') {
    const g = position.guaranteed!;
    const k1 = g.k1[ac]!;
    const k5 = g.k5[ac];
    const T = c.pilotThresholdHours;
    const Gadj = clean(g.guaranteedHours * P);
    const GadjStr = P === 1 ? num(g.guaranteedHours) : `${num(g.guaranteedHours)} × ${Pstr}`;

    add({
      title: 'Гарантированный налёт',
      ref: 'п. 2.6',
      formula: `${Sstr} × ${coef(k1)} × ${GadjStr}${P === 1 ? '' : ` (${h(Gadj)} ч)`}`,
      amount: S * k1 * Gadj,
      part: 'piece',
    });
    if (H < Gadj) r.notes.push(`Налёт ${h(H)} ч меньше гарантии ${h(Gadj)} ч — гарантия оплачивается полностью (п. 2.6).`);

    const overHours = clean(pos((settings.over94Mode === 'replace' ? Math.min(H, T) : H) - Gadj));
    const aboveT = clean(pos(H - T));
    if (k5 === null) {
      if (overHours > 0 || aboveT > 0)
        r.warnings.push(
          `Для «${g.label}» на ${reg.aircraft[ac]} в табл. 2-5 прочерк: ${h(clean(pos(H - Gadj)))} ч сверх гарантии не оплачены. Уточните в экономическом отделе.`,
        );
    } else {
      if (overHours > 0)
        add({
          title: 'Сверх гарантии',
          ref: 'п. 2.8',
          formula: `${Sstr} × ${coef(k5)} × ${h(overHours)}`,
          amount: S * k5 * overHours,
          part: 'piece',
        });
      if (aboveT > 0)
        add({
          title: `Свыше ${num(T)} ч${settings.over94Mode === 'additive' ? ' (доплата)' : ''}`,
          ref: 'п. 2.12',
          formula: `${Sstr} × ${num(c.pilotThresholdMultiplier, 1)} × ${coef(k5)} × ${h(aboveT)}`,
          amount: S * c.pilotThresholdMultiplier * k5 * aboveT,
          part: 'piece',
        });
    }
    if (Nn > 0)
      add({
        title: 'Ночной налёт',
        ref: 'п. 2.10',
        formula: `${Sstr} × ${coef(k1)} × ${num(c.nightMultiplier)} × ${h(Nn)}`,
        amount: S * k1 * c.nightMultiplier * Nn,
        part: 'piece',
      });
    if (F > 0)
      add({
        title: 'Праздничный налёт (доплата)',
        ref: 'п. 2.11',
        formula: `${Sstr} × ${coef(k1)} × ${h(F)} × ${num(c.holidayExtraMultiplier)}`,
        amount: S * k1 * F * c.holidayExtraMultiplier,
        part: 'piece',
      });

    r.hints.push({ label: 'До гарантии', hours: clean(pos(Gadj - H)) });
    r.hints.push({ label: `До ${num(T)} ч`, hours: clean(pos(T - H)) });
  } else if (position.kind === 'normative') {
    const k = reg.pilot.normative.k[ac]!;
    const normH = reg.pilot.normative.normHours;
    const Nadj = clean(normH * P);
    if (H >= Nadj) {
      add({
        title: 'Нормативный налёт',
        ref: 'п. 2.7',
        formula: `${Sstr} × ${coef(k)} × ${P === 1 ? num(normH) : `${num(normH)} × ${Pstr} (${h(Nadj)} ч)`}`,
        amount: S * k * Nadj,
        part: 'piece',
      });
    } else {
      r.warnings.push(`Норматив ${h(Nadj)} ч не выполнен (налёт ${h(H)} ч) — сдельная часть не начисляется (п. 2.7).`);
    }
    r.notes.push('Ночные часы входят в норматив; сверх нормы, свыше 94,5 ч и праздничные доплаты не начисляются (п. 2.7).');
    r.hints.push({ label: 'До норматива', hours: clean(pos(Nadj - H)) });
  } else {
    // ЧКЭ
    const cp = position.cabin!;
    const t1 = c.cabinTier1Hours;
    const t2 = c.cabinSanitaryHours;
    const h1 = Math.min(H, t1);
    const h2 = clean(pos(Math.min(H, t2) - t1));
    const h3 = clean(pos(H - t2));
    add({
      title: `Налёт до ${num(t1)} ч`,
      ref: 'п. 3.7',
      formula: `${Sstr} × ${coef(cp.k3)} × ${h(h1)}`,
      amount: S * cp.k3 * h1,
      part: 'piece',
    });
    if (h2 > 0)
      add({
        title: `Налёт ${num(t1)}–${num(t2)} ч`,
        ref: 'п. 3.7.1',
        formula: `${Sstr} × ${coef(cp.k3over)} × ${h(h2)}`,
        amount: S * cp.k3over * h2,
        part: 'piece',
      });
    if (h3 > 0)
      add({
        title: `Свыше ${num(t2)} ч (санитарная норма)`,
        ref: 'п. 3.10',
        formula: `${Sstr} × ${num(c.cabinSanitaryMultiplier, 1)} × ${coef(cp.k3)} × ${h(h3)}`,
        amount: S * c.cabinSanitaryMultiplier * cp.k3 * h3,
        part: 'piece',
      });
    if (Nn > 0)
      add({
        title: 'Ночной налёт',
        ref: 'п. 3.8',
        formula: `${Sstr} × ${coef(cp.k3)} × ${num(c.nightMultiplier)} × ${h(Nn)}`,
        amount: S * cp.k3 * c.nightMultiplier * Nn,
        part: 'piece',
      });
    if (F > 0)
      add({
        title: 'Праздничный налёт (доплата)',
        ref: 'п. 3.9',
        formula: `${Sstr} × ${coef(cp.k3)} × ${h(F)} × ${num(c.holidayExtraMultiplier)}`,
        amount: S * cp.k3 * F * c.holidayExtraMultiplier,
        part: 'piece',
      });
    r.hints.push({ label: `До ${num(t1)} ч`, hours: clean(pos(t1 - H)) });
    r.hints.push({ label: `До ${num(t2)} ч`, hours: clean(pos(t2 - H)) });
  }

  if (p.nightHolidayHours > 0 && position.kind !== 'fixed' && position.kind !== 'cabinIncluded' && H > 0)
    r.notes.push(
      `${h(p.nightHolidayHours)} ч ночью в праздник оплачены как праздничные и исключены из ночной доплаты.`,
    );

  if (p.deadheadHours > 0)
    add({
      title: 'Перелёт Dead Head (справочно)',
      ref: p.category === 'pilot' ? 'п. 2.13' : 'п. 3.11',
      formula: `${h(p.deadheadHours)} ч — не оплачивается`,
      amount: 0,
      part: 'info',
    });

  // --- Повременная часть ---
  if (p.salary > 0) {
    const parts = [money(p.salary)];
    if (Kc !== 1) parts.push(num(Kc));
    if (P !== 1) parts.push(`${Pstr} ${unit}`);
    add({
      title: 'Должностной оклад',
      ref: 'Штатное расписание',
      formula: parts.join(' × '),
      amount: p.salary * Kc * P,
      part: 'time',
    });
  } else if (position.kind === 'fixed' || position.kind === 'cabinIncluded') {
    r.warnings.push('Укажите должностной оклад — для этой должности это вся оплата.');
  }

  r.piece = clean(r.lines.filter((l) => l.part === 'piece').reduce((s, l) => s + l.amount, 0));
  r.time = clean(r.lines.filter((l) => l.part === 'time').reduce((s, l) => s + l.amount, 0));
  r.hints = r.hints.filter((x): x is Hint => x.hours > 0);
  return r;
}

export function calculateMonth(reg: Regulation, settings: Settings, input: MonthInput): MonthResult {
  const periods = input.periods.map((p) => calculatePeriod(reg, settings, input.norm, p));
  const errors = periods.flatMap((r, i) => r.errors.map((e) => (periods.length > 1 ? `Период ${i + 1}: ${e}` : e)));
  const warnings = periods.flatMap((r, i) =>
    r.warnings.map((w) => (periods.length > 1 ? `Период ${i + 1}: ${w}` : w)),
  );

  const workedSum = input.periods.reduce((s, p) => s + (Number.isFinite(p.worked) ? p.worked : 0), 0);
  if (periods.length > 1 && input.norm > 0 && clean(workedSum) > clean(input.norm))
    errors.push('Сумма отработанного по периодам превышает норму месяца.');

  const piece = clean(periods.reduce((s, r) => s + r.piece, 0));
  const time = clean(periods.reduce((s, r) => s + r.time, 0));
  const total = errors.length ? 0 : Math.round(clean(piece + time));

  if (!errors.length) {
    const beforeAdmission = input.periods.some((p) => p.statusId === 'before');
    if (beforeAdmission && total > 0 && total < reg.constants.minimumWage)
      warnings.push(
        `Начислено ${money(total)} сум — меньше МРОТ (${money(reg.constants.minimumWage)} сум). До допуска зарплата не может быть ниже МРОТ.`,
      );
  }
  return { periods, piece, time, total, errors, warnings };
}
