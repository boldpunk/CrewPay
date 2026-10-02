import './style.css';
import bundledRegulation from '../public/regulation.json';
import {
  availableAircraft,
  calculateMonth,
  findPosition,
  positionsFor,
  statusesFor,
} from './calc/engine';
import { coef, hours as fmtHours, money, moneyRounded, num, parseMoney } from './calc/format';
import { formatDate, paymentSchedule } from './calc/paydates';
import type { Category, MonthResult, Regulation } from './calc/types';
import {
  type AppState,
  type HistoryEntry,
  type PeriodForm,
  defaultPeriod,
  defaultState,
  loadHistory,
  loadState,
  saveHistory,
  saveState,
  toMonthInput,
} from './state';

type View = 'calc' | 'reference' | 'history' | 'settings';

/** Сборка для предпросмотра во встроенном окне (claude.ai): там нет печати и service worker. */
const IS_EMBED = import.meta.env.VITE_TARGET === 'embed';
const CAN_PRINT = !IS_EMBED;

let reg: Regulation = bundledRegulation as Regulation;
let state: AppState;
let history: HistoryEntry[] = [];
let view: View = 'calc';
let lastResult: MonthResult | null = null;

const app = document.getElementById('app')!;

// ---------- helpers ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);

function period(): PeriodForm {
  return state.periods[state.active];
}

function persist() {
  saveState(state);
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  const s = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1).replace(' г.', '');
}

function isValidRegulation(x: unknown): x is Regulation {
  const r = x as Regulation;
  return (
    !!r &&
    Array.isArray(r.aircraft) &&
    !!r.pilot &&
    Array.isArray(r.pilot.guaranteed) &&
    !!r.cabin &&
    Array.isArray(r.cabin.positions) &&
    !!r.constants &&
    !!r.regulation
  );
}

/** Справочник грузится с сервера, чтобы администратор мог менять ставки без релиза. */
async function loadRegulation(): Promise<Regulation> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}regulation.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const data: unknown = await res.json();
    if (isValidRegulation(data)) return data;
  } catch {
    /* офлайн или файл недоступен — используем встроенную копию */
  }
  return bundledRegulation as Regulation;
}

// ---------- shell ----------

function renderShell() {
  const tabs: [View, string][] = [
    ['calc', 'Расчёт'],
    ['history', 'История'],
    ['reference', 'Справочники'],
    ['settings', 'Настройки'],
  ];
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>
        <div>
          <div class="brand-name">CrewPay</div>
          <div class="brand-sub">Положение ${esc(reg.regulation.code)}, изд.&nbsp;${reg.regulation.edition}</div>
        </div>
      </div>
      <nav class="tabs" role="tablist">
        ${tabs
          .map(
            ([id, label]) =>
              `<button role="tab" class="tab${view === id ? ' active' : ''}" data-view="${id}" aria-selected="${view === id}">${label}</button>`,
          )
          .join('')}
      </nav>
    </header>
    <main id="view"></main>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
  `;
  app.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      view = b.dataset.view as View;
      renderShell();
      window.scrollTo({ top: 0 });
    }),
  );
  renderView();
}

function renderView() {
  const root = $('#view')!;
  if (view === 'calc') renderCalc(root);
  else if (view === 'reference') renderReference(root);
  else if (view === 'history') renderHistory(root);
  else renderSettings(root);
}

/** Подтверждение внутри страницы (нативный confirm() недоступен во встроенных окнах и плохо выглядит на телефоне). */
function ask(message: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-msg">
        <p id="modal-msg">${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn" data-answer="no">Отмена</button>
          <button class="btn ${danger ? 'danger-fill' : 'primary'}" data-answer="yes">${esc(okLabel)}</button>
        </div>
      </div>`;
    const close = (answer: boolean) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (prevFocus?.isConnected) prevFocus.focus();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    overlay.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === overlay) return close(false);
      const a = t.closest<HTMLElement>('[data-answer]')?.dataset.answer;
      if (a) close(a === 'yes');
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('[data-answer=yes]')!.focus();
  });
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- calculator ----------

