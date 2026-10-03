// Распознавание расчётного листка (выгрузка 1С «РАСЧЕТНЫЙ ЛИСТОК ЗА <МЕСЯЦ> <ГОД>»)
// и сверка его строк с расчётом по Положению.
import { calculateMonth, findPosition, positionsFor } from './engine';
import type { Category, MonthInput, Regulation, Settings } from './types';

/** Фрагмент текста PDF с координатами (pdf.js: y растёт вверх). */
export interface TextItem {
  s: string;
  x: number;
  y: number;
}

export interface PayslipLine {
  label: string;
  period: string;
  days: number | null;
  hours: number | null;
  paid: string;
  amount: number;
}

export interface Payslip {
  month: string | null;
  name: string;
  employeeId: string;
  organization: string;
  department: string;
  position: string;
  salaryRate: number | null;
  gross: number | null;
  withheld: number | null;
  net: number | null;
  accruals: PayslipLine[];
  deductions: { label: string; period: string; amount: number }[];
}

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONEY_RE = /^-?\d{1,3}(?:[  ]\d{3})*(?:,\d{1,2})?$/;
// Подпись правой таблицы начинается с заглавной («НДФЛ…», «Удержано:»); «23,00 дн.» не разделяем.
const MONEY_PREFIX_RE = /^(-?\d{1,3}(?:[ \u00a0]\d{3})*,\d{2})\s+([А-ЯЁA-Z].*)$/;

