import type { Regulation } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

export function isNonWorking(reg: Regulation, d: Date): boolean {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return true;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ymd = `${d.getFullYear()}-${md}`;
  return reg.paymentDays.publicHolidays.includes(md) || reg.paymentDays.publicHolidays.includes(ymd);
}

/** День выплаты в месяце: не позже `day` (или последнего дня месяца), с переносом на канун, если выходной. */
export function payDate(reg: Regulation, year: number, monthIndex: number, day: number): Date {
  const last = new Date(year, monthIndex + 1, 0).getDate();
  const d = new Date(year, monthIndex, Math.min(day, last));
  while (isNonWorking(reg, d)) d.setDate(d.getDate() - 1);
  return d;
}

/**
 * Сроки выплат за расчётный месяц `ym` ("YYYY-MM"), раздел 4 Положения:
 * оклад — до 15-го, сдельная часть — до 30-го следующего месяца.
 */
export function paymentSchedule(reg: Regulation, ym: string): { salary: Date; piece: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  if (month < 0 || month > 11) return null;
  const next = new Date(year, month + 1, 1);
  return {
    salary: payDate(reg, next.getFullYear(), next.getMonth(), reg.paymentDays.salaryDay),
    piece: payDate(reg, next.getFullYear(), next.getMonth(), reg.paymentDays.pieceDay),
  };
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'short' });
}