function field(
  name: keyof PeriodForm | 'norm',
  label: string,
  value: string,
  opts: { hint?: string; placeholder?: string; mode?: 'decimal' | 'numeric'; suffix?: string } = {},
) {
  return `
    <label class="field">
      <span class="field-label">${label}</span>
      <span class="input-wrap">
        <input type="text" inputmode="${opts.mode ?? 'decimal'}" autocomplete="off" spellcheck="false"
          name="${name}" value="${esc(value)}" placeholder="${esc(opts.placeholder ?? '0')}" />
        ${opts.suffix ? `<span class="suffix">${opts.suffix}</span>` : ''}
      </span>
      ${opts.hint ? `<span class="field-hint">${opts.hint}</span>` : ''}
    </label>`;
}

/** Денежное значение с разделителями тысяч (если введено корректно). */
function prettyMoney(raw: string): string {
  const v = parseMoney(raw);
  return raw.trim() !== '' && Number.isFinite(v) ? num(v) : raw;
}

function renderCalc(root: HTMLElement) {
  document.body.classList.remove('typing');
  const p = period();
  const position = findPosition(reg, p.category, p.positionId);
  const positions = positionsFor(reg, p.category);
  const avail = availableAircraft(reg, position);
  const statuses = statusesFor(reg, p.category);
  const unit = state.settings.proportionBasis === 'days' ? 'дн.' : 'ч';
  const isFixed = position?.kind === 'fixed';
  const multi = state.periods.length > 1;

  const groups: [string, string][] =
    p.category === 'pilot'
      ? [
          ['guaranteed', 'С гарантированным налётом'],
          ['normative', 'С нормативным налётом (20 ч)'],
          ['fixed', 'Фиксированный оклад'],
        ]
      : [
          ['cabin', 'Сдельная оплата'],
          ['cabinIncluded', 'Налёт до 30 ч в окладе (п. 3.2)'],
          ['fixed', 'Фиксированный оклад'],
        ];

  root.innerHTML = `
    <div class="layout">
      <section class="panel form-panel" aria-label="Ввод данных">
        <div class="month-row">
          <label class="field month-field">
            <span class="field-label">Расчётный месяц</span>
            <input type="month" name="month" value="${esc(state.month)}" />
          </label>
          ${field('norm', `Норма месяца, ${unit}`, state.norm, {
            placeholder: state.settings.proportionBasis === 'days' ? 'напр. 22' : 'напр. 176',
            hint: 'По производственному календарю',
          })}
        </div>

        <div class="periods" role="tablist" aria-label="Периоды">
          ${state.periods
            .map(
              (_, i) =>
                `<button class="chip${i === state.active ? ' active' : ''}" data-period="${i}">Период ${i + 1}</button>`,
            )
            .join('')}
          ${
            multi
              ? `<button class="chip ghost danger" data-action="remove-period" title="Удалить период ${state.active + 1}">Удалить период</button>`
              : `<button class="chip ghost" data-action="add-period" title="П. 2.15 — перевод на другую должность в течение месяца">+ Перевод в течение месяца</button>`
          }
        </div>

        <fieldset class="group">
          <legend>Должность</legend>
          <div class="segmented" role="radiogroup" aria-label="Категория">
            ${(['pilot', 'cabin'] as Category[])
              .map(
                (c) => `
              <button role="radio" aria-checked="${p.category === c}" class="seg${p.category === c ? ' active' : ''}" data-category="${c}">
                ${c === 'pilot' ? 'ЧЛЭ · пилоты' : 'ЧКЭ · бортпроводники'}
              </button>`,
              )
              .join('')}
          </div>
          <label class="field">
            <span class="field-label">Должность в полёте</span>
            <select name="positionId">
              ${groups
                .map(([kind, title]) => {
                  const opts = positions.filter((x) => x.kind === kind);
                  if (!opts.length) return '';
                  return `<optgroup label="${esc(title)}">${opts
                    .map(
                      (o) =>
                        `<option value="${esc(o.id)}"${o.id === p.positionId ? ' selected' : ''}>${esc(o.label)}${o.ref ? ` (${esc(o.ref)})` : ''}</option>`,
                    )
                    .join('')}</optgroup>`;
                })
                .join('')}
            </select>
          </label>
          ${
            position?.needsAircraft
              ? `
          <div class="field">
            <span class="field-label">Тип ВС</span>
            <div class="aircraft" role="radiogroup" aria-label="Тип ВС">
              ${reg.aircraft
                .map((a, i) => {
                  const ok = avail.includes(i);
                  return `<button role="radio" class="ac${p.aircraft === i ? ' active' : ''}" data-aircraft="${i}" ${ok ? '' : 'disabled title="Не предусмотрено Положением для этой должности"'} aria-checked="${p.aircraft === i}">${esc(a)}</button>`;
                })
                .join('')}
            </div>
          </div>`
              : ''
          }
        </fieldset>

        ${
          isFixed
            ? ''
            : `
        <fieldset class="group">
          <legend>Налёт за ${multi ? 'период' : 'месяц'}</legend>
          <div class="grid2">
            ${field('hours', 'Фактический налёт', p.hours, { suffix: 'ч', hint: 'Всего, включая ночные и праздничные. Можно «65:30»' })}
            ${field('nightHours', 'Из них ночной', p.nightHours, { suffix: 'ч' })}
            ${field('holidayHours', 'Из них праздничный', p.holidayHours, { suffix: 'ч' })}
            ${field('nightHolidayHours', 'Ночью в праздник', p.nightHolidayHours, { suffix: 'ч', hint: 'Входят и в ночные, и в праздничные' })}
            ${field('deadheadHours', 'Перелёт Dead Head', p.deadheadHours, { suffix: 'ч', hint: 'Справочно, не оплачивается' })}
          </div>
        </fieldset>`
        }

        <fieldset class="group">
          <legend>Время и допуск</legend>
          <div class="grid2">
            ${field('worked', `Отработано, ${unit}`, p.worked, {
              placeholder: multi ? '0' : '= норме',
              hint: 'Отпуск и больничный уменьшают гарантию и норматив',
            })}
            <label class="field">
              <span class="field-label">Статус допуска</span>
              <select name="statusId">
                ${statuses
                  .map(
                    (s) =>
                      `<option value="${esc(s.id)}"${s.id === p.statusId ? ' selected' : ''}>${esc(s.label)}${s.ref ? ` — ${esc(s.ref)}` : ''}</option>`,
                  )
                  .join('')}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset class="group">
          <legend>Ставки</legend>
          <div class="grid2">
            ${field('salary', 'Должностной оклад', prettyMoney(p.salary), {
              mode: 'numeric',
              suffix: 'сум',
              placeholder: 'из штатного расписания',
              hint: isFixed ? 'Для этой должности — вся оплата' : 'Необязательно',
            })}
            ${
              isFixed
                ? ''
                : field('rate', 'Часовая ставка', prettyMoney(p.rate), {
                    mode: 'numeric',
                    suffix: 'сум',
                    hint: `По умолчанию ${money(p.category === 'pilot' ? reg.pilot.defaultRate : reg.cabin.defaultRate)} (п. 2.5)`,
                  })
            }
          </div>
        </fieldset>

        <div class="form-actions">
          <button class="btn ghost" data-action="new-month">Новый месяц</button>
          <span class="muted small">Профиль сохраняется на этом устройстве</span>
        </div>
      </section>

      <section class="panel result-panel" id="result" aria-live="polite" aria-label="Результат"></section>
    </div>
    <a href="#result" class="sticky-total" id="sticky-total" aria-label="Перейти к результату"></a>
  `;

  bindCalc(root);
  renderResult();
}

