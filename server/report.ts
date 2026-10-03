import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { calculateMonth, findPosition, statusesFor } from '../src/calc/engine';
import { money, num } from '../src/calc/format';
import { formatDate, paymentSchedule } from '../src/calc/paydates';
import type { ReconRow } from '../src/calc/payslip';
import type { Regulation, Settings } from '../src/calc/types';
import { type AppState, toMonthInput } from '../src/state';


export interface ReportProfile {
  name?: string;
  employeeId?: string;
  organization?: string;
  department?: string;
}

export interface ReportInput {
  month: string;
  state: Pick<AppState, 'norm' | 'periods' | 'extras'> & { settings: Settings };
  profile: ReportProfile | null;
  recon: { rows: ReconRow[]; filename: string; uploadedAt: Date } | null;
  siteUrl: string;
  generatedAt: Date;
}

const FONT_DIR = fileURLToPath(new URL('./fonts/', import.meta.url));
const TZ = 'Asia/Tashkent';

const C = {
  ink: '#0D1B24',
  ink2: '#33444F',
  muted: '#5D6E78',
  line: '#D5DEE2',
  soft: '#F3F6F7',
  teal: '#0B6E6A',
  ring: '#3CC2B4',
  orange: '#FF6A1F',
  heroMuted: '#93A7B1',
  piece: '#00897B',
  time: '#3D5AFE',
  extra: '#DB5A10',
  ok: '#177245',
  okSoft: '#E1F3E8',
  err: '#B42318',
  errSoft: '#FDECEA',
};

const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function monthTitle(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return y && m ? `${MONTHS_NOM[m - 1]} ${y}` : ym;
}

const plain = (s: string) => s.replace(/[  ]/g, ' ');

function displayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return parts.length >= 2 ? [parts[1], parts[0], ...parts.slice(2)].map(cap).join(' ') : parts.map(cap).join(' ');
}

const fmtDateTime = (d: Date) =>
  d.toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = (d: Date) => d.toLocaleDateString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });

