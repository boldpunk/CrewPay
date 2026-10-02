import './style.css';
import bundledRegulation from '../public/regulation.json';
import { availableAircraft, calculateMonth, findPosition, positionsFor, statusesFor } from './calc/engine';
import { coef, hours as fmtHours, money, num, parseHours, parseMoney } from './calc/format';
import { formatDate, paymentSchedule, workingDays } from './calc/paydates';
import type { Category, MonthResult, Regulation, ResolvedPosition } from './calc/types';
import {
  type AppState,
  type Backup,
  type HistoryEntry,
  type Profile,
  type Theme,
  EXTRA_PRESETS,
  defaultPeriod,
  defaultState,
  hasSavedState,
  loadHistory,
  loadProfile,
  loadSalaries,
  loadState,
  makeBackup,
  parseBackup,
  saveHistory,
  saveProfile,
  saveSalaries,
  saveState,
  toMonthInput,
} from './state';
import { icon, logoMark } from './ui/icons';

type View = 'calc' | 'history' | 'reference' | 'profile' | 'settings';

/** Сборка для предпросмотра во встроенном окне (claude.ai): там нет печати, скачивания файлов и service worker. */
const IS_EMBED = import.meta.env.VITE_TARGET === 'embed';
const CAN_PRINT = !IS_EMBED;
const CAN_DOWNLOAD = !IS_EMBED;

const CREDIT_URL = 'https://boldstudio.uz';

let reg: Regulation = bundledRegulation as Regulation;
let state: AppState;
let history: HistoryEntry[] = [];
let profile: Profile | null = null;
let salaries: Record<string, string> = {};
let view: View = 'calc';
let lastResult: MonthResult | null = null;

const app = document.getElementById('app')!;

// ---------- helpers ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);

const period = () => state.periods[state.active];

function persist() {
  saveState(state);
}

function monthLabel(ym: string, short = false): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  const d = new Date(y, m - 1, 1);
  if (short) return d.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '');
  const s = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** «за август 2026» */
function monthFor(ym: string): string {
  return `за ${monthLabel(ym).toLowerCase()}`;
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** В листке фамилия идёт первой: «IVANOV IVAN IVANOVICH» → «Ivan Ivanov». */
function displayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  if (parts.length >= 2) return `${cap(parts[1])} ${cap(parts[0])}`;
  return parts.map(cap).join(' ');
}

function initials(name: string): string {
  return displayName(name)
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.theme);
}

function isValidRegulation(x: unknown): x is Regulation {
  const r = x as Regulation;
  return !!r && Array.isArray(r.aircraft) && !!r.pilot && !!r.cabin && !!r.constants && !!r.regulation;
}

/** Справочник грузится с сервера, чтобы администратор мог менять ставки без релиза. */
async function loadRegulation(): Promise<Regulation> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}regulation.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const data: unknown = await res.json();
    if (isValidRegulation(data)) {
      // Новые константы могли не попасть в старый файл на сервере — дополняем из встроенной копии.
      const bundled = bundledRegulation as Regulation;
      return { ...data, constants: { ...bundled.constants, ...data.constants } };
    }
  } catch {
    /* офлайн или файл недоступен — используем встроенную копию */
  }
  return bundledRegulation as Regulation;
}

function positionSalary(pos: ResolvedPosition): number | null {
  if (pos.guaranteed) return pos.guaranteed.salary ?? null;
  if (pos.cabin) return pos.cabin.salary ?? null;
  const all = [
    ...reg.pilot.normative.positions,
    ...reg.pilot.fixedSalary,
    ...reg.cabin.includedInSalary.positions,
    ...reg.cabin.fixedSalary,
  ];
  return all.find((p) => p.id === pos.id)?.salary ?? null;
}

/** Оклад для должности: сначала личный (запомненный), затем по штатному расписанию. */
function salaryFor(pos: ResolvedPosition | undefined): { value: string; source: 'mine' | 'table' | null } {
  if (!pos) return { value: '', source: null };
  if (salaries[pos.id]) return { value: salaries[pos.id], source: 'mine' };
  const table = positionSalary(pos);
  if (table) return { value: num(table), source: 'table' };
  return { value: '', source: null };
}

// ---------- position search ----------

/** Как должности называют в обиходе — поиск находит и по этим словам. */
const ALIASES: Record<string, string[]> = {
  captain: ['квс', 'командир', 'cpt', 'captain'],
  'first-officer': ['2п', 'второй', 'fo', 'first officer', 'копилот'],
  'captain-training': ['квс инструктор', 'тренировки', 'tri'],
  'pilot-instructor': ['пи', 'инструктор', 'tri', 'tre'],
  'pilot-examiner': ['экзаменатор', 'tre', 'examiner'],
  fa: ['бп', 'стюард', 'стюардесса', 'flight attendant', 'cabin crew'],
  'fa-purser': ['бригадир', 'старший', 'сбп', 'purser', 'senior'],
  'fa-instructor': ['инструктор', 'бп инструктор', 'instructor'],
  'pilot-crm': ['crm'],
  'fa-crm': ['crm'],
};

const normText = (s: string) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();

interface PositionOption {
  pos: ResolvedPosition;
  group: string;
}

function groupTitle(pos: ResolvedPosition): string {
  switch (pos.kind) {
    case 'guaranteed':
      return 'Пилоты · гарантированный налёт';
    case 'normative':
      return 'Пилоты · норматив 20 ч';
    case 'cabin':
      return 'Бортпроводники';
    case 'cabinIncluded':
      return 'Бортпроводники · налёт в окладе';
    default:
      return pos.category === 'pilot' ? 'Пилоты · фиксированный оклад' : 'Бортпроводники · фиксированный оклад';
  }
}