function bindCalc(root: HTMLElement) {
  root.querySelectorAll<HTMLInputElement>('input, select').forEach((el) => {
    // На телефоне плавающий итог не должен закрывать поле ввода над клавиатурой.
    el.addEventListener('focus', () => document.body.classList.add('typing'));
    el.addEventListener('blur', () => document.body.classList.remove('typing'));
  });

  root.querySelectorAll<HTMLInputElement>('input[type=text]').forEach((input) => {
    input.addEventListener('input', () => {
      const name = input.name as keyof PeriodForm | 'norm';
      if (name === 'norm') state.norm = input.value;
      else (period() as unknown as Record<string, string>)[name] = input.value;
      persist();
      renderResult();
    });
    if (input.inputMode === 'numeric') {
      input.addEventListener('blur', () => {
        const v = parseMoney(input.value);
        if (input.value.trim() !== '' && Number.isFinite(v)) {
          input.value = num(v);
          (period() as unknown as Record<string, string>)[input.name] = input.value;
          persist();
        }
      });
    }
  });

  $<HTMLInputElement>('input[name=month]', root)!.addEventListener('change', (e) => {
    state.month = (e.target as HTMLInputElement).value;
    persist();
    renderResult();
  });

  $<HTMLSelectElement>('select[name=positionId]', root)!.addEventListener('change', (e) => {
    const p = period();
    p.positionId = (e.target as HTMLSelectElement).value;
    const avail = availableAircraft(reg, findPosition(reg, p.category, p.positionId));
    if (!avail.includes(p.aircraft)) p.aircraft = avail.length === 1 ? avail[0] : -1;
    persist();
    renderCalc(root);
  });

  $<HTMLSelectElement>('select[name=statusId]', root)!.addEventListener('change', (e) => {
    period().statusId = (e.target as HTMLSelectElement).value;
    persist();
    renderResult();
  });

  root.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((b) =>
    b.addEventListener('click', () => {
      const cat = b.dataset.category as Category;
      const p = period();
      if (p.category === cat) return;
      const fresh = defaultPeriod(reg, cat);
      // Часы и время сохраняем, должность/ставка/статус — по умолчанию для категории.
      Object.assign(p, {
        category: cat,
        positionId: fresh.positionId,
        aircraft: -1,
        statusId: fresh.statusId,
        rate: fresh.rate,
      });
      persist();
      renderCalc(root);
    }),
  );

  root.querySelectorAll<HTMLButtonElement>('[data-aircraft]').forEach((b) =>
    b.addEventListener('click', () => {
      period().aircraft = Number(b.dataset.aircraft);
      persist();
      renderCalc(root);
    }),
  );

  root.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((b) =>
    b.addEventListener('click', () => {
      state.active = Number(b.dataset.period);
      persist();
      renderCalc(root);
    }),
  );

  $('[data-action=add-period]', root)?.addEventListener('click', () => {
    const src = period();
    state.periods.push({
      ...src,
      positionId: src.positionId,
      hours: '',
      nightHours: '',
      holidayHours: '',
      nightHolidayHours: '',
      deadheadHours: '',
      worked: '',
    });
    if (src.worked.trim() === '') src.worked = state.norm;
    state.active = state.periods.length - 1;
    persist();
    renderCalc(root);
    toast('Добавлен период 2 — укажите новую должность и часы');
  });

  $('[data-action=remove-period]', root)?.addEventListener('click', async () => {
    if (!(await ask(`Удалить период ${state.active + 1}?`, 'Удалить', true))) return;
    state.periods.splice(state.active, 1);
    state.active = 0;
    persist();
    renderCalc(root);
  });

  $('[data-action=new-month]', root)!.addEventListener('click', async () => {
    if (!(await ask('Очистить часы и начать новый месяц? Должность, тип ВС, оклад и ставка сохранятся.', 'Начать новый месяц'))) return;
    const first = state.periods[0];
    state.periods = [
      { ...first, hours: '', nightHours: '', holidayHours: '', nightHolidayHours: '', deadheadHours: '', worked: '' },
    ];
    state.active = 0;
    state.norm = '';
    const [y, m] = state.month.split('-').map(Number);
    if (y && m) {
      const next = new Date(y, m, 1);
      state.month = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    }
    persist();
    renderCalc(root);
  });
}