export async function renderReport(reg: Regulation, input: ReportInput): Promise<Buffer> {
  const state = { ...input.state, month: input.month, active: 0, theme: 'system' } as AppState;
  const result = calculateMonth(reg, input.state.settings, toMonthInput(state));
  if (result.errors.length) throw new Error(result.errors.join(' '));

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    bufferPages: true,
    info: {
      Title: `CrewPay — расчёт за ${monthTitle(input.month).toLowerCase()}`,
      Author: input.profile?.name ? displayName(input.profile.name) : 'CrewPay',
      Creator: `CrewPay · ${input.siteUrl}`,
      Producer: 'CrewPay',
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('body', FONT_DIR + 'Onest-400.woff');
  doc.registerFont('semi', FONT_DIR + 'Onest-600.woff');
  doc.registerFont('bold', FONT_DIR + 'Onest-700.woff');
  doc.registerFont('display', FONT_DIR + 'Unbounded-600.woff');
  doc.registerFont('mono', FONT_DIR + 'JetBrainsMono-400.woff');

  const M = 40;
  const W = doc.page.width - M * 2;
  const BOTTOM = doc.page.height - 78; // место под подвал
  let y = M;

  const ensure = (h: number) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = M;
      miniHeader();
    }
  };

  const label = (text: string, x: number, yy: number, w?: number, align: 'left' | 'right' = 'left') => {
    doc.font('semi').fontSize(6.8).fillColor(C.muted).text(text.toUpperCase(), x, yy, { width: w, align, characterSpacing: 0.6, lineBreak: false });
  };

  const sectionTitle = (text: string, note?: string) => {
    ensure(40);
    y += 8;
    doc.font('display').fontSize(10.5).fillColor(C.ink).text(text, M, y, { lineBreak: false });
    if (note) doc.font('body').fontSize(8).fillColor(C.muted).text(note, M, y + 2, { width: W, align: 'right', lineBreak: false });
    y += 22;
  };

  const logo = (x: number, yy: number, size: number) => {
    const s = size / 64;
    doc.save();
    doc.translate(x, yy).scale(s);
    doc.roundedRect(0, 0, 64, 64, 17).fill(C.ink);
    doc.circle(30, 35, 15.5).lineWidth(5.5).stroke(C.ring);
    doc.moveTo(9, 50).bezierCurveTo(23, 48, 37, 38, 48.5, 18.5).lineWidth(5.5).lineCap('round').stroke(C.orange);
    doc.circle(50, 16, 5.5).fill(C.orange);
    doc.restore();
  };

  const wordmark = (x: number, yy: number, size: number) => {
    doc.font('display').fontSize(size).fillColor(C.ink).text('Crew', x, yy, { continued: true, lineBreak: false });
    doc.fillColor(C.orange).text('Pay', { lineBreak: false });
  };

  const miniHeader = () => {
    logo(M, y, 18);
    wordmark(M + 24, y + 2, 10);
    doc.font('body').fontSize(8).fillColor(C.muted).text(`Расчёт · ${monthTitle(input.month)}`, M, y + 4, { width: W, align: 'right', lineBreak: false });
    y += 30;
  };

  // ---------- шапка ----------
  logo(M, y, 32);
  wordmark(M + 42, y + 7, 16);
  label('Расчёт заработной платы', M, y + 2, W, 'right');
  doc.font('display').fontSize(15).fillColor(C.ink).text(monthTitle(input.month), M, y + 13, { width: W, align: 'right', lineBreak: false });
  y += 46;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.7).stroke(C.line);
  y += 14;

  // ---------- сотрудник ----------
  const p0 = input.state.periods[0];
  const positions = input.state.periods
    .map((p) => {
      const pos = findPosition(reg, p.category, p.positionId);
      const ac = pos?.needsAircraft && p.aircraft >= 0 ? `, ${reg.aircraft[p.aircraft]}` : '';
      return pos ? pos.label + ac : '';
    })
    .filter(Boolean)
    .join(' → ');
  const status = statusesFor(reg, p0.category).find((s) => s.id === p0.statusId);
  const pr = input.profile ?? {};
  const facts: [string, string][] = (
    [
      ['Сотрудник', pr.name ? displayName(pr.name) : ''],
      ['Табельный №', pr.employeeId ?? ''],
      ['Организация', pr.organization ?? ''],
      ['Подразделение', pr.department ?? ''],
      ['Должность', positions],
      ['Допуск', status?.label ?? ''],
    ] as [string, string][]
  ).filter(([, v]) => v);
  const colW = (W - 20) / 3;
  facts.forEach(([k, v], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = M + col * (colW + 10);
    const yy = y + row * 34;
    label(k, x, yy, colW);
    doc.font('semi').fontSize(9.5).fillColor(C.ink).text(v, x, yy + 10, { width: colW, height: 22, ellipsis: true });
  });
  y += Math.ceil(facts.length / 3) * 34 + 6;

  // ---------- итог ----------
  const heroH = 96;
  doc.roundedRect(M, y, W, heroH, 14).fill(C.ink);
  // «миллиметровка» дисплея
  doc.save();
  doc.roundedRect(M, y, W, heroH, 14).clip();
  doc.lineWidth(0.4).strokeColor('#1F2E37');
  for (let gx = M + 18; gx < M + W; gx += 18) doc.moveTo(gx, y).lineTo(gx, y + heroH).stroke();
  for (let gy = y + 18; gy < y + heroH; gy += 18) doc.moveTo(M, gy).lineTo(M + W, gy).stroke();
  doc.restore();
  doc.roundedRect(M + 18, y, 36, 3.5, 1.5).fill(C.orange);
  doc.font('semi').fontSize(7).fillColor(C.heroMuted).text('К ВЫПЛАТЕ', M + 18, y + 18, { characterSpacing: 0.8, lineBreak: false });
  const netStr = plain(money(result.net));
  doc.font('display').fontSize(25).fillColor('#FFFFFF').text(netStr, M + 18, y + 32, { lineBreak: false });
  const netW = doc.widthOfString(netStr);
  doc.font('semi').fontSize(10).fillColor(C.heroMuted).text('сум', M + 18 + netW + 6, y + 44, { lineBreak: false });
  if (input.recon && input.recon.rows.length) {
    const bad = input.recon.rows.filter((r) => !r.ok).length;
    doc.circle(M + 21, y + 77, 3).fill(bad ? '#FF8A80' : '#4ADE80');
    doc.font('semi').fontSize(7.8).fillColor(bad ? '#FFB4B4' : '#9BE7B4').text(
      bad ? `Расхождения с расчётным листком: ${bad}` : 'Совпадает с расчётным листком',
      M + 29,
      y + 73,
      { lineBreak: false },
    );
  } else {
    doc.font('body').fontSize(7.5).fillColor(C.heroMuted).text(`Брутто ${plain(money(result.total))} − НДФЛ ${plain(money(result.tax))}`, M + 18, y + 72, { lineBreak: false });
  }

  const rx = M + W - 190;
  const heroRow = (k: string, v: string, yy: number, strong = false) => {
    doc.font('body').fontSize(8).fillColor(C.heroMuted).text(k, rx, yy, { width: 90, lineBreak: false });
    doc.font(strong ? 'semi' : 'body').fontSize(strong ? 10 : 9).fillColor('#FFFFFF').text(v, rx + 70, yy - (strong ? 1 : 0), { width: 102, align: 'right', lineBreak: false });
  };
  heroRow('Начислено', plain(money(result.total)), y + 20, true);
  heroRow(`НДФЛ ${num(reg.constants.incomeTaxRate * 100)} %`, `−${plain(money(result.tax))}`, y + 40);
  heroRow('в т. ч. ИНПС', plain(money(result.inps)), y + 58);
  y += heroH + 14;

  // ---------- состав ----------
  const parts = [
    { label: 'Сдельная часть', value: result.piece, color: C.piece },
    { label: 'Оклад', value: result.time, color: C.time },
    { label: 'Прочие начисления', value: result.extras, color: C.extra },
  ].filter((x) => x.value > 0);
  if (parts.length && result.total > 0) {
    const gap = 2;
    const avail = W - gap * (parts.length - 1);
    let x = M;
    parts.forEach((p, i) => {
      const w = Math.max(3, (p.value / result.total) * avail);
      const r = i === 0 || i === parts.length - 1 ? 3 : 0;
      doc.roundedRect(x, y, w, 7, r).fill(p.color);
      x += w + gap;
    });
    y += 14;
    let lx = M;
    for (const p of parts) {
      doc.roundedRect(lx, y + 1.5, 7, 7, 2).fill(p.color);
      const t = `${p.label}  ${plain(money(p.value))}  ·  ${num((p.value / result.total) * 100, 0)} %`;
      doc.font('body').fontSize(8).fillColor(C.ink2).text(t, lx + 11, y, { lineBreak: false });
      lx += doc.widthOfString(t) + 30;
    }
    y += 20;
  }

  // ---------- строки ----------
  sectionTitle('Расчёт по строкам', 'по Положению ' + reg.regulation.code);
  const cTitle = 190;
  const cFormula = W - cTitle - 110;
  label('Вид начисления', M, y);
  label('Расчёт', M + cTitle + 10, y);
  label('Сумма, сум', M, y, W, 'right');
  y += 12;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.7).stroke(C.ink);
  y += 6;

  const row = (title: string, ref: string, formula: string, amount: string, accent: string, dim = false) => {
    doc.font('semi').fontSize(9.2);
    const hTitle = doc.heightOfString(title, { width: cTitle - 12 });
    doc.font('mono').fontSize(7.6);
    const hFormula = formula ? doc.heightOfString(formula, { width: cFormula }) : 0;
    const h = Math.max(hTitle + 11, hFormula + 2, 18) + 8;
    ensure(h);
    doc.rect(M, y + 2, 2.5, h - 12).fill(accent);
    doc.font('semi').fontSize(9.2).fillColor(dim ? C.muted : C.ink).text(title, M + 10, y, { width: cTitle - 12 });
    doc.font('mono').fontSize(6.8).fillColor(C.muted).text(ref, M + 10, y + hTitle + 1, { width: cTitle - 12, lineBreak: false });
    if (formula) doc.font('mono').fontSize(7.6).fillColor(C.ink2).text(formula, M + cTitle + 10, y + 1, { width: cFormula });
    doc.font('semi').fontSize(9.5).fillColor(dim ? C.muted : C.ink).text(amount, M + W - 100, y, { width: 100, align: 'right', lineBreak: false });
    y += h;
    doc.moveTo(M, y - 4).lineTo(M + W, y - 4).lineWidth(0.5).stroke(C.line);
  };

  result.periods.forEach((pr2, i) => {
    if (result.periods.length > 1) {
      ensure(24);
      const pos = findPosition(reg, input.state.periods[i].category, input.state.periods[i].positionId);
      doc.font('semi').fontSize(7.5).fillColor(C.muted).text(`ПЕРИОД ${i + 1} · ${(pos?.label ?? '').toUpperCase()}`, M, y + 2, { characterSpacing: 0.5, lineBreak: false });
      y += 16;
    }
    for (const l of pr2.lines) {
      const accent = l.part === 'time' ? C.time : l.part === 'info' ? C.line : C.piece;
      row(l.title, l.ref, plain(l.formula), l.part === 'info' ? '—' : plain(money(l.amount)), accent, l.part === 'info');
    }
  });
  for (const x of input.state.extras) {
    const v = Number(String(x.amount).replace(/[\s ]/g, '').replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0) continue;
    row(x.title.trim() || 'Прочее начисление', 'из расчётного листка', '', plain(money(v)), C.extra);
  }

  // итоги
  ensure(110);
  y += 4;
  const tx = M + W - 240;
  const total = (k: string, v: string, opts: { strong?: boolean; big?: boolean; rule?: number } = {}) => {
    if (opts.rule) {
      doc.moveTo(tx, y - 3).lineTo(M + W, y - 3).lineWidth(opts.rule).stroke(C.ink);
      y += 3;
    }
    doc.font(opts.strong ? 'semi' : 'body').fontSize(opts.big ? 10.5 : 9).fillColor(opts.strong ? C.ink : C.muted).text(k, tx, y, { lineBreak: false });
    doc.font(opts.big ? 'display' : opts.strong ? 'semi' : 'body').fontSize(opts.big ? 12 : 9.5).fillColor(C.ink).text(v, tx, y - (opts.big ? 2 : 0), { width: 240, align: 'right', lineBreak: false });
    y += opts.big ? 22 : 16;
  };
  total('Сдельная часть', plain(money(result.piece)));
  total('Повременная часть', plain(money(result.time)));
  if (result.extras) total('Прочие начисления', plain(money(result.extras)));
  total('Начислено', plain(money(result.total)), { strong: true, rule: 0.6 });
  total(`НДФЛ ${num(reg.constants.incomeTaxRate * 100)} %, вкл. ИНПС`, `−${plain(money(result.tax))}`);
  total('К выплате', `${plain(money(result.net))} сум`, { strong: true, big: true, rule: 1.4 });

  // ---------- сверка ----------
  if (input.recon && input.recon.rows.length) {
    const bad = input.recon.rows.filter((r) => !r.ok).length;
    // Сверку не разрываем: заголовок, плашка и таблица — на одной странице.
    ensure(30 + 34 + 18 + input.recon.rows.length * 18 + 10);
    sectionTitle(
      'Сверка с расчётным листком',
      `${input.recon.filename} · загружен ${fmtDate(input.recon.uploadedAt)}`,
    );
    ensure(30);
    const okAll = bad === 0;
    doc.roundedRect(M, y, W, 24, 8).fill(okAll ? C.okSoft : C.errSoft);
    doc.circle(M + 14, y + 12, 4).fill(okAll ? C.ok : C.err);
    doc.font('semi').fontSize(9).fillColor(okAll ? C.ok : C.err).text(
      okAll
        ? `Все ${input.recon.rows.length} строк совпадают с листком — начисление верное.`
        : `Расхождений: ${bad} из ${input.recon.rows.length}. Проверьте строки, отмеченные красным.`,
      M + 26,
      y + 7.5,
      { lineBreak: false },
    );
    y += 34;
    const cols = [M, M + 170, M + 270, M + 370, M + W - 80];
    label('Строка', cols[0], y);
    label('Листок', cols[1], y, 90, 'right');
    label('Расчёт', cols[2], y, 90, 'right');
    label('Разница', cols[3], y, 80, 'right');
    label('Итог', cols[4], y, 80, 'right');
    y += 12;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.7).stroke(C.ink);
    y += 6;
    for (const r of input.recon.rows) {
      ensure(20);
      doc.font('semi').fontSize(9).fillColor(C.ink).text(r.label, cols[0], y, { lineBreak: false });
      doc.font('body').fontSize(9).fillColor(C.ink2).text(plain(money(r.slip)), cols[1], y, { width: 90, align: 'right', lineBreak: false });
      doc.text(plain(money(r.calc)), cols[2], y, { width: 90, align: 'right', lineBreak: false });
      doc.fillColor(r.ok ? C.muted : C.err).text(r.ok ? '0' : `${r.diff > 0 ? '+' : '−'}${plain(money(Math.abs(r.diff)))}`, cols[3], y, { width: 80, align: 'right', lineBreak: false });
      const pill = r.ok ? 'совпадает' : 'расхождение';
      doc.font('semi').fontSize(7.5);
      const pw = doc.widthOfString(pill) + 14;
      doc.roundedRect(M + W - pw, y - 2.5, pw, 14, 7).fill(r.ok ? C.okSoft : C.errSoft);
      doc.fillColor(r.ok ? C.ok : C.err).text(pill, M + W - pw, y + 0.5, { width: pw, align: 'center', lineBreak: false });
      y += 18;
      doc.moveTo(M, y - 4).lineTo(M + W, y - 4).lineWidth(0.5).stroke(C.line);
    }
  }

  // ---------- примечания и сроки ----------
  const notes = [...result.warnings, ...result.periods.flatMap((p) => p.notes)];
  const schedule = paymentSchedule(reg, input.month);
  if (notes.length || schedule) {
    sectionTitle('Примечания');
    doc.font('body').fontSize(8).fillColor(C.ink2);
    const items = [
      ...(schedule
        ? [`Сроки выплат: оклад — до ${formatDate(schedule.salary)}, сдельная часть — до ${formatDate(schedule.piece)}`]
        : []),
      ...notes,
    ];
    for (const n of items) {
      const h = doc.heightOfString(n, { width: W - 12 });
      ensure(h + 6);
      doc.circle(M + 3, y + 4.5, 1.6).fill(C.teal);
      doc.font('body').fontSize(8).fillColor(C.ink2).text(plain(n), M + 12, y, { width: W - 12 });
      y += h + 5;
    }
  }

  // ---------- подвал на каждой странице ----------
  const range = doc.bufferedPageRange();
  const host = input.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Подвал рисуется ниже нижнего поля — иначе pdfkit сам добавит страницу.
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 58;
    doc.moveTo(M, fy).lineTo(M + W, fy).lineWidth(0.7).stroke(C.line);
    logo(M, fy + 10, 14);
    doc.font('body').fontSize(7.5).fillColor(C.muted).text('Сформировано на сайте', M + 20, fy + 9, { continued: true, lineBreak: false });
    doc.font('semi').fillColor(C.teal).text(` ${host}`, { link: input.siteUrl, underline: false, continued: true, lineBreak: false });
    doc.font('body').fillColor(C.muted).text(` · ${fmtDateTime(input.generatedAt)}`, { lineBreak: false });
    doc.font('body').fontSize(6.6).fillColor(C.muted).text(
      `Справочный расчёт по Положению ${reg.regulation.code}; не заменяет расчётный листок работодателя.`,
      M + 20,
      fy + 20,
      { lineBreak: false },
    );
    doc.font('body').fontSize(7.5).fillColor(C.muted).text(`Стр. ${i - range.start + 1} из ${range.count}`, M, fy + 9, { width: W, align: 'right', lineBreak: false });
    doc.font('semi').fontSize(6.6);
    const studioW = doc.widthOfString('boldstudio.uz');
    doc.font('body').fontSize(6.6);
    const creditW = doc.widthOfString('Дизайн и разработка — ');
    doc.fillColor(C.muted).text('Дизайн и разработка — ', M + W - studioW - creditW, fy + 20, { lineBreak: false });
    doc.font('semi').fontSize(6.6).fillColor(C.orange).text('boldstudio.uz', M + W - studioW, fy + 20, { link: 'https://boldstudio.uz', lineBreak: false });
    // клик по всей строке «Сформировано на сайте …» ведёт на сайт
    doc.link(M + 20, fy + 7, 260, 11, input.siteUrl);
  }

  doc.end();
  return done;
}