export function parseNumber(s: string): number | null {
  const t = s.replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Сумма и подпись в одном фрагменте («8 740 000,00 НДФЛ…») — разделяем: подпись относится к правой таблице. */
function splitItems(items: TextItem[], rightX: number): TextItem[] {
  return items.flatMap((it) => {
    const m = MONEY_PREFIX_RE.exec(it.s.trim());
    if (m && it.x < rightX) return [{ ...it, s: m[1] }, { s: m[2], x: rightX, y: it.y }];
    return [{ ...it, s: it.s.trim() }];
  });
}

function rowsOf(items: TextItem[]): TextItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - it.y) <= 2);
    if (row) row.push(it);
    else rows.push([it]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

const normSpaces = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parsePayslip(raw: TextItem[]): Payslip {
  const headerRight = raw.find((i) => /^Должность:/.test(i.s))?.x ?? 354;
  const items = splitItems(
    raw.filter((i) => i.s.trim() !== ''),
    headerRight,
  );
  const rows = rowsOf(items);
  const after = (label: RegExp): string => {
    for (const r of rows) {
      const i = r.findIndex((it) => label.test(it.s));
      if (i < 0) continue;
      const inline = r[i].s.replace(label, '').trim();
      if (inline) return inline;
      if (r[i + 1]) return r[i + 1].s;
    }
    return '';
  };

  const p: Payslip = {
    month: null,
    name: '',
    employeeId: '',
    organization: '',
    department: '',
    position: '',
    salaryRate: null,
    gross: null,
    withheld: null,
    net: null,
    accruals: [],
    deductions: [],
  };

  const all = items.map((i) => i.s).join('\n');
  const mm = /РАСЧ[ЕЁ]ТНЫЙ ЛИСТОК ЗА\s+([А-ЯЁа-яё]+)\s+(\d{4})/i.exec(all);
  if (mm) {
    const mi = MONTHS.indexOf(mm[1].toLowerCase().replace('ё', 'е'));
    if (mi >= 0) p.month = `${mm[2]}-${String(mi + 1).padStart(2, '0')}`;
  }
  const who = items.find((i) => /^[^:]+\(\d+\)$/.test(i.s) && !/ЛИСТОК/i.test(i.s));
  if (who) {
    const m = /^(.+?)\s*\((\d+)\)$/.exec(who.s)!;
    p.name = normSpaces(m[1]);
    p.employeeId = m[2];
  }
  p.organization = normSpaces(after(/^Организация:\s*/));
  p.department = normSpaces(after(/^Подразделение:\s*/));
  p.position = normSpaces(after(/^Должность:\s*/)).replace(/\s*-\s*/g, '-');
  p.salaryRate = parseNumber(after(/^Оклад \(тариф\):\s*/));

  // Таблица начислений: от строки «Начислено:» до «Долг предприятия на начало».
  const start = rows.findIndex((r) => r.some((i) => /^Начислено:/.test(i.s)));
  const end = rows.findIndex((r) => r.some((i) => /Долг предприятия на начало/.test(i.s)));
  if (start >= 0) {
    const head = rows[start];
    p.gross = parseNumber(head.find((i) => i.x < headerRight && MONEY_RE.test(i.s))?.s ?? '');
    p.withheld = parseNumber(head.find((i) => i.x >= headerRight && MONEY_RE.test(i.s))?.s ?? '');
  }
  if (end >= 0) {
    const r = rows[end];
    const net = r.filter((i) => i.x >= headerRight && MONEY_RE.test(i.s)).pop();
    p.net = parseNumber(net?.s ?? '');
  }

  // Колонки левой таблицы берём из заголовка «Вид / Период / Рабочие / Оплачено / Сумма».
  const headRow = rows.find((r) => r.some((i) => i.s === 'Период') && r.some((i) => i.s === 'Оплачено'));
  const colX = (name: string, fallback: number) => headRow?.find((i) => i.s === name && i.x < headerRight)?.x ?? fallback;
  const xPeriod = colX('Период', 140) - 10;
  const xWork = colX('Рабочие', 195) - 10;
  const xPaid = colX('Оплачено', 250);
  const xSum = colX('Сумма', 300) - 15;

  const bodyRows = start >= 0 ? rows.slice(start + 1, end >= 0 ? end : undefined) : [];
  for (const r of bodyRows) {
    const left = r.filter((i) => i.x < headerRight);
    const right = r.filter((i) => i.x >= headerRight);

    if (left.length) {
      const label = left.filter((i) => i.x < xPeriod).map((i) => i.s).join(' ');
      const rest = left.filter((i) => i.x >= xPeriod);
      const amountItem = rest.filter((i) => i.x >= xSum && MONEY_RE.test(i.s)).pop();
      if (!amountItem) {
        // Перенос длинного названия на следующую строку.
        const prev = p.accruals[p.accruals.length - 1];
        if (prev && label) prev.label = normSpaces(`${prev.label} ${label}`).replace(/\(\s+/g, '(');
      } else {
        const work = rest.filter((i) => i.x >= xWork && i.x < xPaid && i !== amountItem);
        const nums = work.map((i) => parseNumber(i.s));
        // В «Рабочих» два столбца: Дни (целое, левее) и Часы.
        let days: number | null = null;
        let hrs: number | null = null;
        if (nums.length >= 2) {
          days = nums[0];
          hrs = nums[1];
        } else if (nums.length === 1) {
          if (/,/.test(work[0].s) || work[0].x > xWork + 18) hrs = nums[0];
          else days = nums[0];
        }
        p.accruals.push({
          label: normSpaces(label),
          period: rest.find((i) => i.x < xWork && i !== amountItem)?.s ?? '',
          days,
          hours: hrs,
          paid: rest.find((i) => i.x >= xPaid && i.x < xSum && i !== amountItem)?.s ?? '',
          amount: parseNumber(amountItem.s) ?? 0,
        });
      }
    }

    if (right.length && !right.some((i) => /^(Удержано|Выплачено):/.test(i.s))) {
      const amount = right.filter((i) => MONEY_RE.test(i.s)).pop();
      const label = right.filter((i) => !MONEY_RE.test(i.s) && !/^\S+\.\s*\d{4}$/.test(i.s)).map((i) => i.s).join(' ');
      if (amount && label)
        p.deductions.push({
          label: normSpaces(label),
          period: right.find((i) => /\d{4}$/.test(i.s) && !MONEY_RE.test(i.s))?.s ?? '',
          amount: parseNumber(amount.s) ?? 0,
        });
    }
  }
  return p;
}

// ---------- из листка — в данные калькулятора ----------

export type LineKind = 'salary' | 'tier1' | 'tier2' | 'tier3' | 'night' | 'holiday' | 'deadhead' | 'extra';

export function classify(label: string): LineKind {
  const l = label.toLowerCase().replace(/ё/g, 'е');
  if (/оплата по окладу|^по окладу/.test(l)) return 'salary';
  if (/dead\s*head|дедхед|служебн\w* пассажир/.test(l)) return 'deadhead';
  if (/ночн/.test(l)) return 'night';
  if (/праздн/.test(l)) return 'holiday';
  if (/свыше\s*100|санитар/.test(l)) return 'tier3';
  if (/свыше\s*70|от\s*70|70\s*[-–]\s*100/.test(l)) return 'tier2';
  if (/до\s*70/.test(l)) return 'tier1';
  return 'extra';
}

const normPos = (s: string) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();

export function matchPosition(reg: Regulation, title: string): { category: Category; id: string } | null {
  const t = normPos(title);
  for (const category of ['cabin', 'pilot'] as Category[]) {
    const hit = positionsFor(reg, category).find((p) => normPos(p.label) === t);
    if (hit) return { category, id: hit.id };
  }
  return null;
}

export interface PayslipImport {
  month: string | null;
  category: Category;
  positionId: string | null;
  norm: number | null;
  worked: number | null;
  hours: number;
  nightHours: number;
  holidayHours: number;
  deadheadHours: number;
  salary: number | null;
  rate: number | null;
  extras: { title: string; amount: number }[];
  notes: string[];
}

/** Преобразует листок во входные данные калькулятора. Норма месяца выводится из оплаты по окладу. */
export function payslipToInput(reg: Regulation, p: Payslip): PayslipImport {
  const pos = matchPosition(reg, p.position);
  const notes: string[] = [];
  const out: PayslipImport = {
    month: p.month,
    category: pos?.category ?? 'cabin',
    positionId: pos?.id ?? null,
    norm: null,
    worked: null,
    hours: 0,
    nightHours: 0,
    holidayHours: 0,
    deadheadHours: 0,
    salary: p.salaryRate,
    rate: null,
    extras: [],
    notes,
  };
  if (!pos && p.position) notes.push(`Должность «${p.position}» не найдена в справочнике — выберите вручную.`);

  const k3 = pos?.category === 'cabin' ? (findPosition(reg, 'cabin', pos.id)?.cabin?.k3 ?? null) : null;
  for (const l of p.accruals) {
    const kind = classify(l.label);
    const h = l.hours ?? 0;
    switch (kind) {
      case 'salary': {
        out.worked = l.days ?? parseNumber(l.paid.replace(/[^\d,]/g, ''));
        if (p.salaryRate && out.worked && l.amount > 0) out.norm = Math.round((p.salaryRate * out.worked) / l.amount);
        break;
      }
      case 'tier1':
        out.hours += h;
        if (k3 && h > 0) out.rate = Math.round(l.amount / h / k3);
        break;
      case 'tier2':
      case 'tier3':
        out.hours += h;
        break;
      case 'night':
        out.nightHours += h;
        break;
      case 'holiday':
        out.holidayHours += h;
        break;
      case 'deadhead': {
        // В листке — оплачиваемые часы (доля от фактических): переводим в фактические.
        const m = reg.constants.deadheadMultiplier || 1;
        out.deadheadHours += Math.round((h / m) * 100) / 100;
        break;
      }
      default:
        out.extras.push({ title: l.label, amount: l.amount });
    }
  }
  out.hours = Math.round(out.hours * 100) / 100;
  if (pos?.category === 'pilot')
    notes.push('Листки пилотов пока распознаются частично — проверьте часы и строки «Прочее».');
  return out;
}

export interface ReconRow {
  label: string;
  slip: number;
  calc: number;
  diff: number;
  ok: boolean;
}

/** Построчная сверка: что начислено в листке и что получается по Положению. */
export function reconcile(reg: Regulation, settings: Settings, p: Payslip, input: MonthInput): ReconRow[] {
  const r = calculateMonth(reg, settings, input);
  if (r.errors.length) return [];
  const lines = r.periods.flatMap((x) => x.lines);
  const sumBy = (pred: (title: string, ref: string) => boolean) =>
    lines.filter((l) => pred(l.title, l.ref)).reduce((s, l) => s + l.amount, 0);
  const slipBy = (kind: LineKind) => p.accruals.filter((l) => classify(l.label) === kind).reduce((s, l) => s + l.amount, 0);
  const rows: ReconRow[] = [];
  const push = (label: string, slip: number, calc: number) => {
    if (!slip && !calc) return;
    const diff = Math.round((calc - slip) * 100) / 100;
    rows.push({ label, slip, calc, diff, ok: Math.abs(diff) < 1 });
  };
  push('Оклад', slipBy('salary'), sumBy((_, ref) => ref === 'Штатное расписание'));
  push('Налёт до 70 ч', slipBy('tier1'), sumBy((t) => /^Налёт до/.test(t)));
  push('Налёт 70–100 ч', slipBy('tier2'), sumBy((t) => /^Налёт \d/.test(t)));
  push('Свыше 100 ч', slipBy('tier3'), sumBy((t) => /санитарная/.test(t)));
  push('Ночные', slipBy('night'), sumBy((t) => /Ночной/.test(t)));
  push('Праздничные', slipBy('holiday'), sumBy((t) => /Праздничный/.test(t)));
  push('Dead Head', slipBy('deadhead'), sumBy((t) => /Dead Head/.test(t)));
  if (p.gross !== null) push('Начислено', p.gross, r.total);
  const tax = p.deductions.find((d) => /НДФЛ/i.test(d.label));
  if (tax) push('НДФЛ', tax.amount, r.tax);
  if (p.net !== null) push('К выплате', p.net, r.net);
  return rows;
}