function renderResult() {
  const root = $('#result');
  const sticky = $('#sticky-total');
  if (!root) return;
  const result = calculateMonth(reg, state.settings, toMonthInput(state));
  lastResult = result;
  const multi = result.periods.length > 1;
  const ok = !result.errors.length;
  const schedule = paymentSchedule(reg, state.month);

  // Незаполненная форма — это не ошибка: показываем, что осталось ввести.
  const missing: string[] = [];
  if (state.norm.trim() === '') missing.push('норму месяца');
  state.periods.forEach((p, i) => {
    const pos = findPosition(reg, p.category, p.positionId);
    if (pos?.needsAircraft && p.aircraft < 0) missing.push(multi ? `тип ВС (период ${i + 1})` : 'тип ВС');
  });
  const incomplete = !ok && missing.length > 0;
  if (incomplete) result.errors = result.errors.filter((e) => !/Норма рабочего|Выберите тип ВС/.test(e));

  if (sticky) {
    sticky.innerHTML = ok
      ? `<span>Итого</span><strong>${moneyRounded(result.total)} сум</strong>`
      : incomplete && !result.errors.length
        ? `<span>Укажите ${esc(missing.join(', '))}</span><span aria-hidden="true">↓</span>`
        : `<span class="err-dot"></span><span>Проверьте данные</span>`;
    sticky.classList.toggle('error', !ok && !(incomplete && !result.errors.length));
  }

  const lineRows = result.periods
    .map((pr, i) => {
      const head = multi
        ? `<tr class="period-head"><td colspan="3">Период ${i + 1} · ${esc(findPosition(reg, state.periods[i].category, state.periods[i].positionId)?.label ?? '')}</td></tr>`
        : '';
      return (
        head +
        pr.lines
          .map(
            (l) => `
          <tr class="${l.part}">
            <td class="kind"><div>${esc(l.title)}</div><div class="ref">${esc(l.ref)}</div></td>
            <td class="formula">${esc(l.formula)}</td>
            <td class="amount">${l.part === 'info' ? '—' : money(l.amount)}</td>
          </tr>`,
          )
          .join('')
      );
    })
    .join('');

  const hints = result.periods.flatMap((pr, i) =>
    pr.hints.map((hnt) => `<span class="hint-chip">${multi ? `П${i + 1}: ` : ''}${esc(hnt.label)}: <b>${fmtHours(hnt.hours)} ч</b></span>`),
  );
  const notes = result.periods.flatMap((pr) => pr.notes);

  root.innerHTML = `
    <div class="total-card${ok ? '' : ' muted-card'}">
      <div class="total-label">Итого начислено за ${esc(monthLabel(state.month).toLowerCase())}</div>
      <div class="total-value">${ok ? `${moneyRounded(result.total)} <span class="cur">сум</span>` : '—'}</div>
      <div class="subtotals">
        <div><span>Сдельная часть</span><b>${ok ? money(result.piece) : '—'}</b></div>
        <div><span>Повременная (оклад)</span><b>${ok ? money(result.time) : '—'}</b></div>
      </div>
      <div class="gross-note">Брутто, до налогов и удержаний</div>
    </div>

    ${incomplete ? `<div class="alert info">Чтобы посчитать, укажите ${esc(missing.join(', '))}.</div>` : ''}
    ${
      result.errors.length
        ? `<div class="alert error"><b>Исправьте данные:</b><ul>${result.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
        : ''
    }
    ${
      result.warnings.length
        ? `<div class="alert warn"><ul>${result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
        : ''
    }

    ${ok && hints.length ? `<div class="hints">${hints.join('')}</div>` : ''}

    ${
      ok && lineRows
        ? `
    <table class="lines">
      <thead><tr><th>Вид начисления</th><th>Расчёт</th><th class="amount">Сумма, сум</th></tr></thead>
      <tbody>${lineRows}</tbody>
      <tfoot>
        <tr><td colspan="2">Сдельная часть</td><td class="amount">${money(result.piece)}</td></tr>
        <tr><td colspan="2">Повременная часть</td><td class="amount">${money(result.time)}</td></tr>
        <tr class="grand"><td colspan="2">Итого <span class="ref">округлено до 1 сум</span></td><td class="amount">${moneyRounded(result.total)}</td></tr>
      </tfoot>
    </table>`
        : ''
    }

    ${ok && notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}

    ${
      schedule
        ? `
    <div class="paydates">
      <div class="paydates-title">Сроки выплат</div>
      <div class="paydate"><span>Оклад</span><b>до ${esc(formatDate(schedule.salary))}</b></div>
      <div class="paydate"><span>Сдельная часть</span><b>до ${esc(formatDate(schedule.piece))}</b></div>
      <div class="muted small">Если день выплаты выходной — перенос на канун (раздел 4).</div>
    </div>`
        : ''
    }

    <div class="result-actions">
      <button class="btn primary" data-action="save-history" ${ok ? '' : 'disabled'}>Сохранить в историю</button>
      ${CAN_PRINT ? `<button class="btn" data-action="print" ${ok ? '' : 'disabled'}>PDF / Печать</button>` : ''}
    </div>
    <div class="print-only print-meta">
      ${esc(monthLabel(state.month))} · Положение ${esc(reg.regulation.code)}, изд. ${reg.regulation.edition}, рев. ${reg.regulation.revision} ·
      ${esc(result.periods.map((_, i) => describePeriod(i)).join('; '))}
    </div>
  `;

  $('[data-action=save-history]', root)?.addEventListener('click', saveToHistory);
  $('[data-action=print]', root)?.addEventListener('click', () => window.print());
}

function describePeriod(i: number): string {
  const p = state.periods[i];
  const pos = findPosition(reg, p.category, p.positionId);
  const ac = pos?.needsAircraft && p.aircraft >= 0 ? `, ${reg.aircraft[p.aircraft]}` : '';
  const st = statusesFor(reg, p.category).find((s) => s.id === p.statusId);
  return `${pos?.label ?? ''}${ac}${st && st.factor !== 1 ? `, ${st.label}` : ''}`;
}

async function saveToHistory() {
  if (!lastResult || lastResult.errors.length) return;
  const entry: HistoryEntry = {
    month: state.month,
    savedAt: new Date().toISOString(),
    total: lastResult.total,
    piece: lastResult.piece,
    time: lastResult.time,
    label: state.periods.map((_, i) => describePeriod(i)).join(' → '),
    state: structuredClone({ norm: state.norm, periods: state.periods, settings: state.settings }),
  };
  const exists = history.some((h) => h.month === entry.month);
  if (exists && !(await ask(`Расчёт за ${monthLabel(entry.month).toLowerCase()} уже есть в истории. Заменить?`, 'Заменить'))) return;
  history = [entry, ...history.filter((h) => h.month !== entry.month)].sort((a, b) => b.month.localeCompare(a.month));
  saveHistory(history);
  toast(`Сохранено: ${monthLabel(entry.month)}`);
}

// ---------- history ----------

function renderHistory(root: HTMLElement) {
  root.innerHTML = `
    <section class="panel narrow">
      <h1>История расчётов</h1>
      ${
        history.length
          ? `<ul class="history">
          ${history
            .map(
              (h, i) => `
            <li>
              <div class="h-main">
                <div class="h-month">${esc(monthLabel(h.month))}</div>
                <div class="h-label muted small">${esc(h.label)}</div>
              </div>
              <div class="h-total">${moneyRounded(h.total)} <span class="cur">сум</span></div>
              <div class="h-actions">
                <button class="btn small" data-open="${i}">Открыть</button>
                <button class="btn small ghost danger" data-del="${i}" aria-label="Удалить">Удалить</button>
              </div>
            </li>`,
            )
            .join('')}
        </ul>`
          : `<p class="muted">Пока пусто. Посчитайте месяц и нажмите «Сохранить в историю».</p>`
      }
      <p class="muted small">История хранится только на этом устройстве.</p>
    </section>`;

  root.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const h = history[Number(b.dataset.open)];
      state = {
        ...state,
        month: h.month,
        norm: h.state.norm,
        periods: structuredClone(h.state.periods),
        settings: { ...h.state.settings },
        active: 0,
      };
      persist();
      view = 'calc';
      renderShell();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const h = history[Number(b.dataset.del)];
      if (!(await ask(`Удалить расчёт за ${monthLabel(h.month).toLowerCase()}?`, 'Удалить', true))) return;
      history.splice(Number(b.dataset.del), 1);
      saveHistory(history);
      renderHistory(root);
    }),
  );
}

