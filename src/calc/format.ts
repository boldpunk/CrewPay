const NBSP = ' ';

/** Убирает погрешность двоичной арифметики (точность 1e-6). */
export function clean(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** Число в русском формате: пробел — разделитель тысяч, запятая — десятичный. */
export function num(x: number, maxDecimals = 2): string {
  const v = clean(x);
  const neg = v < 0;
  const factor = 10 ** maxDecimals;
  const rounded = Math.round(Math.abs(v) * factor) / factor;
  const [intPart, frac = ''] = rounded.toFixed(maxDecimals).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const fracTrim = frac.replace(/0+$/, '');
  return (neg ? '−' : '') + grouped + (fracTrim ? ',' + fracTrim : '');
}

/** Коэффициент из таблиц Положения — всегда два знака: 0,40; 1,00. */
export function coef(x: number): string {
  return clean(x).toFixed(2).replace('.', ',');
}

/** Сумма в сумах: целые, если дробной части нет, иначе до копеек (тийинов). */
export function money(x: number): string {
  return num(x, 2);
}

/** Итог: округление до 1 сум. */
export function moneyRounded(x: number): string {
  return num(Math.round(clean(x)), 0);
}

/** Часы: до 2 знаков. */
export function hours(x: number): string {
  return num(x, 2);
}

/**
 * Разбор ввода часов: "65", "65,5", "65.5", "65:30" (чч:мм).
 * Пустая строка — 0. Некорректный ввод — NaN.
 */
export function parseHours(raw: string): number {
  const s = raw.trim().replace(/\s+/g, '');
  if (s === '') return 0;
  const hm = /^(\d+):([0-5]?\d)$/.exec(s);
  if (hm) return clean(Number(hm[1]) + Number(hm[2]) / 60);
  if (!/^\d+([.,]\d+)?$/.test(s)) return NaN;
  return Number(s.replace(',', '.'));
}

/** Разбор денежного ввода: допускает пробелы-разделители. */
export function parseMoney(raw: string): number {
  const s = raw.replace(/[\s  ]/g, '').replace(',', '.');
  if (s === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}