function searchPositions(query: string, category: Category): PositionOption[] {
  const all = [...positionsFor(reg, 'pilot'), ...positionsFor(reg, 'cabin')].map((pos) => ({
    pos,
    group: groupTitle(pos),
  }));
  const q = normText(query);
  if (!q) return all.filter((o) => o.pos.category === category);
  const words = q.split(' ');
  return all
    .map((o) => {
      const hay = normText(o.pos.label);
      const aliases = (ALIASES[o.pos.id] ?? []).map(normText);
      let score = 0;
      if (aliases.includes(q)) score = 110;
      else if (hay.startsWith(q)) score = 100;
      else if (aliases.some((a) => a.startsWith(q))) score = 70;
      else if (words.every((w) => hay.split(' ').some((t) => t.startsWith(w)))) score = 60;
      else if (hay.includes(q)) score = 40;
      if (score && o.pos.category === category) score += 5;
      return { o, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.o);
}

// ---------- shell ----------

const TABS: [View, string, string][] = [
  ['calc', 'Расчёт', 'calc'],
  ['history', 'История', 'history'],
  ['reference', 'Справочник', 'book'],
  ['profile', 'Профиль', 'user'],
  ['settings', 'Настройки', 'sliders'],
];

function renderShell() {
  const ini = profile?.name ? initials(profile.name) : '';
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <button class="brand" data-view="calc" aria-label="CrewPay — к расчёту">
          ${logoMark(34)}
          <span class="wordmark">Crew<span>Pay</span></span>
        </button>
        <nav class="nav-desktop" aria-label="Разделы">
          ${TABS.filter(([id]) => id !== 'profile')
            .map(
              ([id, label, ic]) =>
                `<button class="nav-link${view === id ? ' active' : ''}" data-view="${id}" ${view === id ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></button>`,
            )
            .join('')}
        </nav>
        <button class="avatar${view === 'profile' ? ' active' : ''}" data-view="profile" aria-label="Профиль">
          ${ini ? `<span>${esc(ini)}</span>` : icon('user')}
        </button>
      </div>
    </header>
    <main id="view"></main>
    <footer class="site-footer">
      <div class="footer-inner">
        <div class="footer-brand">
          ${logoMark(22)}
          <span>© ${new Date().getFullYear()} CrewPay · Положение ${esc(reg.regulation.code)}</span>
        </div>
        <a class="credit" href="${CREDIT_URL}" target="_blank" rel="noopener">
          <span>Дизайн и разработка —</span>
          <b>@boldpunk</b>
          <span class="credit-domain">boldstudio.uz</span>
          ${icon('arrowUpRight', 'icon credit-arrow')}
        </a>
      </div>
    </footer>
    <nav class="tabbar" aria-label="Разделы">
      ${TABS.map(
        ([id, label, ic]) =>
          `<button class="tab${view === id ? ' active' : ''}" data-view="${id}" ${view === id ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></button>`,
      ).join('')}
    </nav>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
  `;
  app.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.view as View)),
  );
  renderView();
}

function go(v: View) {
  view = v;
  renderShell();
  window.scrollTo({ top: 0 });
}

function renderView() {
  const root = $('#view')!;
  if (view === 'calc') renderCalc(root);
  else if (view === 'reference') renderReference(root);
  else if (view === 'history') renderHistory(root);
  else if (view === 'profile') renderProfile(root);
  else renderSettings(root);
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  if (!t) return;
  t.innerHTML = `${icon('check')}<span>${esc(msg)}</span>`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2400);
}

/** Подтверждение внутри страницы (нативный confirm() недоступен во встроенных окнах и плохо выглядит на телефоне). */
function ask(message: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-msg">
        <div class="modal-icon${danger ? ' danger' : ''}">${icon(danger ? 'trash' : 'info')}</div>
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

// ---------- calculator ----------

type FieldKind = 'hours' | 'money';

function field(
  name: string,
  label: string,
  value: string,
  opts: { hint?: string; placeholder?: string; kind?: FieldKind; suffix?: string; ic?: string; badge?: string } = {},
) {
  const kind = opts.kind ?? 'hours';
  const id = `f-${name}`;
  return `
    <div class="field">
      <label class="field-label" for="${id}">${opts.ic ? icon(opts.ic) : ''}<span>${label}</span>${opts.badge ?? ''}</label>
      <div class="input-wrap">
        <input id="${id}" type="text" inputmode="${kind === 'money' ? 'numeric' : 'decimal'}" autocomplete="off" spellcheck="false"
          name="${name}" data-kind="${kind}" value="${esc(value)}" placeholder="${esc(opts.placeholder ?? '0')}" />
        ${opts.suffix ? `<span class="suffix">${opts.suffix}</span>` : ''}
      </div>
      ${opts.hint ? `<span class="field-hint">${opts.hint}</span>` : ''}
    </div>`;
}

function prettyMoney(raw: string): string {
  const v = parseMoney(raw);
  return raw.trim() !== '' && Number.isFinite(v) ? num(v) : raw;
}

function renderCalc(root: HTMLElement) {
  document.body.classList.remove('typing');
  const p = period();
  const position = findPosition(reg, p.category, p.positionId);
  const avail = availableAircraft(reg, position);
  const statuses = statusesFor(reg, p.category);
  const unit = state.settings.proportionBasis === 'days' ? 'дн.' : 'ч';
  const isFixed = position?.kind === 'fixed';
  const multi = state.periods.length > 1;
  const sal = salaryFor(position);
  const salaryBadge =
    p.salary.trim() !== '' && sal.source && parseMoney(sal.value) === parseMoney(p.salary)
      ? `<span class="badge">${sal.source === 'mine' ? 'мой' : 'штатное'}</span>`
      : '';
  const five = workingDays(reg, state.month, false);
  const six = workingDays(reg, state.month, true);

  root.innerHTML = `
    <div class="layout">
      <section class="form-col" aria-label="Ввод данных">
        <div class="card">
          <div class="month-stepper">
            <button class="icon-btn" data-month="-1" aria-label="Предыдущий месяц">${icon('chevron', 'icon rot90')}</button>
            <label class="month-pick">
              ${icon('calendar')}
              <span class="month-name">${esc(monthLabel(state.month))}</span>
              <input type="month" id="f-month" value="${esc(state.month)}" aria-label="Расчётный месяц" />
            </label>
            <button class="icon-btn" data-month="1" aria-label="Следующий месяц">${icon('chevron', 'icon rot-90')}</button>
          </div>
          <div class="grid2">
            ${field('norm', `Норма месяца, ${unit}`, state.norm, {
              placeholder: state.settings.proportionBasis === 'days' ? 'напр. 25' : 'напр. 176',
              ic: 'calendar',
            })}
            ${field('worked', `Отработано, ${unit}`, p.worked, { placeholder: multi ? '0' : '= норме', ic: 'check' })}
          </div>
          ${
            state.settings.proportionBasis === 'days' && five && six
              ? `<div class="suggest">
                  <span class="muted small">Норма по календарю:</span>
                  <button class="chip${state.norm === String(five) ? ' active' : ''}" data-norm="${five}">5-дневка · ${five}</button>
                  <button class="chip${state.norm === String(six) ? ' active' : ''}" data-norm="${six}">6-дневка · ${six}</button>
                </div>`
              : ''
          }
          <p class="field-hint">Отпуск и больничный уменьшают оклад, гарантию и норматив. Медосмотр — в «Прочих начислениях».</p>
        </div>

        <div class="periods" role="tablist" aria-label="Периоды">
          ${
            multi
              ? state.periods
                  .map(
                    (_, i) =>
                      `<button class="chip${i === state.active ? ' active' : ''}" data-period="${i}">Период ${i + 1}</button>`,
                  )
                  .join('') +
                `<button class="chip ghost danger" data-action="remove-period">${icon('trash')}Удалить период ${state.active + 1}</button>`
              : `<button class="chip ghost" data-action="add-period" title="П. 2.15">${icon('split')}Перевод на другую должность в этом месяце</button>`
          }
        </div>

        <div class="card">
          <div class="card-head">${icon('briefcase')}<h2>Должность${multi ? ` · период ${state.active + 1}` : ''}</h2></div>
          <div class="segmented" role="radiogroup" aria-label="Категория">
            ${(['pilot', 'cabin'] as Category[])
              .map(
                (c) => `
              <button role="radio" aria-checked="${p.category === c}" class="seg${p.category === c ? ' active' : ''}" data-category="${c}">
                ${icon(c === 'pilot' ? 'plane' : 'crew')}<span>${c === 'pilot' ? 'Пилоты' : 'Бортпроводники'}</span>
              </button>`,
              )
              .join('')}
          </div>
          <div class="field">
            <label class="field-label" for="pos-input">${icon('search')}<span>Должность в полёте</span></label>
            <div class="combo" id="pos-combo">
              <input id="pos-input" type="text" role="combobox" aria-expanded="false" aria-controls="pos-list" aria-autocomplete="list"
                autocomplete="off" spellcheck="false" value="${esc(position?.label ?? '')}" placeholder="Начните писать: КВС, бригадир, инструктор…" />
              <button class="combo-toggle" type="button" tabindex="-1" aria-label="Показать все должности">${icon('chevron')}</button>
              <ul id="pos-list" class="combo-list" role="listbox" hidden></ul>
            </div>
          </div>
          ${
            position?.needsAircraft
              ? `
          <div class="field">
            <span class="field-label">${icon('plane')}<span>Тип ВС</span></span>
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
          <div class="field">
            <label class="field-label" for="f-statusId">${icon('shield')}<span>Статус допуска</span></label>
            <div class="select-wrap">
              <select id="f-statusId">
                ${statuses
                  .map(
                    (s) =>
                      `<option value="${esc(s.id)}"${s.id === p.statusId ? ' selected' : ''}>${esc(s.label)}${s.ref ? ` — ${esc(s.ref)}` : ''}</option>`,
                  )
                  .join('')}
              </select>
              ${icon('chevron', 'icon select-chevron')}
            </div>
          </div>
        </div>

        ${
          isFixed
            ? ''
            : `
        <div class="card">
          <div class="card-head">${icon('clock')}<h2>Налёт за ${multi ? 'период' : 'месяц'}</h2><span class="muted small head-note">можно 65:30</span></div>
          <div class="grid2">
            ${field('hours', 'Фактический налёт', p.hours, { suffix: 'ч', ic: 'clock', hint: 'Всего, с ночными и праздничными' })}
            ${field('nightHours', 'Из них ночной', p.nightHours, { suffix: 'ч', ic: 'moon' })}
            ${field('holidayHours', 'Из них праздничный', p.holidayHours, { suffix: 'ч', ic: 'star' })}
            ${field('nightHolidayHours', 'Ночью в праздник', p.nightHolidayHours, { suffix: 'ч', ic: 'moon', hint: 'Входят и в ночные, и в праздничные' })}
            ${field('deadheadHours', 'Dead Head', p.deadheadHours, {
              suffix: 'ч',
              ic: 'plane',
              hint:
                reg.constants.deadheadMultiplier > 0
                  ? `Фактические часы; оплата ${num(reg.constants.deadheadMultiplier * 100)} %`
                  : 'Не оплачивается',
            })}
          </div>
        </div>`
        }

        <div class="card">
          <div class="card-head">${icon('wallet')}<h2>Оклад и ставка</h2></div>
          <div class="grid2">
            ${field('salary', 'Должностной оклад', prettyMoney(p.salary), {
              kind: 'money',
              suffix: 'сум',
              ic: 'briefcase',
              placeholder: 'тариф',
              badge: salaryBadge,
              hint: 'Запоминается для этой должности',
            })}
            ${
              isFixed
                ? ''
                : field('rate', 'Часовая ставка', prettyMoney(p.rate), {
                    kind: 'money',
                    suffix: 'сум',
                    ic: 'coin',
                    hint: `По Положению ${money(p.category === 'pilot' ? reg.pilot.defaultRate : reg.cabin.defaultRate)} (п. 2.5)`,
                  })
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head">${icon('sparkle')}<h2>Прочие начисления</h2><span class="muted small head-note">суммы из листка</span></div>
          ${
            state.extras.length
              ? `<div class="extras">
            ${state.extras
              .map(
                (x, i) => `
              <div class="extra-row">
                <input type="text" class="extra-title" id="x-title-${i}" data-extra="${i}" data-prop="title" value="${esc(x.title)}" placeholder="Название" aria-label="Название начисления ${i + 1}" />
                <div class="input-wrap">
                  <input type="text" inputmode="decimal" id="x-amount-${i}" data-extra="${i}" data-prop="amount" data-kind="money" value="${esc(prettyMoney(x.amount))}" placeholder="0" aria-label="Сумма: ${esc(x.title || 'начисление ' + (i + 1))}" />
                  <span class="suffix">сум</span>
                </div>
                <button class="icon-btn" data-remove-extra="${i}" aria-label="Удалить ${esc(x.title || 'начисление')}">${icon('x')}</button>
              </div>`,
              )
              .join('')}
          </div>`
              : ''
          }
          <div class="suggest">
            ${EXTRA_PRESETS.filter((t) => !state.extras.some((x) => x.title === t))
              .map((t) => `<button class="chip" data-add-extra="${esc(t)}">${icon('plus')}${esc(t)}</button>`)
              .join('')}
            <button class="chip ghost" data-add-extra="">${icon('plus')}Другое</button>
          </div>
        </div>

        <div class="form-actions">
          <button class="btn ghost" data-action="new-month">${icon('refresh')}Следующий месяц</button>
          <span class="muted small">Сохраняется на этом устройстве</span>
        </div>
      </section>

      <section class="result-col" id="result" aria-live="polite" aria-label="Результат"></section>
    </div>
    <a href="#result" class="sticky-total" id="sticky-total" aria-label="Перейти к результату"></a>
  `;

  bindCalc(root);
  renderResult();
}

function selectPosition(root: HTMLElement, category: Category, id: string) {
  const p = period();
  const prevSalary = salaryFor(findPosition(reg, p.category, p.positionId));
  if (p.category !== category) {
    const fresh = defaultPeriod(reg, category);
    Object.assign(p, { category, statusId: fresh.statusId, rate: fresh.rate });
  }
  p.positionId = id;
  const pos = findPosition(reg, category, id);
  const avail = availableAircraft(reg, pos);
  if (!avail.includes(p.aircraft)) p.aircraft = avail.length === 1 ? avail[0] : -1;
  const sal = salaryFor(pos);
  // Подставляем оклад новой должности; оклад прежней не переносим, чтобы не посчитать чужой тариф.
  if (sal.source) p.salary = sal.value;
  else if (prevSalary.source && parseMoney(prevSalary.value) === parseMoney(p.salary)) p.salary = '';
  persist();
  renderCalc(root);
}

function bindCombo(root: HTMLElement) {
  const input = $<HTMLInputElement>('#pos-input', root)!;
  const list = $<HTMLUListElement>('#pos-list', root)!;
  const toggle = $<HTMLButtonElement>('.combo-toggle', root)!;
  let options: PositionOption[] = [];
  let active = 0;
  const currentLabel = () => findPosition(reg, period().category, period().positionId)?.label ?? '';

  const draw = () => {
    if (!options.length) {
      list.innerHTML = `<li class="combo-empty">Ничего не найдено</li>`;
      return;
    }
    let lastGroup = '';
    list.innerHTML = options
      .map((o, i) => {
        const head = o.group !== lastGroup ? `<li class="combo-group" role="presentation">${esc(o.group)}</li>` : '';
        lastGroup = o.group;
        const sal = salaryFor(o.pos);
        const selected = o.pos.id === period().positionId && o.pos.category === period().category;
        return `${head}<li role="option" id="opt-${i}" class="combo-opt${i === active ? ' active' : ''}" aria-selected="${selected}" data-i="${i}">
          <span class="opt-label">${esc(o.pos.label)}${o.pos.ref ? ` <span class="ref">${esc(o.pos.ref)}</span>` : ''}</span>
          ${sal.value ? `<span class="opt-salary">${esc(sal.value)}</span>` : ''}
          ${selected ? icon('check', 'icon opt-check') : ''}
        </li>`;
      })
      .join('');
    input.setAttribute('aria-activedescendant', `opt-${active}`);
    list.querySelector('.combo-opt.active')?.scrollIntoView({ block: 'nearest' });
  };
  const open = (query: string) => {
    options = searchPositions(query, period().category);
    active = query ? 0 : Math.max(0, options.findIndex((o) => o.pos.id === period().positionId));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    draw();
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    close();
    selectPosition(root, o.pos.category, o.pos.id);
  };

  input.addEventListener('focus', () => {
    document.body.classList.add('typing');
    input.select();
    open('');
  });
  input.addEventListener('input', () => open(input.value));
  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault();
      return open(input.value);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(options.length - 1, active + 1);
      draw();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, active - 1);
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      close();
      input.value = currentLabel();
    }
  });
  input.addEventListener('blur', () => {
    document.body.classList.remove('typing');
    window.setTimeout(() => {
      if (!input.isConnected) return;
      close();
      input.value = currentLabel();
    }, 150);
  });
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (li) choose(Number(li.dataset.i));
  });
  toggle.addEventListener('mousedown', (e) => e.preventDefault());
  toggle.addEventListener('click', () => (list.hidden ? input.focus() : close()));
}