// ---------- reference ----------

function coefCell(k: number | null) {
  return k === null ? '<span class="dash">—</span>' : coef(k);
}

function renderReference(root: HTMLElement) {
  const c = reg.constants;
  const acHead = reg.aircraft.map((a) => `<th>${esc(a)}</th>`).join('');
  const r = reg.regulation;
  root.innerHTML = `
    <section class="panel narrow ref">
      <h1>Справочники</h1>
      <p class="version">Положение <b>${esc(r.code)}</b>, издание ${r.edition}, ревизия ${r.revision}, действует с ${esc(
        new Date(r.effectiveFrom).toLocaleDateString('ru-RU'),
      )}</p>
      <p class="muted small">Только просмотр. Значения хранятся в <code>regulation.json</code> — администратор меняет их без нового релиза. Прочерк — сочетание недоступно.</p>

      <h2>ЧЛЭ — гарантированные часы и коэффициенты</h2>
      <p>Часовая ставка: <b>${money(reg.pilot.defaultRate)} сум</b> (п. 2.5)</p>
      <div class="table-scroll">
        <table class="ref-table">
          <thead>
            <tr><th rowspan="2">Должность</th><th rowspan="2">Гарант. ч<br><span class="ref">табл. 2-2</span></th><th colspan="${reg.aircraft.length}">Коэф. гарантии <span class="ref">табл. 2-1</span></th></tr>
            <tr>${acHead}</tr>
          </thead>
          <tbody>
            ${reg.pilot.guaranteed
              .map((g) => `<tr><td>${esc(g.label)}</td><td>${num(g.guaranteedHours)}</td>${g.k1.map(coefCell).map((x) => `<td>${x}</td>`).join('')}</tr>`)
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="table-scroll">
        <table class="ref-table">
          <thead>
            <tr><th rowspan="2">Должность</th><th colspan="${reg.aircraft.length}">Коэф. сверх гарантии <span class="ref">табл. 2-5</span></th></tr>
            <tr>${acHead}</tr>
          </thead>
          <tbody>
            ${reg.pilot.guaranteed
              .map((g) => `<tr><td>${esc(g.label)}</td>${g.k5.map(coefCell).map((x) => `<td>${x}</td>`).join('')}</tr>`)
              .join('')}
          </tbody>
        </table>
      </div>

      <h2>ЧЛЭ с нормативным налётом</h2>
      <p>${reg.pilot.normative.positions.map((p) => esc(p.label)).join(', ')}.</p>
      <div class="table-scroll">
        <table class="ref-table">
          <thead><tr><th>Норматив, ч/мес <span class="ref">табл. 2-4</span></th>${acHead}</tr></thead>
          <tbody><tr><td>${num(reg.pilot.normative.normHours)}</td>${reg.pilot.normative.k.map((k) => `<td>${coefCell(k)}</td>`).join('')}</tr></tbody>
        </table>
      </div>
      <p class="muted small">Коэффициент — табл. 2-3.</p>

      <h2>ЧКЭ — бортпроводники</h2>
      <p>Часовая ставка: <b>${money(reg.cabin.defaultRate)} сум</b></p>
      <div class="table-scroll">
        <table class="ref-table">
          <thead><tr><th>Должность</th><th>До ${num(c.cabinTier1Hours)} ч <span class="ref">табл. 3-1</span></th><th>Свыше ${num(c.cabinTier1Hours)} ч <span class="ref">табл. 3-2</span></th></tr></thead>
          <tbody>${reg.cabin.positions.map((p) => `<tr><td>${esc(p.label)}</td><td>${coef(p.k3)}</td><td>${coef(p.k3over)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <p class="muted small">${reg.cabin.includedInSalary.positions.map((p) => esc(p.label)).join(', ')} — налёт до ${reg.cabin.includedInSalary.hours} ч включён в оклад (${esc(reg.cabin.includedInSalary.ref)}).</p>

      <h2>Фиксированный оклад</h2>
      <ul>${[...reg.pilot.fixedSalary, ...reg.cabin.fixedSalary].map((p) => `<li>${esc(p.label)} (${esc(p.ref ?? '')})</li>`).join('')}</ul>

      <h2>Прочие константы</h2>
      <dl class="consts">
        <dt>Ночной множитель</dt><dd>${num(c.nightMultiplier)}</dd>
        <dt>Праздничная доплата</dt><dd>×${num(c.holidayExtraMultiplier)} (итого двойная оплата)</dd>
        <dt>Порог ЧЛЭ</dt><dd>${num(c.pilotThresholdHours)} ч, множитель ${num(c.pilotThresholdMultiplier, 1)}</dd>
        <dt>Ступень ЧКЭ</dt><dd>${num(c.cabinTier1Hours)} ч</dd>
        <dt>Санитарная норма ЧКЭ</dt><dd>${num(c.cabinSanitaryHours)} ч, множитель ${num(c.cabinSanitaryMultiplier, 1)}</dd>
        <dt>МРОТ</dt><dd>${money(c.minimumWage)} сум</dd>
        <dt>Статусы допуска</dt><dd>${reg.pilot.statuses.map((s) => `${esc(s.label)}${s.ref ? ` (${esc(s.ref)})` : ''}`).join('; ')}</dd>
      </dl>
    </section>`;
}

// ---------- settings ----------

function renderSettings(root: HTMLElement) {
  const s = state.settings;
  const radio = (name: string, value: string, checked: boolean, title: string, desc: string) => `
    <label class="option${checked ? ' active' : ''}">
      <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} />
      <span><b>${title}</b><span class="muted small">${desc}</span></span>
    </label>`;
  root.innerHTML = `
    <section class="panel narrow">
      <h1>Настройки</h1>
      <p class="muted small">Спорные места Положения (раздел 8 ТЗ). Значения по умолчанию соответствуют ТЗ — уточните у экономического отдела.</p>

      <fieldset class="group">
        <legend>П. 2.12 — налёт свыше ${num(reg.constants.pilotThresholdHours)} ч (ЧЛЭ)</legend>
        ${radio('over94Mode', 'replace', s.over94Mode === 'replace', 'Заменяет оплату сверх гарантии', `Часы выше ${num(reg.constants.pilotThresholdHours)} оплачиваются только по 2,0 × k5 (как в ТЗ)`)}
        ${radio('over94Mode', 'additive', s.over94Mode === 'additive', 'Доплата поверх', `Часы выше ${num(reg.constants.pilotThresholdHours)} оплачиваются по k5 и дополнительно 2,0 × k5`)}
      </fieldset>

      <fieldset class="group">
        <legend>Пропорция по отработанному времени</legend>
        ${radio('proportionBasis', 'days', s.proportionBasis === 'days', 'По дням', 'Отработано дней / норма дней месяца')}
        ${radio('proportionBasis', 'hours', s.proportionBasis === 'hours', 'По часам нормы', 'Отработано часов / норма часов месяца')}
      </fieldset>

      <div class="callout small">
        <b>Приняты по ТЗ без переключателя:</b>
        <ul>
          <li>П. 2.11.1 — праздничная доплата считается по коэффициенту табл. 2-1 (в табл. 2-2 — часы, не коэффициенты).</li>
          <li>Пилот-инструктор на B-757 — в табл. 2-5 прочерк: налёт сверх гарантии не оплачивается, выводится предупреждение.</li>
          <li>П. 2.4 — для ЧЛЭ порог «санитарной нормы» принят 94,5 ч из п. 2.12.</li>
          <li>Перевод в течение месяца (п. 2.15) — периоды считаются отдельно и суммируются; пороги применяются к каждому периоду.</li>
        </ul>
      </div>

      <fieldset class="group">
        <legend>Данные</legend>
        <div class="row-actions">
          <button class="btn" data-action="reset-rates">Вернуть ставки по умолчанию</button>
          <button class="btn ghost danger" data-action="reset-all">Сбросить всё</button>
        </div>
      </fieldset>
    </section>`;

  root.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((r) =>
    r.addEventListener('change', () => {
      (state.settings as unknown as Record<string, string>)[r.name] = r.value;
      persist();
      renderSettings(root);
      toast('Настройка сохранена');
    }),
  );
  $('[data-action=reset-rates]', root)!.addEventListener('click', () => {
    state.periods.forEach((p) => (p.rate = String(p.category === 'pilot' ? reg.pilot.defaultRate : reg.cabin.defaultRate)));
    persist();
    toast('Ставки сброшены');
  });
  $('[data-action=reset-all]', root)!.addEventListener('click', async () => {
    if (!(await ask('Удалить профиль, настройки и историю на этом устройстве?', 'Сбросить всё', true))) return;
    state = defaultState(reg);
    history = [];
    saveHistory(history);
    persist();
    toast('Данные сброшены');
    renderSettings(root);
  });
}

// ---------- boot ----------

async function boot() {
  reg = await loadRegulation();
  state = loadState(reg);
  history = loadHistory();
  renderShell();

  if ('serviceWorker' in navigator && import.meta.env.PROD && !IS_EMBED) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  }
}

boot();