function rememberSalary(raw: string) {
  const id = period().positionId;
  const v = parseMoney(raw);
  if (raw.trim() === '') delete salaries[id];
  else if (Number.isFinite(v) && v > 0) salaries[id] = num(v);
  saveSalaries(salaries);
}

function bindCalc(root: HTMLElement) {
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((el) => {
    if (el.id === 'pos-input') return;
    // На телефоне плавающий итог не должен закрывать поле над клавиатурой.
    el.addEventListener('focus', () => document.body.classList.add('typing'));
    el.addEventListener('blur', () => document.body.classList.remove('typing'));
  });

  root.querySelectorAll<HTMLInputElement>('input[name]').forEach((input) => {
    input.addEventListener('input', () => {
      const name = input.name;
      if (name === 'norm') state.norm = input.value;
      else {
        (period() as unknown as Record<string, string>)[name] = input.value;
        if (name === 'salary') rememberSalary(input.value);
      }
      persist();
      renderResult();
    });
    if (input.dataset.kind === 'money') {
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

  root.querySelectorAll<HTMLInputElement>('[data-extra]').forEach((input) => {
    input.addEventListener('input', () => {
      const x = state.extras[Number(input.dataset.extra)];
      if (!x) return;
      x[input.dataset.prop as 'title' | 'amount'] = input.value;
      persist();
      renderResult();
    });
    if (input.dataset.kind === 'money')
      input.addEventListener('blur', () => {
        const v = parseMoney(input.value);
        if (input.value.trim() !== '' && Number.isFinite(v)) input.value = num(v);
      });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-add-extra]').forEach((b) =>
    b.addEventListener('click', () => {
      state.extras.push({ title: b.dataset.addExtra ?? '', amount: '' });
      persist();
      renderCalc(root);
      const i = state.extras.length - 1;
      $<HTMLInputElement>(b.dataset.addExtra ? `#x-amount-${i}` : `#x-title-${i}`, root)?.focus();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-remove-extra]').forEach((b) =>
    b.addEventListener('click', () => {
      state.extras.splice(Number(b.dataset.removeExtra), 1);
      persist();
      renderCalc(root);
    }),
  );

  const monthInput = $<HTMLInputElement>('#f-month', root)!;
  monthInput.addEventListener('change', () => {
    if (!monthInput.value) return;
    state.month = monthInput.value;
    persist();
    renderCalc(root);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-month]').forEach((b) =>
    b.addEventListener('click', () => {
      state.month = shiftMonth(state.month, Number(b.dataset.month));
      persist();
      renderCalc(root);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-norm]').forEach((b) =>
    b.addEventListener('click', () => {
      state.norm = b.dataset.norm!;
      persist();
      renderCalc(root);
    }),
  );

  bindCombo(root);

  $<HTMLSelectElement>('#f-statusId', root)!.addEventListener('change', (e) => {
    period().statusId = (e.target as HTMLSelectElement).value;
    persist();
    renderResult();
  });

  root.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((b) =>
    b.addEventListener('click', () => {
      const cat = b.dataset.category as Category;
      if (period().category === cat) return;
      selectPosition(root, cat, defaultPeriod(reg, cat).positionId);
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
    if (src.worked.trim() === '') src.worked = state.norm;
    state.periods.push({
      ...src,
      hours: '',
      nightHours: '',
      holidayHours: '',
      nightHolidayHours: '',
      deadheadHours: '',
      worked: '',
    });
    state.active = state.periods.length - 1;
    persist();
    renderCalc(root);
    toast('Добавлен период 2 — выберите новую должность');
  });

  $('[data-action=remove-period]', root)?.addEventListener('click', async () => {
    if (!(await ask(`Удалить период ${state.active + 1}?`, 'Удалить', true))) return;
    state.periods.splice(state.active, 1);
    state.active = 0;
    persist();
    renderCalc(root);
  });

  $('[data-action=new-month]', root)!.addEventListener('click', async () => {
    if (!(await ask('Начать следующий месяц? Часы и прочие начисления очистятся, должность и оклад останутся.', 'Начать')))
      return;
    const first = state.periods[0];
    state.periods = [
      { ...first, hours: '', nightHours: '', holidayHours: '', nightHolidayHours: '', deadheadHours: '', worked: '' },
    ];
    state.extras = [];
    state.active = 0;
    state.norm = '';
    state.month = shiftMonth(state.month, 1);
    persist();
    renderCalc(root);
  });
}

/** Шкала налёта с порогами: гарантия и 94,5 ч у пилотов, 70 и 100 ч у бортпроводников. */
function gauge(): string {
  const p = period();
  const pos = findPosition(reg, p.category, p.positionId);
  const input = toMonthInput(state).periods[state.active];
  if (!pos || !Number.isFinite(input.hours) || input.hours <= 0) return '';
  const normV = parseHours(state.norm);
  const P = normV > 0 && Number.isFinite(input.worked) ? Math.min(1, input.worked / normV) : 1;
  const H = input.hours;
  const marks: { at: number; label: string }[] = [];
  if (pos.kind === 'guaranteed') {
    marks.push({ at: pos.guaranteed!.guaranteedHours * P, label: 'гарантия' });
    marks.push({ at: reg.constants.pilotThresholdHours, label: '×2' });
  } else if (pos.kind === 'normative') {
    marks.push({ at: reg.pilot.normative.normHours * P, label: 'норматив' });
  } else if (pos.kind === 'cabin') {
    marks.push({ at: reg.constants.cabinTier1Hours, label: 'ступень' });
    marks.push({ at: reg.constants.cabinSanitaryHours, label: '×2' });
  } else return '';
  const max = Math.ceil((Math.max(H, ...marks.map((m) => m.at)) * 1.08) / 10) * 10;
  const pct = (x: number) => `${Math.min(100, (x / max) * 100).toFixed(2)}%`;
  return `
    <div class="card gauge" role="img" aria-label="Налёт ${fmtHours(H)} ч; пороги: ${marks.map((m) => `${m.label} ${fmtHours(m.at)} ч`).join(', ')}">
      <div class="gauge-top"><span>${icon('plane')}Налёт за месяц</span><b>${fmtHours(H)} ч</b></div>
      <div class="gauge-track">
        <div class="gauge-fill" style="width:${pct(H)}"></div>
        ${marks
          .map(
            (m) => `<div class="gauge-mark${H >= m.at ? ' passed' : ''}" style="left:${pct(m.at)}">
              <span class="gauge-label">${esc(m.label)} <b>${fmtHours(m.at)}</b></span></div>`,
          )
          .join('')}
      </div>
    </div>`;
}

function markInvalidFields() {
  document.querySelectorAll<HTMLInputElement>('input[data-kind]').forEach((el) => {
    const v = el.dataset.kind === 'money' ? parseMoney(el.value) : parseHours(el.value);
    const bad = !Number.isFinite(v);
    el.classList.toggle('invalid', bad);
    el.setAttribute('aria-invalid', String(bad));
  });
}

function lineIcon(title: string): string {
  if (/Dead Head/.test(title)) return 'plane';
  if (/Ночн/.test(title)) return 'moon';
  if (/Праздн/.test(title)) return 'star';
  if (/оклад/i.test(title)) return 'briefcase';
  return 'clock';
}

function renderResult() {
  const root = $('#result');
  const sticky = $('#sticky-total');
  if (!root) return;
  markInvalidFields();
  const result = calculateMonth(reg, state.settings, toMonthInput(state));
  lastResult = result;
  const multi = result.periods.length > 1;
  const schedule = paymentSchedule(reg, state.month);

  // Незаполненная форма — это не ошибка: показываем, что осталось ввести.
  const missing: string[] = [];
  if (state.norm.trim() === '') missing.push('норму месяца');
  state.periods.forEach((p, i) => {
    const pos = findPosition(reg, p.category, p.positionId);
    if (pos?.needsAircraft && p.aircraft < 0) missing.push(multi ? `тип ВС (период ${i + 1})` : 'тип ВС');
  });
  if (missing.length) result.errors = result.errors.filter((e) => !/Норма рабочего|Выберите тип ВС/.test(e));
  const incomplete = !result.errors.length && missing.length > 0;
  const ok = !result.errors.length && !missing.length;
  if (!ok) lastResult = null;

  if (sticky) {
    sticky.innerHTML = ok
      ? `<span>К выплате</span><strong>${money(result.net)} <small>сум</small></strong>`
      : incomplete
        ? `<span>Укажите ${esc(missing.join(', '))}</span>${icon('chevron')}`
        : `${icon('alert')}<span>Проверьте данные</span>`;
    sticky.classList.toggle('error', !ok && !incomplete);
  }

  const extraLines = ok
    ? state.extras
        .map((x) => ({ title: x.title.trim() || 'Прочее начисление', amount: parseMoney(x.amount) }))
        .filter((x) => Number.isFinite(x.amount) && x.amount > 0)
    : [];

  const lineRows = result.periods
    .map((pr, i) => {
      const head = multi
        ? `<li class="period-head">Период ${i + 1} · ${esc(findPosition(reg, state.periods[i].category, state.periods[i].positionId)?.label ?? '')}</li>`
        : '';
      return (
        head +
        pr.lines
          .map(
            (l) => `
          <li class="line ${l.part}">
            <span class="line-icon">${icon(lineIcon(l.title))}</span>
            <div class="line-main">
              <div class="line-title">${esc(l.title)} <span class="ref">${esc(l.ref)}</span></div>
              <div class="line-formula">${esc(l.formula)}</div>
            </div>
            <div class="line-amount">${l.part === 'info' ? '—' : money(l.amount)}</div>
          </li>`,
          )
          .join('')
      );
    })
    .join('');
  const extraRows = extraLines
    .map(
      (x) => `
      <li class="line extra">
        <span class="line-icon">${icon('sparkle')}</span>
        <div class="line-main"><div class="line-title">${esc(x.title)} <span class="ref">из листка</span></div></div>
        <div class="line-amount">${money(x.amount)}</div>
      </li>`,
    )
    .join('');

  const hints = result.periods.flatMap((pr, i) =>
    pr.hints.map(
      (h) =>
        `<span class="hint-chip">${icon('clock')}${multi ? `П${i + 1}: ` : ''}${esc(h.label)} <b>${fmtHours(h.hours)} ч</b></span>`,
    ),
  );
  const notes = result.periods.flatMap((pr) => pr.notes);

  const parts = [
    { key: 'piece', label: 'Сдельная', value: result.piece },
    { key: 'time', label: 'Оклад', value: result.time },
    { key: 'extra', label: 'Прочее', value: result.extras },
  ].filter((x) => x.value > 0);
  const pctOf = (v: number) => num((v / result.total) * 100, 0);
  const split =
    ok && result.total > 0 && parts.length > 1
      ? `
      <div class="card split">
        <div class="split-bar" role="img" aria-label="${parts.map((x) => `${x.label} ${pctOf(x.value)} %`).join(', ')}">
          ${parts
            .map(
              (x) =>
                `<span class="seg-${x.key}" style="flex-grow:${x.value}" title="${x.label}: ${money(x.value)} сум · ${pctOf(x.value)} %"></span>`,
            )
            .join('')}
        </div>
        <ul class="split-legend">
          ${parts
            .map(
              (x) =>
                `<li><i class="dot seg-${x.key}"></i><span>${x.label}</span><b>${money(x.value)}</b><span class="muted">${pctOf(x.value)} %</span></li>`,
            )
            .join('')}
        </ul>
      </div>`
      : '';

  root.innerHTML = `
    <div class="hero${ok ? '' : ' hero-empty'}">
      <div class="hero-label">${icon('wallet')}К выплате ${esc(monthFor(state.month))}</div>
      <div class="hero-value">${ok ? `${money(result.net)}<span class="cur">сум</span>` : '—'}</div>
      <dl class="hero-rows">
        <div><dt>Начислено</dt><dd>${ok ? money(result.total) : '—'}</dd></div>
        <div><dt>НДФЛ ${num(reg.constants.incomeTaxRate * 100)} %</dt><dd>${ok ? `−${money(result.tax)}` : '—'}</dd></div>
      </dl>
      ${ok ? `<div class="hero-note">в т. ч. ИНПС ${money(result.inps)} сум</div>` : ''}
    </div>

    ${incomplete ? `<div class="alert info">${icon('info')}<div>Чтобы посчитать, укажите ${esc(missing.join(', '))}.</div></div>` : ''}
    ${
      result.errors.length
        ? `<div class="alert error">${icon('alert')}<div><b>Исправьте данные</b><ul>${result.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div></div>`
        : ''
    }
    ${
      result.warnings.length && ok
        ? `<div class="alert warn">${icon('alert')}<ul>${result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
        : ''
    }

    ${split}
    ${ok ? gauge() : ''}
    ${ok && hints.length ? `<div class="hints">${hints.join('')}</div>` : ''}

    ${
      ok && (lineRows || extraRows)
        ? `
    <div class="card lines-card">
      <div class="card-head">${icon('receipt')}<h2>Расчёт по строкам</h2></div>
      <ul class="lines">${lineRows}${extraRows}</ul>
      <dl class="totals">
        <div><dt>Сдельная часть</dt><dd>${money(result.piece)}</dd></div>
        <div><dt>Повременная часть</dt><dd>${money(result.time)}</dd></div>
        ${result.extras ? `<div><dt>Прочие начисления</dt><dd>${money(result.extras)}</dd></div>` : ''}
        <div class="grand"><dt>Начислено</dt><dd>${money(result.total)}</dd></div>
        <div><dt>НДФЛ, вкл. ИНПС</dt><dd>−${money(result.tax)}</dd></div>
        <div class="grand net"><dt>К выплате</dt><dd>${money(result.net)}</dd></div>
      </dl>
    </div>`
        : ''
    }

    ${ok && notes.length ? `<ul class="notes">${notes.map((n) => `<li>${icon('info')}<span>${esc(n)}</span></li>`).join('')}</ul>` : ''}

    ${
      schedule
        ? `
    <div class="card paydates">
      <div class="card-head">${icon('calendar')}<h2>Сроки выплат</h2></div>
      <div class="paydate"><span>Оклад</span><b>до ${esc(formatDate(schedule.salary))}</b></div>
      <div class="paydate"><span>Сдельная часть</span><b>до ${esc(formatDate(schedule.piece))}</b></div>
      <p class="field-hint">Если день выплаты выходной — перенос на канун (раздел 4).</p>
    </div>`
        : ''
    }

    <div class="result-actions">
      <button class="btn primary" data-action="save-history" ${ok ? '' : 'disabled'}>${icon('save')}Сохранить ${esc(monthLabel(state.month, true))}</button>
      <button class="btn" data-action="copy" ${ok ? '' : 'disabled'}>${icon('copy')}Копировать</button>
      ${CAN_PRINT ? `<button class="btn" data-action="print" ${ok ? '' : 'disabled'}>${icon('printer')}PDF</button>` : ''}
    </div>
    <div class="print-only print-meta">
      ${esc(monthLabel(state.month))} · ${esc(profile?.name ?? '')} · ${esc(result.periods.map((_, i) => describePeriod(i)).join('; '))} · CrewPay, Положение ${esc(reg.regulation.code)}
    </div>
  `;

  $('[data-action=save-history]', root)?.addEventListener('click', saveToHistory);
  $('[data-action=print]', root)?.addEventListener('click', () => window.print());
  $('[data-action=copy]', root)?.addEventListener('click', () => copySummary(result, extraLines));
}

function copySummary(result: MonthResult, extras: { title: string; amount: number }[]) {
  const rows = [
    `CrewPay — ${monthLabel(state.month)}`,
    ...(profile?.name ? [profile.name] : []),
    state.periods.map((_, i) => describePeriod(i)).join(' → '),
    '',
    ...result.periods.flatMap((pr) => pr.lines.filter((l) => l.part !== 'info').map((l) => `${l.title}: ${money(l.amount)}`)),
    ...extras.map((x) => `${x.title}: ${money(x.amount)}`),
    '',
    `Начислено: ${money(result.total)} сум`,
    `НДФЛ: −${money(result.tax)} сум`,
    `К выплате: ${money(result.net)} сум`,
  ];
  const text = rows.join('\n').replace(/ /g, ' ');
  try {
    navigator.clipboard
      .writeText(text)
      .then(() => toast('Расчёт скопирован'))
      .catch(() => toast('Не удалось скопировать'));
  } catch {
    toast('Не удалось скопировать');
  }
}

function describePeriod(i: number): string {
  const p = state.periods[i];
  const pos = findPosition(reg, p.category, p.positionId);
  const ac = pos?.needsAircraft && p.aircraft >= 0 ? `, ${reg.aircraft[p.aircraft]}` : '';
  const st = statusesFor(reg, p.category).find((s) => s.id === p.statusId);
  return `${pos?.label ?? ''}${ac}${st && st.factor !== 1 ? `, ${st.label}` : ''}`;
}

async function saveToHistory() {
  if (!lastResult) return;
  const entry: HistoryEntry = {
    month: state.month,
    savedAt: new Date().toISOString(),
    total: lastResult.total,
    net: lastResult.net,
    piece: lastResult.piece,
    time: lastResult.time,
    extras: lastResult.extras,
    label: state.periods.map((_, i) => describePeriod(i)).join(' → '),
    state: structuredClone({ norm: state.norm, periods: state.periods, extras: state.extras, settings: state.settings }),
  };
  if (history.some((h) => h.month === entry.month)) {
    if (!(await ask(`${monthLabel(entry.month)} уже есть в истории. Заменить?`, 'Заменить'))) return;
  }
  history = [entry, ...history.filter((h) => h.month !== entry.month)].sort((a, b) => b.month.localeCompare(a.month));
  saveHistory(history);
  toast(`Сохранено: ${monthLabel(entry.month)}`);
}

// ---------- history ----------

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function renderHistory(root: HTMLElement) {
  const last12 = [...history].sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  const max = Math.max(...last12.map((h) => h.net), 1);
  const avg = history.length ? history.reduce((s, h) => s + h.net, 0) / history.length : 0;

  const chart =
    last12.length > 1
      ? `
    <figure class="card chart-card">
      <figcaption class="card-head">${icon('trendUp')}<h2>К выплате по месяцам</h2></figcaption>
      <div class="bars">
        ${last12
          .map(
            (h) => `
          <button class="bar-col" data-open-month="${h.month}" aria-label="${esc(monthLabel(h.month))}: ${money(h.net)} сум">
            <span class="bar-tip">${esc(monthLabel(h.month))}<b>${money(h.net)}</b></span>
            <span class="bar-area"><span class="bar" style="height:${Math.max(3, (h.net / max) * 100).toFixed(1)}%"></span></span>
            <span class="bar-label">${esc(monthLabel(h.month, true))}</span>
          </button>`,
          )
          .join('')}
      </div>
    </figure>`
      : '';

  root.innerHTML = `
    <section class="page">
      <div class="page-head">
        <h1>История</h1>
        ${history.length ? `<p class="muted">${history.length} ${plural(history.length, 'месяц', 'месяца', 'месяцев')} · в среднем ${money(avg)} сум к выплате</p>` : ''}
      </div>
      ${chart}
      ${
        history.length
          ? `<ul class="history">
          ${history
            .map((h, i) => {
              const prev = history.find((x) => x.month === shiftMonth(h.month, -1));
              const delta = prev ? h.net - prev.net : null;
              return `
            <li class="card history-item">
              <div class="h-main">
                <div class="h-month">${esc(monthLabel(h.month))}</div>
                <div class="muted small">${esc(h.label)}</div>
              </div>
              <div class="h-sum">
                <div class="h-net">${money(h.net)} <span class="cur">сум</span></div>
                <div class="muted small">начислено ${money(h.total)}</div>
                ${
                  delta !== null && Math.abs(delta) >= 1
                    ? `<div class="delta ${delta > 0 ? 'up' : 'down'}">${icon(delta > 0 ? 'trendUp' : 'trendDown')}${delta > 0 ? '+' : '−'}${money(Math.abs(delta))}</div>`
                    : ''
                }
              </div>
              <div class="h-actions">
                <button class="btn small" data-open="${i}">${icon('calc')}Открыть</button>
                <button class="btn small ghost danger" data-del="${i}">${icon('trash')}Удалить</button>
              </div>
            </li>`;
            })
            .join('')}
        </ul>`
          : `<div class="empty card">${icon('history', 'icon empty-icon')}<p>Пока пусто. Посчитайте месяц и нажмите «Сохранить».</p><button class="btn primary" data-go="calc">${icon('calc')}К расчёту</button></div>`
      }
    </section>`;

  const openEntry = (h: HistoryEntry) => {
    state = {
      ...state,
      month: h.month,
      norm: h.state.norm,
      periods: structuredClone(h.state.periods),
      extras: structuredClone(h.state.extras ?? []),
      settings: { ...h.state.settings },
      active: 0,
    };
    persist();
    go('calc');
  };
  root.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) =>
    b.addEventListener('click', () => openEntry(history[Number(b.dataset.open)])),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-open-month]').forEach((b) =>
    b.addEventListener('click', () => {
      const h = history.find((x) => x.month === b.dataset.openMonth);
      if (h) openEntry(h);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const h = history[Number(b.dataset.del)];
      if (!(await ask(`Удалить расчёт ${monthFor(h.month)}?`, 'Удалить', true))) return;
      history.splice(Number(b.dataset.del), 1);
      saveHistory(history);
      renderHistory(root);
    }),
  );
  $('[data-go=calc]', root)?.addEventListener('click', () => go('calc'));
}

// ---------- profile ----------

function renderProfile(root: HTMLElement) {
  const p: Profile = profile ?? { name: '', email: '', employeeId: '', organization: '', department: '', createdAt: '' };
  const mySalaries = Object.entries(salaries)
    .map(([id, v]) => {
      const pos = findPosition(reg, 'pilot', id) ?? findPosition(reg, 'cabin', id);
      return pos ? `<li><span>${esc(pos.label)}</span><b>${esc(v)} сум</b></li>` : '';
    })
    .join('');
  const f = (name: keyof Profile, label: string, ic: string, type = 'text', ph = '') => `
    <div class="field">
      <label class="field-label" for="p-${name}">${icon(ic)}<span>${label}</span></label>
      <input id="p-${name}" type="${type}" name="${name}" value="${esc(p[name])}" placeholder="${esc(ph)}" autocomplete="off" />
    </div>`;

  root.innerHTML = `
    <section class="page">
      <div class="profile-head card">
        <div class="avatar big">${p.name ? `<span>${esc(initials(p.name))}</span>` : icon('user')}</div>
        <div class="profile-id">
          <h1>${p.name ? esc(displayName(p.name)) : 'Ваш аккаунт'}</h1>
          <p class="muted">${p.email ? esc(p.email) : 'Заполните данные из расчётного листка'}</p>
          ${p.organization || p.employeeId ? `<p class="muted small">${esc([p.organization, p.employeeId && `таб. № ${p.employeeId}`].filter(Boolean).join(' · '))}</p>` : ''}
        </div>
      </div>

      <form class="card" id="profile-form" novalidate>
        <div class="card-head">${icon('user')}<h2>Данные</h2></div>
        <div class="grid2">
          ${f('name', 'ФИО как в листке', 'user', 'text', 'Фамилия Имя Отчество')}
          ${f('email', 'Email', 'info', 'email', 'name@mail.com')}
          ${f('employeeId', 'Табельный номер', 'receipt')}
          ${f('organization', 'Организация', 'briefcase')}
          ${f('department', 'Подразделение', 'crew')}
        </div>
        <div class="form-actions">
          <button class="btn primary" type="submit">${icon('save')}Сохранить</button>
        </div>
      </form>

      <div class="card">
        <div class="card-head">${icon('wallet')}<h2>Мои оклады</h2></div>
        ${
          mySalaries
            ? `<ul class="kv">${mySalaries}</ul><p class="field-hint">Подставляются сами при выборе должности.</p>`
            : '<p class="muted small">Введите оклад в расчёте — он запомнится для этой должности.</p>'
        }
      </div>

      <div class="card">
        <div class="card-head">${icon('shield')}<h2>Хранение и перенос</h2></div>
        <p class="muted small">Аккаунт хранится только на этом устройстве, без паролей и серверов. Чтобы открыть его на другом телефоне, сохраните копию и загрузите её там.</p>
        <div class="row-actions">
          ${CAN_DOWNLOAD ? `<button class="btn" data-action="export">${icon('download')}Сохранить копию</button>` : ''}
          <label class="btn file-btn">${icon('upload')}Загрузить копию<input type="file" accept="application/json,.json" id="import-file" hidden /></label>
        </div>
      </div>
    </section>`;

  $<HTMLFormElement>('#profile-form', root)!.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const next: Profile = {
      name: String(fd.get('name') ?? '').trim(),
      email: String(fd.get('email') ?? '').trim(),
      employeeId: String(fd.get('employeeId') ?? '').trim(),
      organization: String(fd.get('organization') ?? '').trim(),
      department: String(fd.get('department') ?? '').trim(),
      createdAt: profile?.createdAt || new Date().toISOString(),
    };
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
      toast('Проверьте email');
      $<HTMLInputElement>('#p-email', root)?.focus();
      return;
    }
    profile = next;
    saveProfile(profile);
    renderShell();
    toast('Профиль сохранён');
  });

  $('[data-action=export]', root)?.addEventListener('click', () => {
    const data = JSON.stringify(makeBackup(profile, state, history, salaries), null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `crewpay-${(profile?.email || 'backup').replace(/[^\w.-]+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $<HTMLInputElement>('#import-file', root)!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const backup = parseBackup(reg, JSON.parse(await file.text()));
      if (!backup) throw new Error('format');
      if (!(await ask('Заменить данные на этом устройстве данными из файла?', 'Загрузить'))) return;
      applyBackup(backup);
      toast('Аккаунт загружен');
    } catch {
      toast('Это не файл CrewPay');
    }
  });
}

function applyBackup(b: Backup) {
  profile = b.profile;
  state = b.state;
  history = b.history;
  salaries = b.salaries;
  saveProfile(profile);
  saveState(state);
  saveHistory(history);
  saveSalaries(salaries);
  applyTheme();
  renderShell();
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
    <section class="page ref">
      <div class="page-head">
        <h1>Справочник</h1>
        <p class="muted">Положение <b>${esc(r.code)}</b>, действует с ${esc(new Date(r.effectiveFrom).toLocaleDateString('ru-RU'))}. Прочерк — сочетание недоступно.</p>
      </div>

      <div class="card">
        <div class="card-head">${icon('plane')}<h2>Пилоты · гарантия</h2><span class="muted small head-note">ставка ${money(reg.pilot.defaultRate)}</span></div>
        <div class="table-scroll">
          <table class="ref-table">
            <thead>
              <tr><th rowspan="2">Должность</th><th rowspan="2">Часы <span class="ref">2-2</span></th><th colspan="${reg.aircraft.length}">Коэф. гарантии <span class="ref">2-1</span></th></tr>
              <tr>${acHead}</tr>
            </thead>
            <tbody>
              ${reg.pilot.guaranteed
                .map((g) => `<tr><td>${esc(g.label)}</td><td>${num(g.guaranteedHours)}</td>${g.k1.map((k) => `<td>${coefCell(k)}</td>`).join('')}</tr>`)
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="table-scroll">
          <table class="ref-table">
            <thead>
              <tr><th rowspan="2">Должность</th><th colspan="${reg.aircraft.length}">Сверх гарантии <span class="ref">2-5</span></th></tr>
              <tr>${acHead}</tr>
            </thead>
            <tbody>
              ${reg.pilot.guaranteed
                .map((g) => `<tr><td>${esc(g.label)}</td>${g.k5.map((k) => `<td>${coefCell(k)}</td>`).join('')}</tr>`)
                .join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-head">${icon('clock')}<h2>Пилоты · норматив ${num(reg.pilot.normative.normHours)} ч</h2></div>
        <p class="muted small">${reg.pilot.normative.positions.map((p) => esc(p.label)).join(', ')}.</p>
        <div class="table-scroll">
          <table class="ref-table">
            <thead><tr><th>Коэффициент <span class="ref">2-3</span></th>${acHead}</tr></thead>
            <tbody><tr><td>за ${num(reg.pilot.normative.normHours)} ч</td>${reg.pilot.normative.k.map((k) => `<td>${coefCell(k)}</td>`).join('')}</tr></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-head">${icon('crew')}<h2>Бортпроводники</h2><span class="muted small head-note">ставка ${money(reg.cabin.defaultRate)}</span></div>
        <div class="table-scroll">
          <table class="ref-table">
            <thead><tr><th>Должность</th><th>До ${num(c.cabinTier1Hours)} ч <span class="ref">3-1</span></th><th>Свыше ${num(c.cabinTier1Hours)} ч <span class="ref">3-2</span></th></tr></thead>
            <tbody>${reg.cabin.positions.map((p) => `<tr><td>${esc(p.label)}</td><td>${coef(p.k3)}</td><td>${coef(p.k3over)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="muted small">${reg.cabin.includedInSalary.positions.map((p) => esc(p.label)).join(', ')} — налёт до ${reg.cabin.includedInSalary.hours} ч включён в оклад (${esc(reg.cabin.includedInSalary.ref)}).</p>
      </div>

      <div class="card">
        <div class="card-head">${icon('sliders')}<h2>Константы</h2></div>
        <dl class="consts">
          <dt>${icon('moon')}Ночные</dt><dd>× ${num(c.nightMultiplier)}</dd>
          <dt>${icon('star')}Праздничные</dt><dd>доплата × ${num(c.holidayExtraMultiplier)} (итого двойная)</dd>
          <dt>${icon('plane')}Порог пилотов</dt><dd>${num(c.pilotThresholdHours)} ч, × ${num(c.pilotThresholdMultiplier, 1)}</dd>
          <dt>${icon('crew')}Бортпроводники</dt><dd>ступень ${num(c.cabinTier1Hours)} ч, санитарная норма ${num(c.cabinSanitaryHours)} ч × ${num(c.cabinSanitaryMultiplier, 1)}</dd>
          <dt>${icon('plane')}Dead Head</dt><dd>${c.deadheadMultiplier > 0 ? `${num(c.deadheadMultiplier * 100)} % часа налёта` : 'не оплачивается'}</dd>
          <dt>${icon('receipt')}НДФЛ</dt><dd>${num(c.incomeTaxRate * 100)} %, в т. ч. ИНПС ${num(c.inpsRate * 100, 1)} %</dd>
          <dt>${icon('coin')}МРОТ</dt><dd>${money(c.minimumWage)} сум</dd>
          <dt>${icon('briefcase')}Фиксированный оклад</dt><dd>${[...reg.pilot.fixedSalary, ...reg.cabin.fixedSalary].map((p) => `${esc(p.label)} (${esc(p.ref ?? '')})`).join(', ')}</dd>
        </dl>
        <p class="field-hint">Значения хранятся в regulation.json — администратор меняет их без нового релиза.</p>
      </div>
    </section>`;
}

// ---------- settings ----------

function renderSettings(root: HTMLElement) {
  const s = state.settings;
  const radio = (name: string, value: string, checked: boolean, title: string, desc: string, ic?: string) => `
    <label class="option${checked ? ' active' : ''}">
      <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} />
      ${ic ? icon(ic) : ''}
      <span><b>${title}</b>${desc ? `<span class="muted small">${desc}</span>` : ''}</span>
    </label>`;
  root.innerHTML = `
    <section class="page">
      <div class="page-head"><h1>Настройки</h1></div>

      <div class="card">
        <div class="card-head">${icon('sun')}<h2>Оформление</h2></div>
        <div class="options-row">
          ${radio('theme', 'system', state.theme === 'system', 'Как в системе', '', 'monitor')}
          ${radio('theme', 'light', state.theme === 'light', 'Светлая', '', 'sun')}
          ${radio('theme', 'dark', state.theme === 'dark', 'Тёмная', '', 'moon')}
        </div>
      </div>

      <div class="card">
        <div class="card-head">${icon('plane')}<h2>Налёт свыше ${num(reg.constants.pilotThresholdHours)} ч · п. 2.12</h2></div>
        ${radio('over94Mode', 'replace', s.over94Mode === 'replace', 'Заменяет оплату сверх гарантии', `Часы выше ${num(reg.constants.pilotThresholdHours)} — только по 2,0 × k5 (как в ТЗ)`)}
        ${radio('over94Mode', 'additive', s.over94Mode === 'additive', 'Доплата поверх', `Часы выше ${num(reg.constants.pilotThresholdHours)} — по k5 и ещё 2,0 × k5`)}
      </div>

      <div class="card">
        <div class="card-head">${icon('clock')}<h2>Пропорция по отработанному времени</h2></div>
        ${radio('proportionBasis', 'days', s.proportionBasis === 'days', 'По дням', 'Отработано дней / норма дней — как в расчётном листке')}
        ${radio('proportionBasis', 'hours', s.proportionBasis === 'hours', 'По часам нормы', 'Отработано часов / норма часов')}
      </div>

      <div class="card callout">
        <div class="card-head">${icon('info')}<h2>Принято без переключателя</h2></div>
        <ul>
          <li>Праздничная доплата — по коэффициенту табл. 2-1 (п. 2.11.1).</li>
          <li>Пилот-инструктор на B-757: в табл. 2-5 прочерк — сверх гарантии не оплачивается.</li>
          <li>Санитарная норма пилотов — 94,5 ч (п. 2.4 / 2.12).</li>
          <li>Dead Head — ${num(reg.constants.deadheadMultiplier * 100)} % часа налёта, как в расчётном листке.</li>
          <li>Перевод в течение месяца — периоды считаются отдельно и суммируются.</li>
        </ul>
      </div>

      <div class="card">
        <div class="card-head">${icon('refresh')}<h2>Данные</h2></div>
        <div class="row-actions">
          <button class="btn" data-action="reset-rates">${icon('coin')}Ставки по умолчанию</button>
          <button class="btn ghost danger" data-action="reset-all">${icon('trash')}Удалить всё с устройства</button>
        </div>
      </div>
    </section>`;

  root.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((r) =>
    r.addEventListener('change', () => {
      if (r.name === 'theme') {
        state.theme = r.value as Theme;
        applyTheme();
      } else (state.settings as unknown as Record<string, string>)[r.name] = r.value;
      persist();
      renderSettings(root);
      toast('Сохранено');
    }),
  );
  $('[data-action=reset-rates]', root)!.addEventListener('click', () => {
    state.periods.forEach((p) => (p.rate = String(p.category === 'pilot' ? reg.pilot.defaultRate : reg.cabin.defaultRate)));
    persist();
    toast('Ставки сброшены');
  });
  $('[data-action=reset-all]', root)!.addEventListener('click', async () => {
    if (!(await ask('Удалить аккаунт, оклады, историю и настройки с этого устройства?', 'Удалить всё', true))) return;
    applyBackup(makeBackup(null, defaultState(reg), [], {}));
    toast('Данные удалены');
  });
}

// ---------- boot ----------

declare global {
  interface Window {
    __CREWPAY_SEED__?: unknown;
  }
}

async function boot() {
  reg = await loadRegulation();
  state = loadState(reg);
  history = loadHistory();
  profile = loadProfile();
  salaries = loadSalaries();

  // Предпросмотр может прийти с готовым аккаунтом — только если на устройстве ещё ничего нет.
  if (!hasSavedState() && window.__CREWPAY_SEED__) {
    const seed = parseBackup(reg, window.__CREWPAY_SEED__);
    if (seed) {
      profile = seed.profile;
      state = seed.state;
      history = seed.history;
      salaries = seed.salaries;
      saveProfile(profile);
      saveState(state);
      saveHistory(history);
      saveSalaries(salaries);
    }
  }

  applyTheme();
  renderShell();

  if ('serviceWorker' in navigator && import.meta.env.PROD && !IS_EMBED) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  }
}

boot();
