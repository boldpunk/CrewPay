import './style.css';
import { availableAircraft, calculateMonth, findPosition, positionsFor, statusesFor } from './calc/engine';
import { coef, hours as fmtHours, money, num, parseHours, parseMoney } from './calc/format';
import { formatDate, paymentSchedule, workingDays } from './calc/paydates';
import { type ReconRow, reconcile } from './calc/payslip';
import {
  type FlightForm,
  formatDuration,
  isPublicHoliday,
  normalizeRoute,
  parseDuration,
  parseQuickLine,
  summarizeFlights,
  validRoute,
} from './calc/flights';
import { type Account, ApiError, type ServerProfile, type UploadedPayslip, api, type Plan, type PlanInfo, type PayOrder, type PayProvider, type ProRequest } from './api';
import type { Category, MonthResult, Regulation, ResolvedPosition } from './calc/types';
import {
  type AppState,
  type Backup,
  type HistoryEntry,
  type PeriodForm,
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
import { type PowChallenge, type PowSolution, solvePow } from './pow';

type View = 'calc' | 'flights' | 'history' | 'reference' | 'profile' | 'settings' | 'pro' | 'legal';
/** guest — не вошёл; pending — ждёт администратора; blocked — доступ закрыт; offline — нет связи и нет сохранённого доступа. */
type Access = 'guest' | 'pending' | 'blocked' | 'active' | 'offline';

/** Сборка для предпросмотра во встроенном окне (claude.ai): там нет печати, скачивания файлов и service worker. */
const IS_EMBED = import.meta.env.VITE_TARGET === 'embed';
const CAN_PRINT = !IS_EMBED;
const CAN_DOWNLOAD = !IS_EMBED;

const CREDIT_URL = 'https://boldstudio.uz';

// Ставки приходят с сервера только после того, как администратор открыл доступ.
let reg!: Regulation;
let access: Access = 'guest';
let state: AppState;
let history: HistoryEntry[] = [];
let profile: Profile | null = null;
let salaries: Record<string, string> = {};
let view: View = 'calc';
let lastResult: MonthResult | null = null;
/** Последняя показанная сумма «К выплате» — от неё «докручиваем» до новой. */
let shownNet: number | null = null;
let netAnim = 0;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Сумма плавно перетекает к новому значению (как счётчик), а не прыгает. */
function animateNet(el: HTMLElement, to: number) {
  cancelAnimationFrame(netAnim);
  const from = shownNet;
  shownNet = to;
  const paint = (v: number) => (el.innerHTML = `${money(v)}<span class="cur">сум</span>`);
  if (from === null || from === to || reducedMotion()) return paint(to);
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
  const start = performance.now();
  const dur = Math.min(700, 260 + Math.log10(Math.abs(to - from) + 1) * 60);
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    paint(k < 1 ? Math.round(from + (to - from) * e) : to);
    if (k < 1) netAnim = requestAnimationFrame(step);
  };
  netAnim = requestAnimationFrame(step);
}
/** Сервер доступен (на статическом хостинге и в предпросмотре — нет). */
let serverUp = false;
let account: Account | null = null;
/** Подписка текущего аккаунта. */
let plan: Plan | null = null;
let proRequest: ProRequest | null = null;
let planInfo: PlanInfo | null = null;

const PLAN_KEY = 'crewpay.plan';

/**
 * Pro-функции: журнал рейсов, загрузка листков, PDF-отчёт.
 * Без сервера (предпросмотр) всё открыто; офлайн — по последнему известному плану аккаунта.
 */
function isPro(): boolean {
  if (serverUp) return !!plan?.pro;
  if (IS_EMBED) return true;
  try {
    const p = JSON.parse(localStorage.getItem(PLAN_KEY) ?? 'null') as Plan | null;
    return !!p && (p.admin || (!!p.until && new Date(p.until).getTime() > Date.now()));
  } catch {
    return false;
  }
}

function rememberPlan() {
  try {
    if (plan) localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
    else localStorage.removeItem(PLAN_KEY);
  } catch {
    /* хранилище недоступно */
  }
}

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
  // До открытия доступа состояния расчёта ещё нет — тему берём из сохранённого.
  const theme = (state as AppState | undefined)?.theme ?? savedTheme();
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

function savedTheme(): AppState['theme'] {
  try {
    const t = (JSON.parse(localStorage.getItem('crewpay.state.v1') ?? 'null') as { theme?: string } | null)?.theme;
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function isValidRegulation(x: unknown): x is Regulation {
  const r = x as Regulation;
  return !!r && Array.isArray(r.aircraft) && !!r.pilot && !!r.cabin && !!r.constants && !!r.regulation;
}

const REG_KEY = 'crewpay.reg';
const ACCESS_KEY = 'crewpay.access';

/** Ставки — только для пользователей с открытым доступом; копия на устройстве — для работы офлайн. */
async function fetchRegulation(): Promise<Regulation | null> {
  try {
    const data: unknown = await api.regulation();
    if (isValidRegulation(data)) {
      try {
        localStorage.setItem(REG_KEY, JSON.stringify(data));
      } catch {
        /* хранилище недоступно */
      }
      return data;
    }
  } catch {
    /* сеть — берём копию */
  }
  return cachedRegulation();
}

function cachedRegulation(): Regulation | null {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(REG_KEY) ?? 'null');
    return isValidRegulation(data) ? data : null;
  } catch {
    return null;
  }
}

/** Выход или закрытый доступ: на устройстве не остаётся ни ставок, ни отметки о доступе. */
function forgetAccess() {
  try {
    localStorage.removeItem(REG_KEY);
    localStorage.removeItem(ACCESS_KEY);
  } catch {
    /* хранилище недоступно */
  }
}

function rememberAccess() {
  try {
    localStorage.setItem(ACCESS_KEY, access);
  } catch {
    /* хранилище недоступно */
  }
}

/** Первичная загрузка данных приложения — когда ставки уже есть. */
function initData(r: Regulation) {
  reg = r;
  state = loadState(reg);
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
  ['flights', 'Рейсы', 'plane'],
  ['history', 'История', 'history'],
  ['reference', 'Справочник', 'book'],
  ['profile', 'Профиль', 'user'],
  ['settings', 'Настройки', 'sliders'],
];
/** На телефоне 5 вкладок; «Настройки» открываются из профиля. */
const MOBILE_TABS = TABS.filter(([id]) => id !== 'settings');

function renderShell() {
  const ini = profile?.name ? initials(profile.name) : '';
  const open = access === 'active';
  app.classList.toggle('gated', !open);
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <button class="brand" data-view="calc" aria-label="CrewPay — к расчёту">
          ${logoMark(34)}
          <span class="wordmark">Crew<span>Pay</span></span>
        </button>
        ${open ? `<nav class="nav-desktop" aria-label="Разделы">
          ${TABS.filter(([id]) => id !== 'profile')
            .map(
              ([id, label, ic]) =>
                `<button class="nav-link${view === id ? ' active' : ''}" data-view="${id}" ${view === id ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></button>`,
            )
            .join('')}
        </nav>
        <button class="avatar${view === 'profile' ? ' active' : ''}" data-view="profile" aria-label="Профиль">
          ${ini ? `<span>${esc(ini)}</span>` : icon('user')}
        </button>` : ''}
      </div>
    </header>
    <main id="view"></main>
    <footer class="site-footer">
      <div class="footer-inner">
        <div class="footer-brand">
          ${logoMark(22)}
          <span>© ${new Date().getFullYear()} CrewPay</span>
          <button class="footer-link" data-view="legal">Условия и контакты</button>
        </div>
        <a class="credit" href="${CREDIT_URL}" target="_blank" rel="noopener">
          <span>Дизайн и разработка —</span>
          <b>@boldpunk</b>
          <span class="credit-domain">boldstudio.uz</span>
          ${icon('arrowUpRight', 'icon credit-arrow')}
        </a>
      </div>
    </footer>
    ${open ? `<nav class="tabbar" aria-label="Разделы">
      ${MOBILE_TABS.map(
        ([id, label, ic]) =>
          `<button class="tab${view === id || (id === 'profile' && (view === 'settings' || view === 'pro')) ? ' active' : ''}" data-view="${id}" ${view === id ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></button>`,
      ).join('')}
    </nav>` : ''}
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
  `;
  app.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.view as View)),
  );
  renderView();
}

function go(v: View) {
  const from = TABS.findIndex(([id]) => id === view);
  const to = TABS.findIndex(([id]) => id === v);
  view = v;
  syncPath();
  renderShell();
  window.scrollTo({ top: 0 });
  // Переход между разделами: страница въезжает с той стороны, куда идём по вкладкам.
  const el = $('#view');
  if (el && !reducedMotion()) {
    el.classList.add('enter', to >= 0 && from >= 0 && to < from ? 'from-left' : 'from-right');
    setTimeout(() => el.classList.remove('enter', 'from-left', 'from-right'), 700);
  }
}

/** У страницы условий свой адрес — его можно дать платёжной системе: crewpay.uz/legal. */
function syncPath() {
  if (IS_EMBED) return;
  const path = view === 'legal' ? '/legal' : '/';
  if (location.pathname !== path) window.history.replaceState(null, '', path);
}

function renderView() {
  const root = $('#view')!;
  if (view === 'legal') return renderLegal(root);
  if (access !== 'active') return renderGate(root);
  if (view === 'calc') renderCalc(root);
  else if (view === 'flights') renderFlights(root);
  else if (view === 'reference') renderReference(root);
  else if (view === 'history') renderHistory(root);
  else if (view === 'profile') renderProfile(root);
  else if (view === 'pro') renderPro(root);
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
        ${uploadCard()}
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
                  return `<button role="radio" class="ac${p.aircraft === i ? ' active' : ''}" data-aircraft="${i}" ${ok ? '' : 'disabled title="Недоступно для этой должности"'} aria-checked="${p.aircraft === i}">${esc(a)}</button>`;
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
          <div class="card-head">${icon('clock')}<h2>Налёт за ${multi ? 'период' : 'месяц'}</h2>${
            p.flights.length
              ? ''
              : `<button class="chip head-note-btn" data-go="flights">${icon('plane')}По рейсам</button>`
          }</div>
          ${
            p.flights.length
              ? fromLogHtml(p)
              : `<div class="grid2">
            ${field('hours', 'Фактический налёт', p.hours, { suffix: 'ч', ic: 'clock', hint: 'Всего, с ночными и праздничными. Можно 65:30' })}
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
          </div>`
          }
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
                    hint: `По умолчанию ${money(p.category === 'pilot' ? reg.pilot.defaultRate : reg.cabin.defaultRate)}`,
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

// ---------- расчётный листок ----------

let importNotes: string[] = [];

function uploadCard(): string {
  if (!serverUp) return '';
  if (!account)
    return `
    <div class="card upload upload-guest">
      <div class="upload-icon">${icon('receipt')}</div>
      <div class="upload-text">
        <b>Загрузите расчётный листок — посчитаем сами</b>
        <span class="muted small">Войдите, чтобы загружать листки PDF и хранить расчёты в облаке.</span>
      </div>
      <button class="btn primary small" data-go="profile">${icon('user')}Войти</button>
    </div>`;
  if (!isPro())
    return `
    <div class="card upload upload-guest">
      <div class="upload-icon">${icon('receipt')}</div>
      <div class="upload-text">
        <b>Загрузка расчётного листка ${proTag()}</b>
        <span class="muted small">PDF из 1С — месяц, часы и суммы заполнятся сами, каждая строка будет сверена.</span>
      </div>
      <button class="btn primary small" data-pro>${icon('crown')}Оформить</button>
    </div>`;
  const ps = state.payslip;
  return `
    <div class="card upload" id="upload">
      <input type="file" id="payslip-file" accept="application/pdf,.pdf" hidden />
      <label for="payslip-file" class="dropzone" id="dropzone">
        <span class="upload-icon">${icon('upload')}</span>
        <span class="upload-text">
          <b>${ps ? 'Загрузить другой листок' : 'Загрузить расчётный листок'}</b>
          <span class="muted small">PDF из 1С — месяц, часы и суммы заполнятся сами, каждая строка будет сверена</span>
        </span>
      </label>
      ${
        ps
          ? `<div class="attached">
              ${icon('receipt')}
              <span class="attached-name">${esc(ps.filename)}</span>
              <a class="chip" href="${api.payslipUrl(ps.id)}" target="_blank" rel="noopener">${icon('arrowUpRight')}PDF</a>
              <button class="chip ghost" data-action="detach">${icon('x')}Открепить</button>
            </div>`
          : ''
      }
      ${importNotes.length ? `<div class="alert warn">${icon('alert')}<ul>${importNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    </div>`;
}

function applyImport(u: UploadedPayslip) {
  const im = u.imported;
  const prev = period();
  const base = defaultPeriod(reg, im.category);
  const pos = im.positionId ? findPosition(reg, im.category, im.positionId) : undefined;
  const hrs = (n: number) => (n ? num(n) : '');
  state = {
    ...state,
    month: im.month ?? state.month,
    norm: im.norm ? String(im.norm) : state.norm,
    active: 0,
    periods: [
      {
        ...base,
        positionId: pos?.id ?? (prev.category === im.category ? prev.positionId : base.positionId),
        aircraft: prev.category === im.category && prev.positionId === pos?.id ? prev.aircraft : -1,
        statusId: prev.category === im.category ? prev.statusId : base.statusId,
        hours: hrs(im.hours),
        nightHours: hrs(im.nightHours),
        holidayHours: hrs(im.holidayHours),
        deadheadHours: hrs(im.deadheadHours),
        worked: im.worked ? num(im.worked) : '',
        salary: im.salary ? num(im.salary) : '',
        rate: im.rate ? num(im.rate) : base.rate,
      },
    ],
    extras: im.extras.map((x) => ({ title: x.title, amount: num(x.amount) })),
    payslip: { id: u.id, filename: u.filename, uploadedAt: u.createdAt, parsed: u.parsed },
  };
  if (pos && im.salary) {
    salaries[pos.id] = num(im.salary);
    saveSalaries(salaries);
  }
  // Пустые поля профиля заполняем из шапки листка.
  const pr = u.parsed;
  profile = {
    name: profile?.name || pr.name,
    email: profile?.email || account?.email || '',
    employeeId: profile?.employeeId || pr.employeeId,
    organization: profile?.organization || pr.organization,
    department: profile?.department || pr.department,
    createdAt: profile?.createdAt || new Date().toISOString(),
  };
  saveProfile(profile);
  syncProfileSoon();
  importNotes = im.notes;
  persist();
}

async function handleUpload(root: HTMLElement, file: File) {
  const zone = $('#dropzone', root);
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return toast('Нужен PDF-файл');
  zone?.classList.add('busy');
  const title = zone?.querySelector('b');
  if (title) title.textContent = 'Распознаю листок…';
  try {
    const u = await api.uploadPayslip(file);
    applyImport(u);
    renderShell();
    const rows = currentRecon();
    const bad = rows.filter((r) => !r.ok).length;
    toast(
      rows.length
        ? bad
          ? `${monthLabel(state.month)}: расхождений ${bad}`
          : `${monthLabel(state.month)}: все ${rows.length} строк совпадают`
        : `Листок за ${monthLabel(state.month).toLowerCase()} загружен`,
    );
  } catch (e) {
    zone?.classList.remove('busy');
    if (title) title.textContent = 'Загрузить расчётный листок';
    if (proExpired(e)) return;
    toast(e instanceof ApiError ? e.message : 'Не удалось загрузить файл');
  }
}

function bindUpload(root: HTMLElement) {
  $('[data-go=profile]', root)?.addEventListener('click', () => go('profile'));
  const input = $<HTMLInputElement>('#payslip-file', root);
  const zone = $('#dropzone', root);
  if (!input || !zone) return;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) handleUpload(root, f);
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleUpload(root, f);
  });
  $('[data-action=detach]', root)?.addEventListener('click', () => {
    state.payslip = null;
    importNotes = [];
    persist();
    renderCalc(root);
  });
}

/** Сверка текущего расчёта с прикреплённым листком (тот же код, что на сервере). */
function currentRecon(): ReconRow[] {
  const ps = state.payslip;
  if (!ps || ps.parsed.month !== state.month) return [];
  try {
    return reconcile(reg, state.settings, ps.parsed, toMonthInput(state));
  } catch {
    return [];
  }
}

/** Налёт из журнала рейсов — только просмотр, правка на странице «Рейсы». */
function fromLogHtml(p: PeriodForm): string {
  const t = summarizeFlights(reg, state.month, p.flights);
  const errs = t.issues.filter((i) => i.severity === 'error').length;
  const row = (label: string, min: number, ic: string) =>
    min ? `<li>${icon(ic)}<span>${label}</span><b>${formatDuration(min)}</b><span class="muted">${num(Math.round((min / 60) * 100) / 100)} ч</span></li>` : '';
  return `
    <div class="from-log">
      <p class="muted small">Из журнала: ${t.count} ${plural(t.count, 'рейс', 'рейса', 'рейсов')}${errs ? ` · <span class="danger">${errs} с ошибками</span>` : ''}</p>
      <ul class="kv-time">
        ${row('Налёт', t.flightMin, 'clock')}
        ${row('Ночные', t.nightMin, 'moon')}
        ${row('Праздничные', t.holidayMin, 'star')}
        ${row('Ночью в праздник', t.nightHolidayMin, 'moon')}
        ${row('Dead Head', t.deadheadMin, 'plane')}
        ${row('Рабочее время', t.dutyMin, 'briefcase')}
      </ul>
      <button class="btn small" data-go="flights">${icon('plane')}Открыть рейсы</button>
    </div>`;
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
  syncProfileSoon();
}

function bindCalc(root: HTMLElement) {
  bindUpload(root);
  root.querySelectorAll<HTMLButtonElement>('[data-go=flights]').forEach((b) => b.addEventListener('click', () => go('flights')));
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
    if (state.payslip?.parsed.month !== state.month) state.payslip = null;
    persist();
    renderCalc(root);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-month]').forEach((b) =>
    b.addEventListener('click', () => {
      state.month = shiftMonth(state.month, Number(b.dataset.month));
      if (state.payslip?.parsed.month !== state.month) state.payslip = null;
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
      flights: [],
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
      { ...first, hours: '', nightHours: '', holidayHours: '', nightHolidayHours: '', deadheadHours: '', worked: '', flights: [] },
    ];
    state.extras = [];
    state.active = 0;
    state.norm = '';
    state.payslip = null;
    importNotes = [];
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

  const recon = ok ? currentRecon() : [];
  const reconBad = recon.filter((r) => !r.ok).length;
  const ps = state.payslip;
  const reconCard =
    ps && ok
      ? ps.parsed.month !== state.month
        ? `<div class="alert warn">${icon('alert')}<div>Прикреплён листок за ${esc(monthLabel(ps.parsed.month ?? ''))}, а расчёт — ${esc(monthFor(state.month))}.</div></div>`
        : `
    <div class="card recon">
      <div class="card-head">${icon('receipt')}<h2>Сверка с расчётным листком</h2><span class="muted small head-note">${esc(ps.filename)}</span></div>
      <div class="recon-summary ${reconBad ? 'bad' : 'good'}">${icon(reconBad ? 'alert' : 'check')}<span>${
        reconBad
          ? `Расхождений: ${reconBad} из ${recon.length}. Проверьте отмеченные строки.`
          : `Все ${recon.length} строк совпадают — начисление верное.`
      }</span></div>
      <ul class="recon-list">
        ${recon
          .map(
            (r) => `
          <li class="${r.ok ? 'ok' : 'bad'}">
            <span class="recon-label">${esc(r.label)}</span>
            <span class="recon-vals"><span class="muted small">листок</span> ${money(r.slip)}<br /><span class="muted small">расчёт</span> ${money(r.calc)}</span>
            <span class="recon-status">${icon(r.ok ? 'check' : 'alert')}${r.ok ? '' : `${r.diff > 0 ? '+' : '−'}${money(Math.abs(r.diff))}`}</span>
          </li>`,
          )
          .join('')}
      </ul>
    </div>`
      : '';

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
      ${
        ok && recon.length
          ? `<div class="hero-check ${reconBad ? 'bad' : 'good'}">${icon(reconBad ? 'alert' : 'check')}${
              reconBad ? `Расхождения с листком: ${reconBad}` : 'Совпадает с расчётным листком'
            }</div>`
          : ''
      }
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

    ${reconCard}

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

    <p class="disclaimer">${icon('info')}<span>Справочный расчёт по введённым данным — не официальный документ. Размер оплаты определяет работодатель.
      <button class="link" data-view="legal">Условия</button></span></p>

    <div class="result-actions">
      <button class="btn primary" data-action="save-history" ${ok ? '' : 'disabled'}>${icon('save')}Сохранить ${esc(monthLabel(state.month, true))}</button>
      <button class="btn" data-action="copy" ${ok ? '' : 'disabled'}>${icon('copy')}Копировать</button>
      ${
        serverUp && !isPro()
          ? `<button class="btn" data-pro title="PDF-отчёт — в CrewPay Pro">${icon('lock')}PDF</button>`
          : serverUp || CAN_PRINT
            ? `<button class="btn" data-action="pdf" ${ok ? '' : 'disabled'}>${icon('download')}PDF</button>`
            : ''
      }
    </div>
    <div class="print-only print-meta">
      ${esc(monthLabel(state.month))} · ${esc(profile?.name ?? '')} · ${esc(result.periods.map((_, i) => describePeriod(i)).join('; '))} · CrewPay
    </div>
  `;

  const hv = $('.hero-value', root);
  if (hv && ok) animateNet(hv, result.net);
  else if (!ok) shownNet = null;
  $('[data-action=save-history]', root)?.addEventListener('click', saveToHistory);
  $<HTMLButtonElement>('[data-action=pdf]', root)?.addEventListener('click', (e) => downloadReport(e.currentTarget as HTMLButtonElement));
  $('[data-action=copy]', root)?.addEventListener('click', () => copySummary(result, extraLines));
}

/** Красивый PDF строит сервер; без сервера — печать страницы. */
async function downloadReport(btn: HTMLButtonElement) {
  if (!serverUp) return window.print();
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${icon('refresh', 'icon spin')}PDF`;
  try {
    const blob = await api.report({
      month: state.month,
      state: { norm: state.norm, periods: state.periods, extras: state.extras, settings: state.settings },
      payslipId: account ? (state.payslip?.id ?? null) : null,
      profile: profile
        ? { name: profile.name, employeeId: profile.employeeId, organization: profile.organization, department: profile.department }
        : undefined,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CrewPay-${state.month}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('PDF готов');
  } catch (e) {
    if (proExpired(e)) return;
    toast(e instanceof ApiError ? e.message : 'Не удалось сформировать PDF');
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
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
  entry.payslipId = state.payslip?.id ?? null;
  if (account) {
    try {
      // Итоги пересчитывает сервер — в истории хранятся проверенные суммы.
      const r = await api.saveMonth(entry.month, entry.state, entry.payslipId ?? null);
      Object.assign(entry, { total: r.totals.total, net: r.totals.net, piece: r.totals.piece, time: r.totals.time, extras: r.totals.extras });
    } catch (e) {
      return toast(e instanceof ApiError ? e.message : 'Не удалось сохранить в аккаунт');
    }
  }
  history = [entry, ...history.filter((h) => h.month !== entry.month)].sort((a, b) => b.month.localeCompare(a.month));
  saveHistory(history);
  toast(account ? `Сохранено в аккаунте: ${monthLabel(entry.month)}` : `Сохранено: ${monthLabel(entry.month)}`);
}

// ---------- рейсы ----------

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Время без двоеточия: «600» → «6:00», «1302» → «13:02», «6.30» → «6:30». */
function autoColon(v: string): string {
  const t = v.trim();
  if (/^\d{3,4}$/.test(t)) return `${Number(t.slice(0, -2))}:${t.slice(-2)}`;
  return t.replace(/^(\d{1,3})[.,](\d{2})$/, '$1:$2');
}

const reverseRoute = (r: string) => normalizeRoute(r).split('-').reverse().join('-');

/** Последний рейс по каждому маршруту — из журнала и истории: время подставляется само. */
function routeMemory(): Map<string, FlightForm> {
  const all = [
    ...history.flatMap((h) => h.state.periods.flatMap((p) => p.flights ?? [])),
    ...state.periods.flatMap((p) => p.flights),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const mem = new Map<string, FlightForm>();
  for (const f of all) {
    const r = normalizeRoute(f.route);
    if (validRoute(r) && f.block.trim()) mem.set(r, f);
  }
  return mem;
}

/** Часы периода берутся из журнала рейсов. */
function syncFlightsToPeriod(p: PeriodForm) {
  const t = summarizeFlights(reg, state.month, p.flights);
  const v = (x: number) => (x ? num(x) : '');
  p.hours = v(t.hours);
  p.nightHours = v(t.nightHours);
  p.holidayHours = v(t.holidayHours);
  p.nightHolidayHours = v(t.nightHolidayHours);
  p.deadheadHours = v(t.deadheadHours);
}

function monthBounds(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { min: `${ym}-01`, max: `${ym}-${String(last).padStart(2, '0')}` };
}

function defaultFlightDate(p: PeriodForm): string {
  const last = [...p.flights].reverse().find((f) => f.date.startsWith(state.month));
  if (last) return last.date;
  const today = new Date();
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return t.startsWith(state.month) ? t : `${state.month}-01`;
}

function flightRow(f: FlightForm, issues: { field: string; message: string; severity: string }[]): string {
  const { min, max } = monthBounds(state.month);
  const holiday = !f.dh && isPublicHoliday(reg, f.date);
  const bad = (field: string) => (issues.some((i) => i.field === field && i.severity === 'error') ? ' invalid' : '');
  const time = (field: 'block' | 'night' | 'duty', label: string, ic: string) => `
    <label class="fl-time">
      <span>${icon(ic)}${label}</span>
      <input type="text" inputmode="numeric" autocomplete="off" data-f="${field}" value="${esc(f[field])}" placeholder="0:00" class="${bad(field).trim()}" aria-label="${label}" />
    </label>`;
  return `
    <li class="flight${f.dh ? ' is-dh' : ''}${holiday ? ' is-holiday' : ''}" data-id="${esc(f.id)}">
      <div class="fl-top">
        <input type="date" data-f="date" value="${esc(f.date)}" min="${min}" max="${max}" class="fl-date${bad('date')}" aria-label="Дата вылета" />
        <input type="text" data-f="route" value="${esc(f.route)}" list="known-routes" placeholder="TAS-DXB" autocapitalize="characters" autocomplete="off" spellcheck="false" class="fl-route${bad('route')}" aria-label="Маршрут" />
        <button type="button" class="chip dh${f.dh ? ' active' : ''}" data-act="dh" aria-pressed="${f.dh}" title="Перелёт пассажиром (Dead Head)">DH</button>
      </div>
      <div class="fl-times">
        ${time('block', 'Полётное', 'clock')}
        ${time('night', 'Ночные', 'moon')}
        ${time('duty', 'Рабочее', 'briefcase')}
      </div>
      <div class="fl-foot">
        ${holiday ? `<span class="tag holiday">${icon('star')}праздник — двойная оплата</span>` : ''}
        ${f.dh ? `<span class="tag">${icon('plane')}Dead Head · ${num(reg.constants.deadheadMultiplier * 100)} %</span>` : ''}
        <span class="fl-issues">${issues.map((i) => `<span class="${i.severity}">${esc(i.message)}</span>`).join('')}</span>
        <span class="fl-actions">
          <button type="button" class="icon-btn small" data-act="reverse" title="Обратный рейс" aria-label="Добавить обратный рейс">${icon('refresh')}</button>
          <button type="button" class="icon-btn small" data-act="delete" title="Удалить" aria-label="Удалить рейс">${icon('trash')}</button>
        </span>
      </div>
    </li>`;
}

function flightTotalsHtml(): string {
  const p = period();
  const t = summarizeFlights(reg, state.month, p.flights);
  const tile = (label: string, min: number, ic: string, accent = '') => `
    <div class="ft-tile${accent}">
      <span class="ft-label">${icon(ic)}${label}</span>
      <b>${formatDuration(min)}</b>
      <span class="muted small">${num(Math.round((min / 60) * 100) / 100)} ч</span>
    </div>`;
  return `
    ${tile('Налёт', t.flightMin, 'plane', ' main')}
    ${tile('Ночные', t.nightMin, 'moon')}
    ${tile('Праздники', t.holidayMin, 'star')}
    ${tile('DH', t.deadheadMin, 'plane')}
    ${tile('Рабочее', t.dutyMin, 'briefcase')}
    <div class="ft-tile">
      <span class="ft-label">${icon('calendar')}Рейсов</span>
      <b>${t.count}</b>
      <span class="muted small">${new Set(p.flights.filter((f) => f.route.trim()).map((f) => f.date)).size} дн.</span>
    </div>`;
}

// ---------- форма «Новый рейс» ----------

interface FlightDraft {
  date: string;
  from: string;
  to: string;
  block: string;
  night: string;
  duty: string;
  dh: boolean;
}

let draft: FlightDraft | null = null;
let draftHint = '';
let draftFocus: string | null = null;

function freshDraft(): FlightDraft {
  return { date: defaultFlightDate(period()), from: '', to: '', block: '', night: '', duty: '', dh: false };
}

/** Набрано в русской раскладке: «ЕФЫ» → «TAS». */
const RU_TO_EN: Record<string, string> = Object.fromEntries(
  [...'ЙЦУКЕНГШЩЗФЫВАПРОЛДЯЧСМИТЬ'].map((ch, i) => [ch, 'QWERTYUIOPASDFGHJKLZXCVBNM'[i]]),
);
function iata(v: string): string {
  return [...v.toUpperCase()]
    .map((ch) => RU_TO_EN[ch] ?? ch)
    .filter((ch) => /[A-Z]/.test(ch))
    .join('')
    .slice(0, 3);
}

function newFlightForm(): string {
  if (!draft || !draft.date.startsWith(state.month)) draft = { ...freshDraft(), from: draft?.from ?? '' };
  const d = draft;
  const { min, max } = monthBounds(state.month);
  const airports = [...new Set([...routeMemory().keys()].flatMap((r) => r.split('-')))].sort();
  const timeField = (id: 'block' | 'night' | 'duty', label: string, ic: string, ph: string, hint: string) => `
    <label class="nf-field nf-time" for="nf-${id}">
      <span class="nf-label">${icon(ic)}${label}</span>
      <input id="nf-${id}" type="text" inputmode="numeric" autocomplete="off" value="${esc(d[id])}" placeholder="${ph}" data-nf="${id}" />
      <span class="nf-hint">${hint}</span>
    </label>`;
  return `
    <form class="card new-flight" id="nf-form" autocomplete="off" novalidate>
      <div class="card-head">${icon('plus')}<h2>Новый рейс</h2><span class="muted small head-note nf-keys">Tab — следующее поле, Enter — добавить</span></div>
      <div class="nf-grid">
        <label class="nf-field nf-date" for="nf-date">
          <span class="nf-label">${icon('calendar')}Дата вылета</span>
          <input id="nf-date" type="date" value="${esc(d.date)}" min="${min}" max="${max}" data-nf="date" />
        </label>
        <div class="nf-route">
          <label class="nf-field" for="nf-from">
            <span class="nf-label">${icon('plane')}Откуда</span>
            <input id="nf-from" class="iata" type="text" maxlength="3" autocapitalize="characters" spellcheck="false" list="known-airports" value="${esc(d.from)}" placeholder="TAS" data-nf="from" />
          </label>
          <button type="button" class="nf-swap" id="nf-swap" title="Поменять местами" aria-label="Поменять аэропорты местами">⇄</button>
          <label class="nf-field" for="nf-to">
            <span class="nf-label">${icon('plane')}Куда</span>
            <input id="nf-to" class="iata" type="text" maxlength="3" autocapitalize="characters" spellcheck="false" list="known-airports" value="${esc(d.to)}" placeholder="DXB" data-nf="to" />
          </label>
        </div>
        <div class="nf-times">
          ${timeField('block', 'Полётное', 'clock', '6:00', 'обязательно')}
          ${timeField('night', 'Ночные', 'moon', '0:00', 'из полётного')}
          ${timeField('duty', 'Рабочее', 'briefcase', '0:00', 'справочно')}
        </div>
      </div>
      <datalist id="known-airports">${airports.map((a) => `<option value="${a}"></option>`).join('')}</datalist>
      ${draftHint ? `<p class="nf-note">${icon('sparkle')}${esc(draftHint)}</p>` : ''}
      <p class="nf-error" id="nf-error" role="alert" hidden></p>
      <div class="nf-actions">
        <label class="switch">
          <input type="checkbox" id="nf-dh" ${d.dh ? 'checked' : ''} />
          <span class="switch-track" aria-hidden="true"></span>
          <span>Перелёт пассажиром <b>DH</b></span>
        </label>
        <button class="btn primary" type="submit">${icon('plus')}Добавить рейс</button>
      </div>
      <details class="paste">
        <summary>${icon('copy')}Вставить списком</summary>
        <textarea id="paste-input" rows="4" spellcheck="false" placeholder="05.08 TAS-DXB 6:00 3:02 9:42&#10;06.08 DXB-TAS 3:04 0:00 5:10&#10;10.08 DH IST-TAS 5:05"></textarea>
        <div class="paste-row">
          <span class="field-hint">Строка: дата, маршрут, полётное, ночные, рабочее. DH — перелёт пассажиром.</span>
          <button type="button" class="btn small" id="paste-add">${icon('plus')}Добавить все</button>
        </div>
      </details>
    </form>`;
}

function bindNewFlight(root: HTMLElement) {
  const form = $<HTMLFormElement>('#nf-form', root);
  if (!form || !draft) return;
  const d = draft;
  const el = (id: string) => $<HTMLInputElement>(`#nf-${id}`, root)!;
  const err = $('#nf-error', root)!;
  const fail = (msg: string, focusId: string) => {
    err.textContent = msg;
    err.hidden = false;
    el(focusId).classList.add('invalid');
    el(focusId).focus();
  };

  // Время маршрута из прошлых рейсов — если поля ещё пустые.
  const suggest = () => {
    if (d.from.length !== 3 || d.to.length !== 3 || d.block) return;
    const known = routeMemory().get(`${d.from}-${d.to}`);
    if (!known) return;
    d.block = known.block;
    d.night = known.night;
    d.duty = known.duty;
    for (const k of ['block', 'night', 'duty'] as const) el(k).value = d[k];
    toast(`Время ${d.from}-${d.to} — из прошлого рейса`);
  };

  form.querySelectorAll<HTMLInputElement>('[data-nf]').forEach((inp) => {
    const key = inp.dataset.nf as keyof FlightDraft;
    inp.addEventListener('focus', () => document.body.classList.add('typing'));
    inp.addEventListener('input', () => {
      inp.classList.remove('invalid');
      err.hidden = true;
      if (key === 'from' || key === 'to') {
        const v = iata(inp.value);
        if (v !== inp.value) inp.value = v;
        d[key] = v;
        // Три буквы — сразу к следующему полю.
        if (v.length === 3) {
          if (key === 'to') suggest();
          el(key === 'from' ? 'to' : 'block').focus();
        }
      } else if (key === 'date') d.date = inp.value;
      else if (key !== 'dh') {
        d[key] = inp.value;
        // «6:00» / «0600» набрано полностью — дальше.
        if (/^\d{1,2}:\d{2}$/.test(inp.value) || /^\d{4}$/.test(inp.value)) {
          inp.value = autoColon(inp.value);
          d[key] = inp.value;
          const next = key === 'block' ? 'night' : key === 'night' ? 'duty' : null;
          if (next) el(next).focus();
        }
      }
    });
    inp.addEventListener('blur', () => {
      document.body.classList.remove('typing');
      if (key === 'block' || key === 'night' || key === 'duty') {
        inp.value = autoColon(inp.value);
        d[key] = inp.value;
      }
      if (key === 'to') suggest();
    });
  });
  el('dh').addEventListener('change', () => (d.dh = el('dh').checked));
  $('#nf-swap', root)?.addEventListener('click', () => {
    [d.from, d.to] = [d.to, d.from];
    el('from').value = d.from;
    el('to').value = d.to;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    for (const k of ['block', 'night', 'duty'] as const) d[k] = autoColon(el(k).value);
    d.date = el('date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return fail('Укажите дату вылета.', 'date');
    if (d.from.length !== 3) return fail('Аэропорт вылета — три буквы, например TAS.', 'from');
    if (d.to.length !== 3) return fail('Аэропорт прилёта — три буквы, например DXB.', 'to');
    if (d.from === d.to) return fail('Аэропорты вылета и прилёта совпадают.', 'to');
    const block = parseDuration(d.block);
    const night = parseDuration(d.night);
    const duty = parseDuration(d.duty);
    if (!(block > 0)) return fail('Укажите полётное время, например 6:00.', 'block');
    if (Number.isNaN(night)) return fail('Ночные — в формате 3:02.', 'night');
    if (night > block) return fail('Ночных часов больше, чем полётного времени.', 'night');
    if (Number.isNaN(duty)) return fail('Рабочее время — в формате 9:42.', 'duty');

    const route = `${d.from}-${d.to}`;
    // Следующий рейс обычно обратный: готовим его заранее.
    const back = routeMemory().get(`${d.to}-${d.from}`);
    const added: Omit<FlightForm, 'id'> = { date: d.date, route, block: d.block, night: d.night, duty: d.duty, dh: d.dh };
    draft = { date: d.date, from: d.to, to: d.from, block: back?.block ?? '', night: back?.night ?? '', duty: back?.duty ?? '', dh: false };
    draftHint = `Добавлен ${route}. Следующий — обратный ${d.to}-${d.from}${back ? ', время из прошлого рейса' : ''}: проверьте и нажмите «Добавить», или измените поля.`;
    draftFocus = 'nf-block';
    addFlights(root, [added]);
    toast(`Добавлен ${route}`);
  });

  // Список строками — для вставки ростера.
  $('#paste-add', root)?.addEventListener('click', () => {
    const text = $<HTMLTextAreaElement>('#paste-input', root)!.value;
    const lines = text.split(/\r?\n/).map((l) => parseQuickLine(l, state.month)).filter((x) => x !== null);
    if (!lines.length) return toast('Не понял строки — пример: 05.08 TAS-DXB 6:00 3:02 9:42');
    const mem = routeMemory();
    let lastDate = defaultFlightDate(period());
    const items = lines.map((l) => {
      const known = !l.block && validRoute(l.route) ? mem.get(l.route) : undefined;
      lastDate = l.date ?? lastDate;
      return {
        date: lastDate,
        route: l.route,
        block: l.block || known?.block || '',
        night: l.night || (l.block ? '' : known?.night || ''),
        duty: l.duty || (l.block ? '' : known?.duty || ''),
        dh: l.dh,
      };
    });
    draftHint = '';
    addFlights(root, items);
    toast(`Добавлено рейсов: ${items.length}`);
  });

  if (draftFocus) {
    $<HTMLInputElement>(`#${draftFocus}`, root)?.focus();
    draftFocus = null;
  }
}

function renderFlights(root: HTMLElement) {
  document.body.classList.remove('typing');
  if (!isPro()) {
    const n = state.periods.reduce((s, x) => s + x.flights.length, 0);
    root.innerHTML = `
      <section class="page flights-page">
        <div class="page-head">
          <h1>Рейсы</h1>
          <p class="muted">Вводите каждый рейс — налёт, ночные и праздничные часы месяца посчитаются сами и попадут в расчёт.</p>
        </div>
        ${proGate(
          'Журнал рейсов — в CrewPay Pro',
          n
            ? `Ваши ${n} ${plural(n, 'рейс сохранён', 'рейса сохранены', 'рейсов сохранены')} — журнал откроется после оформления Pro.`
            : 'Например, TAS-DXB: 6:00 полётного, 3:02 ночных, 9:42 рабочего — CrewPay сложит месяц до минуты, отметит праздники и Dead Head.',
        )}
      </section>`;
    return;
  }
  const p = period();
  const t = summarizeFlights(reg, state.month, p.flights);
  const order = [...p.flights].sort((a, b) => a.date.localeCompare(b.date));
  const multi = state.periods.length > 1;
  const mem = routeMemory();
  const result = calculateMonth(reg, state.settings, toMonthInput(state));
  const netOk = !result.errors.length && state.norm.trim() !== '';

  root.innerHTML = `
    <section class="page flights-page">
      <div class="page-head">
        <h1>Рейсы</h1>
        <p class="muted">Вводите каждый рейс — налёт, ночные и праздничные часы месяца посчитаются сами и попадут в расчёт.</p>
      </div>

      <div class="card">
        <div class="month-stepper">
          <button class="icon-btn" data-fmonth="-1" aria-label="Предыдущий месяц">${icon('chevron', 'icon rot90')}</button>
          <div class="month-pick static">${icon('calendar')}<span class="month-name">${esc(monthLabel(state.month))}</span></div>
          <button class="icon-btn" data-fmonth="1" aria-label="Следующий месяц">${icon('chevron', 'icon rot-90')}</button>
        </div>
        ${
          multi
            ? `<div class="periods">${state.periods
                .map((_, i) => `<button class="chip${i === state.active ? ' active' : ''}" data-fperiod="${i}">Период ${i + 1}</button>`)
                .join('')}</div>`
            : ''
        }
        <div class="ft-grid" id="ft-totals">${flightTotalsHtml()}</div>
        <div id="ft-gauge">${gauge()}</div>
      </div>

      ${newFlightForm()}

      <div class="card">
        <div class="card-head">${icon('plane')}<h2>Журнал${multi ? ` · период ${state.active + 1}` : ''}</h2><span class="muted small head-note">${t.count} ${plural(t.count, 'рейс', 'рейса', 'рейсов')}</span></div>
        ${
          order.length
            ? `<ul class="flight-list" id="flight-list">${order.map((f) => flightRow(f, t.issues.filter((i) => i.id === f.id))).join('')}</ul>`
            : `<div class="empty-flights">${icon('plane', 'icon empty-icon')}<p>Рейсов пока нет. Добавьте первый строкой выше или кнопкой ниже.</p></div>`
        }
        <datalist id="known-routes">${[...mem.keys()].map((r) => `<option value="${esc(r)}"></option>`).join('')}</datalist>
        <div class="form-actions">
          <button class="btn" data-act="add">${icon('plus')}Рейс</button>
          ${p.flights.length ? `<button class="btn ghost danger" data-act="clear">${icon('trash')}Очистить месяц</button>` : ''}
        </div>
      </div>

      <button class="card to-calc" data-go="calc">
        <span>${icon('wallet')}<span>${netOk ? 'К выплате' : 'Перейти к расчёту'}</span></span>
        <b>${netOk ? `${money(result.net)} сум` : ''}</b>${icon('chevron', 'icon rot-90')}
      </button>
    </section>`;

  bindFlights(root);
}

function refreshFlightSummary(root: HTMLElement) {
  const p = period();
  const t = summarizeFlights(reg, state.month, p.flights);
  const totals = $('#ft-totals', root);
  if (totals) totals.innerHTML = flightTotalsHtml();
  const g = $('#ft-gauge', root);
  if (g) g.innerHTML = gauge();
  // Подсветка ошибок по строкам без перерисовки полей.
  root.querySelectorAll<HTMLElement>('.flight').forEach((li) => {
    const issues = t.issues.filter((i) => i.id === li.dataset.id);
    li.querySelectorAll<HTMLInputElement>('[data-f]').forEach((el) =>
      el.classList.toggle('invalid', issues.some((i) => i.field === el.dataset.f && i.severity === 'error')),
    );
    const box = li.querySelector('.fl-issues');
    if (box) box.innerHTML = issues.map((i) => `<span class="${i.severity}">${esc(i.message)}</span>`).join('');
  });
  const result = calculateMonth(reg, state.settings, toMonthInput(state));
  const b = $('.to-calc b', root);
  if (b) b.textContent = !result.errors.length && state.norm.trim() !== '' ? `${money(result.net)} сум` : '';
}

function commitFlights(root: HTMLElement, rerender: boolean) {
  const p = period();
  if (p.flights.length) syncFlightsToPeriod(p);
  persist();
  if (rerender) renderFlights(root);
  else refreshFlightSummary(root);
}

function addFlights(root: HTMLElement, items: Omit<FlightForm, 'id'>[], focusField?: string) {
  const p = period();
  const added = items.map((x) => ({ ...x, id: newId() }));
  p.flights.push(...added);
  commitFlights(root, true);
  if (focusField && added.length === 1)
    $<HTMLInputElement>(`.flight[data-id="${added[0].id}"] [data-f="${focusField}"]`, root)?.focus();
}

function bindFlights(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('[data-go=calc]').forEach((b) => b.addEventListener('click', () => go('calc')));
  root.querySelectorAll<HTMLButtonElement>('[data-fmonth]').forEach((b) =>
    b.addEventListener('click', () => {
      state.month = shiftMonth(state.month, Number(b.dataset.fmonth));
      draft = null;
      draftHint = '';
      if (state.payslip?.parsed.month !== state.month) state.payslip = null;
      persist();
      renderFlights(root);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-fperiod]').forEach((b) =>
    b.addEventListener('click', () => {
      state.active = Number(b.dataset.fperiod);
      persist();
      renderFlights(root);
    }),
  );

  bindNewFlight(root);

  const list = $('#flight-list', root);
  const findFlight = (el: Element) => {
    const id = el.closest<HTMLElement>('.flight')?.dataset.id;
    return period().flights.find((f) => f.id === id);
  };

  list?.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const f = findFlight(el);
    const field = el.dataset.f as keyof FlightForm | undefined;
    if (!f || !field || field === 'id' || field === 'dh') return;
    f[field] = el.value;
    commitFlights(root, false);
  });
  list?.addEventListener('focusin', () => document.body.classList.add('typing'));
  list?.addEventListener(
    'blur',
    (e) => {
      document.body.classList.remove('typing');
      const el = e.target as HTMLInputElement;
      const f = findFlight(el);
      if (!f) return;
      const field = el.dataset.f;
      if (field === 'block' || field === 'night' || field === 'duty') {
        const v = autoColon(el.value);
        if (v !== el.value) {
          el.value = v;
          f[field] = v;
          commitFlights(root, false);
        }
      } else if (field === 'route') {
        const r = normalizeRoute(el.value);
        el.value = r;
        f.route = r;
        // Знакомый маршрут — время из прошлого рейса.
        const known = routeMemory().get(r);
        if (known && known.id !== f.id && !f.block && !f.night && !f.duty) {
          Object.assign(f, { block: known.block, night: known.night, duty: known.duty });
          // Обновляем поля строки на месте — фокус пользователя не теряется.
          const li = el.closest('.flight');
          for (const k of ['block', 'night', 'duty'] as const) {
            const inp = li?.querySelector<HTMLInputElement>(`[data-f="${k}"]`);
            if (inp && document.activeElement !== inp) inp.value = f[k];
          }
          toast(`Время ${r} подставлено из прошлого рейса`);
        }
        commitFlights(root, false);
      } else if (field === 'date') {
        // Отметка «праздник» по новой дате — без перерисовки списка (порядок обновится при следующем открытии).
        const li = el.closest<HTMLElement>('.flight');
        const holiday = !f.dh && isPublicHoliday(reg, f.date);
        li?.classList.toggle('is-holiday', holiday);
        const foot = li?.querySelector('.fl-foot');
        const tag = foot?.querySelector('.tag.holiday');
        if (holiday && !tag) foot?.insertAdjacentHTML('afterbegin', `<span class="tag holiday">${icon('star')}праздник — двойная оплата</span>`);
        if (!holiday) tag?.remove();
        commitFlights(root, false);
      }
    },
    true,
  );

  list?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!btn) return;
    const f = findFlight(btn);
    if (!f) return;
    const p = period();
    if (btn.dataset.act === 'dh') {
      f.dh = !f.dh;
      commitFlights(root, true);
    } else if (btn.dataset.act === 'delete') {
      if ((f.route || f.block) && !(await ask(`Удалить рейс ${f.route || ''}?`, 'Удалить', true))) return;
      p.flights = p.flights.filter((x) => x.id !== f.id);
      if (!p.flights.length) syncFlightsToPeriod(p);
      commitFlights(root, true);
    } else if (btn.dataset.act === 'reverse') {
      const r = reverseRoute(f.route);
      const known = validRoute(r) ? routeMemory().get(r) : undefined;
      addFlights(
        root,
        [{ date: f.date, route: r, block: known?.block ?? '', night: known?.night ?? '', duty: known?.duty ?? '', dh: f.dh }],
        known ? undefined : 'block',
      );
    }
  });

  root.querySelectorAll<HTMLButtonElement>('.form-actions [data-act=add]').forEach((b) =>
    b.addEventListener('click', () =>
      addFlights(root, [{ date: defaultFlightDate(period()), route: '', block: '', night: '', duty: '', dh: false }], 'route'),
    ),
  );
  $('.form-actions [data-act=clear]', root)?.addEventListener('click', async () => {
    if (!(await ask(`Удалить все рейсы ${monthFor(state.month)}?`, 'Удалить', true))) return;
    const p = period();
    p.flights = [];
    syncFlightsToPeriod(p);
    commitFlights(root, true);
  });
}

// ---------- history ----------

async function loadSlips(root: HTMLElement) {
  const box = $('#slips', root);
  if (!box) return;
  try {
    const { payslips } = await api.payslips();
    if (!box.isConnected) return;
    box.innerHTML = `
      <div class="card-head">${icon('receipt')}<h2>Расчётные листки</h2><span class="muted small head-note">${payslips.length}</span></div>
      ${
        payslips.length
          ? `<ul class="slips">${payslips
              .map(
                (p) => `
            <li>
              <div class="slip-main">
                <b>${esc(p.month ? monthLabel(p.month) : 'Без месяца')}</b>
                <span class="muted small">${esc(p.filename)} · загружен ${esc(new Date(p.createdAt).toLocaleDateString('ru-RU'))}${p.parsed.net !== null ? ` · к выплате ${money(p.parsed.net)}` : ''}</span>
              </div>
              <div class="slip-actions">
                <a class="btn small" href="${api.payslipUrl(p.id)}" target="_blank" rel="noopener">${icon('arrowUpRight')}PDF</a>
                <button class="btn small ghost danger" data-slip-del="${p.id}" aria-label="Удалить листок">${icon('trash')}</button>
              </div>
            </li>`,
              )
              .join('')}</ul>`
          : '<p class="muted small">Загрузите листок на экране «Расчёт» — он появится здесь.</p>'
      }`;
    box.querySelectorAll<HTMLButtonElement>('[data-slip-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await ask('Удалить расчётный листок? Расчёт месяца останется.', 'Удалить', true))) return;
        try {
          await api.deletePayslip(b.dataset.slipDel!);
          if (state.payslip?.id === b.dataset.slipDel) {
            state.payslip = null;
            persist();
          }
          history.forEach((h) => {
            if (h.payslipId === b.dataset.slipDel) h.payslipId = null;
          });
          saveHistory(history);
          renderHistory(root);
        } catch (e) {
          toast(e instanceof ApiError ? e.message : 'Не удалось удалить');
        }
      }),
    );
  } catch {
    box.innerHTML = `<p class="muted small">Не удалось загрузить список листков.</p>`;
  }
}

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
                ${
                  h.payslipId && account
                    ? `<a class="chip slip-chip" href="${api.payslipUrl(h.payslipId)}" target="_blank" rel="noopener">${icon('receipt')}Расчётный листок</a>`
                    : ''
                }
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
          : `<div class="empty card">${icon('history', 'icon empty-icon')}<p>Пока пусто. Посчитайте месяц или загрузите расчётный листок — и нажмите «Сохранить».</p><button class="btn primary" data-go="calc">${icon('calc')}К расчёту</button></div>`
      }
      ${account ? `<div class="card" id="slips"><div class="card-head">${icon('receipt')}<h2>Расчётные листки</h2></div><div class="skeleton"><i></i><i></i><i></i></div></div>` : ''}
    </section>`;
  if (account) loadSlips(root);

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
      if (account) {
        try {
          await api.deleteMonth(h.month);
        } catch (e) {
          return toast(e instanceof ApiError ? e.message : 'Не удалось удалить');
        }
      }
      history.splice(Number(b.dataset.del), 1);
      saveHistory(history);
      renderHistory(root);
    }),
  );
  $('[data-go=calc]', root)?.addEventListener('click', () => go('calc'));
}

// ---------- profile ----------

// ---------- подписка ----------

const PRO_FEATURES: [string, string, string][] = [
  ['plane', 'Журнал рейсов', 'каждый рейс отдельно — налёт, ночные, праздничные часы и Dead Head считаются сами до минуты'],
  ['receipt', 'Расчётные листки', 'загрузите PDF — месяц, часы и суммы заполнятся сами, каждая строка будет сверена'],
  ['download', 'PDF-отчёт', 'оформленный расчёт с формулами и сверкой — сохранить или отправить'],
];
const FREE_FEATURES = ['Калькулятор налёта и зарплаты', 'История месяцев в облаке', 'Справочник ставок'];

const proTag = () => `<span class="pro-tag">${icon('crown')}Pro</span>`;

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5));

function planLabel(): string {
  if (!account) return 'Войдите';
  if (plan?.admin) return 'Pro · администратор';
  if (plan?.pro && plan.until) {
    const d = daysLeft(plan.until);
    return plan.source === 'trial' ? `Пробный · ${d} ${plural(d, 'день', 'дня', 'дней')}` : `Pro до ${fmtDay(plan.until)}`;
  }
  return 'Бесплатный';
}

function proGate(title: string, text: string): string {
  const days = planInfo?.trialDays ?? 0;
  const cta = !account
    ? `<button class="btn primary" data-pro-register>${icon('sparkle')}${
        days ? `Попробовать ${days} ${plural(days, 'день', 'дня', 'дней')} бесплатно` : 'Зарегистрироваться'
      }</button>
       <button class="btn ghost" data-pro-login>${icon('user')}Войти</button>`
    : `<button class="btn primary" data-pro>${icon('crown')}Оформить Pro</button>`;
  return `
    <div class="card pro-gate">
      <span class="pro-tag big">${icon('crown')}CrewPay Pro</span>
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(text)}</p>
      <ul class="pro-features">
        ${PRO_FEATURES.map(([ic, t, d]) => `<li>${icon(ic)}<span><b>${t}</b> — ${d}</span></li>`).join('')}
      </ul>
      <div class="row-actions">${cta}</div>
    </div>`;
}

/** Сервер ответил «нужен Pro» (подписка закончилась, пока страница была открыта). */
function proExpired(e: unknown): boolean {
  if (!(e instanceof ApiError && e.status === 402)) return false;
  if (plan) plan = { ...plan, pro: false };
  toast('Подписка закончилась — продлите Pro');
  go('pro');
  return true;
}

// Проверка «не робот»: начинается, как только открыта форма регистрации.
let powJob: { promise: Promise<PowSolution>; ctrl: AbortController; issuedAt: number; state: 'work' | 'done' | 'error' } | null = null;

function powStatusHtml(): string {
  const st = powJob?.state ?? 'work';
  if (st === 'done') return `${icon('shield')}<span>Проверка «не робот» пройдена</span>`;
  if (st === 'error') return `${icon('alert')}<span>Проверка не удалась — обновите страницу</span>`;
  return `${icon('refresh', 'icon spin')}<span>Проверяем, что вы не робот…</span>`;
}

function updatePowStatus() {
  const el = $('#pow-status');
  if (el) {
    el.innerHTML = powStatusHtml();
    el.dataset.state = powJob?.state ?? 'work';
  }
}

function startPow() {
  if (powJob && powJob.state !== 'error') return powJob;
  const ctrl = new AbortController();
  const job = { ctrl, issuedAt: Date.now(), state: 'work' as 'work' | 'done' | 'error', promise: null as unknown as Promise<PowSolution> };
  job.promise = api.challenge().then((c: PowChallenge) => {
    job.issuedAt = Date.now();
    return solvePow(c, ctrl.signal);
  });
  job.promise.then(
    () => {
      job.state = 'done';
      if (powJob === job) updatePowStatus();
    },
    () => {
      job.state = 'error';
      if (powJob === job) updatePowStatus();
    },
  );
  powJob = job;
  updatePowStatus();
  return job;
}

function resetPow() {
  powJob?.ctrl.abort();
  powJob = null;
}

/** Сервер не принимает форму быстрее 3 секунд после выдачи задачи — человек так не успевает, менеджер паролей может. */
const MIN_FORM_MS = 3300;

async function registerWithPow(body: { email: string; password: string; name: string; website: string; accept: boolean }, retry = true): Promise<void> {
  const job = startPow();
  const captcha = await job.promise;
  const wait = job.issuedAt + MIN_FORM_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  powJob = null; // решение одноразовое
  try {
    await api.register({ ...body, captcha });
  } catch (e) {
    // Задача устарела (вкладка была открыта долго) — одна попытка с новой.
    if (retry && e instanceof ApiError && e.code === 'captcha' && !body.website) return registerWithPow(body, false);
    throw e;
  }
}

let adminQuery = '';

/** Возврат со страницы оплаты: ?paid=<номер заказа>. Ждём подтверждения от платёжной системы. */
let payWait: { id: number; order: PayOrder | null; timedOut: boolean } | null = null;

const PROVIDER_LABEL: Record<PayProvider, string> = { payme: 'Payme', click: 'Click' };

async function watchPayment(id: number) {
  payWait = { id, order: null, timedOut: false };
  const started = Date.now();
  while (payWait?.id === id) {
    try {
      const r = await api.order(id);
      payWait.order = r.order;
      if (r.order.status === 'paid') {
        await loadAccount();
        toast('Оплата прошла — Pro активен');
        if (view === 'pro') renderPro($('#view')!);
        return;
      }
      if (r.order.status === 'cancelled') break;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 401)) {
        payWait = null;
        break;
      }
    }
    if (Date.now() - started > 5 * 60_000) {
      payWait.timedOut = true;
      break;
    }
    if (view === 'pro') renderPro($('#view')!);
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (view === 'pro') renderPro($('#view')!);
}

function payWaitHtml(): string {
  if (!payWait) return '';
  const o = payWait.order;
  if (o?.status === 'paid')
    return `<div class="card pay-status ok">${icon('check')}<div><b>Оплата получена</b><span class="muted small">Заказ №${o.id} · Pro на ${o.months} ${plural(o.months, 'месяц', 'месяца', 'месяцев')} · ${PROVIDER_LABEL[o.provider]}</span></div></div>`;
  if (o?.status === 'cancelled')
    return `<div class="card pay-status bad">${icon('alert')}<div><b>Оплата не прошла</b><span class="muted small">Заказ №${o.id} отменён — деньги не списаны. Можно попробовать ещё раз.</span></div></div>`;
  if (payWait.timedOut)
    return `<div class="card pay-status">${icon('clock')}<div><b>Ждём подтверждения</b><span class="muted small">Заказ №${payWait.id}. Если деньги списались, Pro включится автоматически — обновите страницу через пару минут.</span></div></div>`;
  return `<div class="card pay-status">${icon('refresh', 'icon spin')}<div><b>Проверяем оплату…</b><span class="muted small">Заказ №${payWait.id} — обычно это несколько секунд.</span></div></div>`;
}

function renderPro(root: HTMLElement) {
  if (serverUp && !planInfo)
    api
      .planInfo()
      .then((i) => {
        planInfo = i;
        if (view === 'pro') renderPro($('#view')!);
      })
      .catch(() => {});
  const info = planInfo ?? { price: 0, trialDays: 0, terms: [1, 3, 6, 12], contactUrl: '' };
  const price = (m: number) => (info.price ? `${num(info.price * m)} сум` : '');

  let status: string;
  if (!serverUp) status = `<p class="muted">Подписка оформляется на сайте, когда есть интернет.</p>`;
  else if (!account)
    status = `<p class="muted">Войдите или зарегистрируйтесь${
      info.trialDays ? ` — первые ${info.trialDays} ${plural(info.trialDays, 'день', 'дня', 'дней')} Pro бесплатно` : ''
    }.</p>
      <div class="row-actions">
        <button class="btn primary" data-pro-register>${icon('sparkle')}Регистрация</button>
        <button class="btn ghost" data-pro-login>${icon('user')}Войти</button>
      </div>`;
  else if (plan?.admin) status = `<p class="plan-now ok">${icon('shield')}Администратор · Pro без ограничений</p>`;
  else if (plan?.pro && plan.until)
    status = `<p class="plan-now ok">${icon('check')}${
      plan.source === 'trial'
        ? `Пробный период · осталось ${daysLeft(plan.until)} ${plural(daysLeft(plan.until), 'день', 'дня', 'дней')}`
        : 'Pro активен'
    } <span class="muted">до ${fmtDay(plan.until)}</span></p>`;
  else
    status = `<p class="plan-now">${icon('info')}Бесплатный план${
      plan?.until ? ` <span class="muted">Pro закончился ${fmtDay(plan.until)}</span>` : ''
    }</p>`;

  const terms = info.terms.length ? info.terms : [1, 3, 6, 12];
  const providers = info.providers ?? [];
  const requestCard =
    account && !plan?.admin && providers.length && !proRequest
      ? `
      <form class="card" id="pay-form">
        <div class="card-head">${icon('crown')}<h2>${plan?.pro ? 'Продлить Pro' : 'Оформить Pro'}</h2></div>
        <div class="terms" role="radiogroup" aria-label="Срок">
          ${terms
            .map(
              (m, i) => `
            <label class="term">
              <input type="radio" name="months" value="${m}" ${i === 0 ? 'checked' : ''} />
              <span class="term-box"><b>${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}</b><span>${price(m)}</span></span>
            </label>`,
            )
            .join('')}
        </div>
        <div class="pay-buttons">
          ${providers
            .map((pv) => `<button class="btn pay-btn pay-${pv}" type="submit" data-provider="${pv}">${icon('wallet')}Оплатить через ${PROVIDER_LABEL[pv]}</button>`)
            .join('')}
        </div>
        <p class="field-hint">Откроется страница ${providers.map((pv) => PROVIDER_LABEL[pv]).join(' или ')}. После оплаты Pro включится сам${
          plan?.pro ? ' и продлится от текущей даты окончания' : ''
        }.</p>
      </form>`
      : account && !plan?.admin
      ? proRequest
        ? `
      <div class="card">
        <div class="card-head">${icon('clock')}<h2>Заявка отправлена</h2></div>
        <p>Pro на ${proRequest.months} ${plural(proRequest.months, 'месяц', 'месяца', 'месяцев')}${
          info.price ? ` · <b>${price(proRequest.months)}</b>` : ''
        } · ${fmtDay(proRequest.createdAt)}</p>
        <p class="muted small">Мы свяжемся с вами для оплаты${
          info.contactUrl ? ' или напишите сами' : ''
        }. После оплаты Pro включится в аккаунте — обновите страницу.</p>
        <div class="row-actions">
          ${info.contactUrl ? `<a class="btn primary" href="${esc(info.contactUrl)}" target="_blank" rel="noopener">${icon('arrowUpRight')}Написать об оплате</a>` : ''}
          <button class="btn ghost danger" data-action="cancel-request">${icon('x')}Отменить заявку</button>
        </div>
      </div>`
        : `
      <form class="card" id="pro-form">
        <div class="card-head">${icon('crown')}<h2>${plan?.pro ? 'Продлить Pro' : 'Оформить Pro'}</h2></div>
        <div class="terms" role="radiogroup" aria-label="Срок">
          ${terms
            .map(
              (m, i) => `
            <label class="term">
              <input type="radio" name="months" value="${m}" ${i === 0 ? 'checked' : ''} />
              <span class="term-box"><b>${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}</b>${info.price ? `<span>${price(m)}</span>` : ''}</span>
            </label>`,
            )
            .join('')}
        </div>
        <div class="field">
          <label class="field-label" for="pro-note">${icon('info')}<span>Как с вами связаться</span></label>
          <input id="pro-note" name="note" type="text" maxlength="300" placeholder="Telegram или телефон" autocomplete="tel" />
          <span class="field-hint">Пришлём реквизиты для оплаты. После оплаты Pro включится в аккаунте.</span>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">${icon('crown')}Отправить заявку</button></div>
      </form>`
      : '';

  const adminCard = plan?.admin
    ? `
      <div class="card" id="admin-card">
        <div class="card-head">${icon('shield')}<h2>Пользователи и доступ</h2></div>
        <form class="admin-grant" id="grant-form">
          <input name="email" type="email" required placeholder="email пользователя" aria-label="Email" />
          <select name="months" aria-label="Срок">
            ${[1, 3, 6, 12].map((m) => `<option value="${m}">+${m} мес.</option>`).join('')}
            <option value="0">Отключить Pro</option>
          </select>
          <button class="btn primary" type="submit">Применить</button>
        </form>
        <div id="admin-body"><div class="skeleton"><i></i><i></i><i></i></div></div>
      </div>`
    : '';

  root.innerHTML = `
    <section class="page pro-page">
      <div class="page-head">
        <h1>Подписка</h1>
        ${status}
      </div>
      ${payWaitHtml()}
      <div class="plans">
        <div class="card plan-card">
          <h2>Бесплатно</h2>
          <ul class="plan-list">${FREE_FEATURES.map((f) => `<li>${icon('check')}${f}</li>`).join('')}</ul>
        </div>
        <div class="card plan-card pro">
          <h2>${icon('crown')}Pro${info.price ? ` <span class="plan-price">${num(info.price)} сум<span>/мес</span></span>` : ''}</h2>
          <ul class="plan-list">
            <li>${icon('check')}Всё бесплатное</li>
            ${PRO_FEATURES.map(([ic, t, d]) => `<li>${icon(ic)}<span><b>${t}</b> — ${d}</span></li>`).join('')}
          </ul>
        </div>
      </div>
      ${requestCard}
      ${adminCard}
    </section>`;

  $<HTMLFormElement>('#pay-form', root)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const btn = (e.submitter as HTMLButtonElement | null) ?? $<HTMLButtonElement>('[data-provider]', form)!;
    const provider = btn.dataset.provider as PayProvider;
    const months = Number(new FormData(form).get('months'));
    form.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const label = btn.innerHTML;
    btn.innerHTML = `${icon('refresh', 'icon spin')}Открываю ${PROVIDER_LABEL[provider]}…`;
    try {
      const { url } = await api.checkout(provider, months);
      window.location.href = url;
    } catch (ex) {
      form.querySelectorAll('button').forEach((b) => (b.disabled = false));
      btn.innerHTML = label;
      toast(ex instanceof ApiError ? ex.message : 'Сервер недоступен');
    }
  });
  $<HTMLFormElement>('#pro-form', root)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const btn = $<HTMLButtonElement>('#pro-form [type=submit]', root)!;
    btn.disabled = true;
    try {
      proRequest = (await api.requestPro(Number(fd.get('months')), String(fd.get('note') ?? '').trim())).request;
      toast('Заявка отправлена');
      renderPro(root);
    } catch (ex) {
      btn.disabled = false;
      toast(ex instanceof ApiError ? ex.message : 'Сервер недоступен');
    }
  });
  $('[data-action=cancel-request]', root)?.addEventListener('click', async () => {
    if (!(await ask('Отменить заявку на Pro?', 'Отменить заявку', true))) return;
    try {
      await api.cancelProRequest();
      proRequest = null;
      renderPro(root);
    } catch (ex) {
      toast(ex instanceof ApiError ? ex.message : 'Сервер недоступен');
    }
  });
  if (plan?.admin) bindAdmin(root);
}

function bindAdmin(root: HTMLElement) {
  const body = $('#admin-body', root)!;
  const grant = async (email: string, months: number) => {
    try {
      const r = await api.adminGrant(email, months);
      toast(months ? `${r.email}: Pro до ${fmtDay(r.plan.until!)}` : `${r.email}: Pro отключён`);
      if (account && r.email === account.email) await loadAccount();
      load();
    } catch (ex) {
      toast(ex instanceof ApiError ? ex.message : 'Сервер недоступен');
    }
  };
  const setAccess = async (email: string, status: 'active' | 'blocked') => {
    if (status === 'blocked' && !(await ask(`Закрыть доступ для ${email}? Пользователь выйдет на всех устройствах.`, 'Закрыть доступ', true))) return;
    try {
      const r = await api.adminAccess(email, status);
      toast(
        r.access === 'active'
          ? `${r.email}: доступ открыт${r.plan.pro && r.plan.source === 'trial' ? ', пробный Pro включён' : ''}`
          : `${r.email}: доступ закрыт`,
      );
      load();
    } catch (ex) {
      toast(ex instanceof ApiError ? ex.message : 'Сервер недоступен');
    }
  };
  const load = async () => {
    try {
      const { requests, pending, users } = await api.adminSubscriptions(adminQuery);
      body.innerHTML = `
        <h3 class="admin-h">Ждут доступа${pending.length ? ` · ${pending.length}` : ''}</h3>
        ${
          pending.length
            ? `<ul class="admin-list">${pending
                .map(
                  (u) => `
              <li class="pending">
                <div><b>${esc(u.email)}</b>${u.name ? ` · ${esc(u.name)}` : ''}<br />
                  <span class="muted small">заявка от ${fmtDay(u.createdAt)}</span></div>
                <div class="admin-actions">
                  <button class="btn small primary" data-access="${esc(u.email)}" data-status="active">Открыть доступ</button>
                  <button class="btn small ghost" data-access="${esc(u.email)}" data-status="blocked">Отклонить</button>
                </div>
              </li>`,
                )
                .join('')}</ul>`
            : '<p class="muted small">Новых регистраций нет.</p>'
        }
        <h3 class="admin-h">Заявки на Pro${requests.length ? ` · ${requests.length}` : ''}</h3>
        ${
          requests.length
            ? `<ul class="admin-list">${requests
                .map(
                  (r) => `
              <li>
                <div><b>${esc(r.email)}</b>${r.name ? ` · ${esc(r.name)}` : ''}<br />
                  <span class="muted small">${r.months} мес. · ${fmtDay(r.createdAt)}${r.note ? ` · ${esc(r.note)}` : ''}</span></div>
                <div class="admin-actions">
                  <button class="btn small primary" data-grant="${esc(r.email)}" data-months="${r.months}">Выдать ${r.months} мес.</button>
                  <button class="btn small ghost" data-reject="${r.id}">Отклонить</button>
                </div>
              </li>`,
                )
                .join('')}</ul>`
            : '<p class="muted small">Новых заявок нет.</p>'
        }
        <h3 class="admin-h">Пользователи</h3>
        <input class="admin-search" id="admin-q" type="search" placeholder="Поиск по email или имени" value="${esc(adminQuery)}" />
        <ul class="admin-list">${users
          .map(
            (u) => `
          <li>
            <div><b>${esc(u.email)}</b>${u.name ? ` · ${esc(u.name)}` : ''}<br />
              <span class="muted small">${
                u.plan.admin
                  ? 'администратор'
                  : u.access === 'pending'
                    ? 'ждёт доступа'
                    : u.access === 'blocked'
                      ? 'доступ закрыт'
                      : u.plan.pro && u.plan.until
                        ? `${u.plan.source === 'trial' ? 'пробный Pro' : 'Pro'} до ${fmtDay(u.plan.until)}`
                        : 'доступ открыт · без Pro'
              } · с ${fmtDay(u.createdAt)}</span></div>
            ${
              u.plan.admin
                ? ''
                : `<div class="admin-actions">
                    <button class="btn small ghost" data-reset="${esc(u.email)}" title="Сбросить пароль">${icon('key')}<span class="hide-sm">Пароль</span></button>${
                    u.access === 'active'
                      ? `<button class="btn small ghost danger" data-access="${esc(u.email)}" data-status="blocked">Закрыть доступ</button>`
                      : `<button class="btn small" data-access="${esc(u.email)}" data-status="active">Открыть доступ</button>`
                  }</div>`
            }
          </li>`,
          )
          .join('')}</ul>`;
      body.querySelectorAll<HTMLButtonElement>('[data-grant]').forEach((b) =>
        b.addEventListener('click', () => grant(b.dataset.grant!, Number(b.dataset.months))),
      );
      body.querySelectorAll<HTMLButtonElement>('[data-reset]').forEach((b) =>
        b.addEventListener('click', async () => {
          const email = b.dataset.reset!;
          if (!(await ask(`Сбросить пароль для ${email}? Старый перестанет работать, пользователь выйдет на всех устройствах.`, 'Сбросить', true))) return;
          try {
            const r = await api.adminResetPassword(email);
            showTempPassword(r.email, r.password);
          } catch (ex) {
            toast(ex instanceof ApiError ? ex.message : 'Сервер недоступен');
          }
        }),
      );
      body.querySelectorAll<HTMLButtonElement>('[data-access]').forEach((b) =>
        b.addEventListener('click', () => setAccess(b.dataset.access!, b.dataset.status as 'active' | 'blocked')),
      );
      body.querySelectorAll<HTMLButtonElement>('[data-reject]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api.adminReject(b.dataset.reject!).catch(() => toast('Сервер недоступен'));
          load();
        }),
      );
      let t = 0;
      $<HTMLInputElement>('#admin-q', body)!.addEventListener('input', (e) => {
        adminQuery = (e.target as HTMLInputElement).value;
        clearTimeout(t);
        t = window.setTimeout(async () => {
          await load();
          const q = $<HTMLInputElement>('#admin-q', body);
          q?.focus();
          q?.setSelectionRange(q.value.length, q.value.length);
        }, 350);
      });
    } catch (ex) {
      body.innerHTML = `<p class="form-error">${esc(ex instanceof ApiError ? ex.message : 'Сервер недоступен')}</p>`;
    }
  };
  $<HTMLFormElement>('#grant-form', root)!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const months = Number(fd.get('months'));
    const email = String(fd.get('email') ?? '').trim();
    if (!months && !(await ask(`Отключить Pro у ${email}?`, 'Отключить', true))) return;
    await grant(email, months);
  });
  load();
}

// ---------- доступ ----------

/** Всё, кроме страницы условий, закрыто до решения администратора. */
function renderGate(root: HTMLElement) {
  let body: string;
  if (access === 'pending')
    body = `
      <div class="card gate-card">
        <div class="gate-icon">${icon('clock')}</div>
        <h2>Заявка отправлена</h2>
        <p class="muted">Вы зарегистрированы как <b>${esc(account?.email ?? '')}</b>. Администратор проверит заявку и откроет доступ — обычно в течение дня.</p>
        <div class="row-actions">
          <button class="btn primary" data-gate="refresh">${icon('refresh')}Проверить доступ</button>
          <button class="btn ghost" data-gate="logout">${icon('logout')}Выйти</button>
        </div>
      </div>`;
  else if (access === 'blocked')
    body = `
      <div class="card gate-card">
        <div class="gate-icon danger">${icon('lock')}</div>
        <h2>Доступ закрыт</h2>
        <p class="muted">Администратор закрыл доступ для <b>${esc(account?.email ?? '')}</b>. Если это ошибка — напишите по контактам на странице условий.</p>
        <div class="row-actions">
          <button class="btn" data-view="legal">${icon('info')}Контакты</button>
          <button class="btn ghost" data-gate="logout">${icon('logout')}Выйти</button>
        </div>
      </div>`;
  else if (access === 'offline')
    body = `
      <div class="card gate-card">
        <div class="gate-icon">${icon('alert')}</div>
        <h2>Нет связи с сервером</h2>
        <p class="muted">Проверьте интернет и попробуйте ещё раз. Без связи приложение работает, только если доступ уже был открыт на этом устройстве.</p>
        <div class="row-actions"><button class="btn primary" data-gate="reload">${icon('refresh')}Повторить</button></div>
      </div>`;
  else body = authCardHtml();

  root.innerHTML = `
    <section class="page gate">
      <div class="gate-hero">
        ${logoMark(56)}
        <h1>Расчёт налёта и&nbsp;оплаты для экипажа</h1>
        <p class="muted">Закрытый сервис для личных справочных расчётов. Доступ открывает администратор после регистрации.</p>
      </div>
      ${body}
      <p class="gate-legal small muted">Расчёты носят справочный характер и не являются официальным документом.
        <button class="link" data-view="legal">Условия и контакты</button></p>
    </section>`;

  if (access === 'guest') bindAuth(root);
  $('[data-gate=refresh]', root)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    await loadAccount();
    if (access === 'active') toast('Доступ открыт');
    else toast('Пока ждём решения администратора');
    renderShell();
  });
  $('[data-gate=reload]', root)?.addEventListener('click', () => location.reload());
  $('[data-gate=logout]', root)?.addEventListener('click', async () => {
    try {
      await api.logout();
    } catch {
      /* всё равно выходим */
    }
    account = null;
    plan = null;
    proRequest = null;
    access = 'guest';
    authMode = 'login';
    rememberPlan();
    forgetAccess();
    renderShell();
  });
}

// ---------- условия и контакты ----------

const LEGAL_DATE = '5 октября 2026 г.';

function renderLegal(root: HTMLElement) {
  const l = planInfo?.legal ?? {};
  const price = planInfo?.price ? `${num(planInfo.price)} сум в месяц` : 'указана на странице «Подписка»';
  const tg = (l.telegram ?? '').replace(/^@/, '');
  const contacts = [
    l.email ? `<li>${icon('info')}<span>Email: <a href="mailto:${esc(l.email)}">${esc(l.email)}</a></span></li>` : '',
    tg ? `<li>${icon('arrowUpRight')}<span>Telegram: <a href="https://t.me/${esc(tg)}" target="_blank" rel="noopener">@${esc(tg)}</a></span></li>` : '',
    l.phone ? `<li>${icon('user')}<span>Телефон: <a href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">${esc(l.phone)}</a></span></li>` : '',
    `<li>${icon('arrowUpRight')}<span>Сайт разработчика: <a href="${CREDIT_URL}" target="_blank" rel="noopener">boldstudio.uz</a></span></li>`,
  ].join('');
  const sec = (n: number, title: string, body: string) => `<section class="legal-sec"><h2><span>${n}</span>${title}</h2>${body}</section>`;

  root.innerHTML = `
    <article class="page legal">
      <div class="page-head">
        <h1>Условия использования и контакты</h1>
        <p class="muted">Публичная оферта и политика обработки данных сервиса CrewPay (crewpay.uz). Редакция от ${LEGAL_DATE}</p>
      </div>

      <div class="card legal-key">
        ${icon('shield')}
        <p><b>Главное.</b> CrewPay — независимый вспомогательный калькулятор для личных справочных расчётов. Он не является официальным
        ресурсом какой-либо авиакомпании или работодателя, не связан с ними и не действует от их имени. Все расчёты ориентировочные
        и <b>не являются официальным документом</b>: размер оплаты определяет только работодатель.</p>
      </div>

      <div class="card legal-body">
        ${sec(1, 'Термины', `
          <p><b>Сервис</b> — сайт crewpay.uz и его функции. <b>Администратор</b> — лицо, которое управляет Сервисом (сведения — в разделе «Контакты и реквизиты»).
          <b>Пользователь</b> — лицо, зарегистрировавшееся в Сервисе. <b>Pro</b> — платный набор функций.</p>`)}
        ${sec(2, 'Справочный характер расчётов', `
          <p>Сервис помогает пользователю самостоятельно оценить налёт часов и ориентировочную оплату труда по данным, которые пользователь вводит сам.
          Результаты носят исключительно информационный характер и не являются расчётным листком, бухгалтерским, кадровым, налоговым
          или иным официальным документом, а также не могут служить основанием для требований к работодателю или третьим лицам.</p>
          <p>Справочные значения (ставки, коэффициенты, нормы) могут быть неполными, устаревшими или отличаться от действующих у конкретного
          работодателя. Пользователь самостоятельно проверяет их и результаты расчётов. Официальными являются только документы работодателя.</p>`)}
        ${sec(3, 'Регистрация и доступ', `
          <p>Регистрация не гарантирует доступ. Администратор по своему усмотрению открывает, ограничивает или закрывает доступ к Сервису
          и отдельным функциям, в том числе без объяснения причин. Сервис предназначен для личного использования; аккаунт нельзя передавать
          другим лицам. Пользователь не распространяет сведения, полученные в Сервисе, и сам отвечает за соблюдение своих обязательств
          перед работодателем, включая обязательства о конфиденциальности.</p>`)}
        ${sec(4, 'Документы пользователя', `
          <p>Пользователь загружает только собственные документы (например, свой расчётный листок) и подтверждает, что вправе это делать.
          Сервис использует загруженные файлы только для расчётов и сверки по просьбе самого пользователя и не передаёт их третьим лицам.
          Пользователь может удалить загруженный листок в любой момент.</p>`)}
        ${sec(5, 'Ограничение ответственности', `
          <p>Сервис предоставляется «как есть». Администратор не гарантирует точность, полноту и актуальность расчётов, бесперебойную работу
          Сервиса и сохранность данных и не несёт ответственности за решения, принятые пользователем на основе расчётов, за расхождения
          с начислениями работодателя, за прямые или косвенные убытки и упущенную выгоду, а также за содержание документов и сведений,
          которые вводит или загружает пользователь.</p>
          <p>Если ответственность Администратора не может быть исключена по закону, она ограничена суммой, уплаченной пользователем
          за текущий оплаченный период Pro.</p>`)}
        ${sec(6, 'Персональные данные', `
          <p>Сервис обрабатывает: email, имя, пароль (только в виде необратимого хеша), введённые данные расчётов и загруженные пользователем
          документы, которые могут содержать ФИО, табельный номер и суммы начислений. Цель обработки — работа Сервиса для самого пользователя.</p>
          <p>Данные не продаются и не передаются третьим лицам, кроме случаев, предусмотренных законом. При оплате платёжной системе
          (Payme, Click) передаются только номер заказа и сумма; данные карты вводятся на стороне платёжной системы и Сервису недоступны.</p>
          <p>Данные хранятся, пока существует аккаунт. Удалить аккаунт и все данные можно по запросу на контакты ниже.
          Регистрируясь, пользователь даёт согласие на обработку своих персональных данных на этих условиях в соответствии
          с Законом Республики Узбекистан «О персональных данных».</p>`)}
        ${sec(7, 'Подписка Pro (публичная оферта)', `
          <p>Настоящий раздел — публичная оферта. Оплата Pro означает полное принятие этих условий. Стоимость — ${price};
          доступны сроки 1, 3, 6 и 12 месяцев. Pro включается автоматически после подтверждения оплаты платёжной системой
          и действует до даты, указанной на странице «Подписка»; при продлении срок добавляется к текущему.</p>
          <p>Возврат: если функции Pro были недоступны по вине Сервиса, либо в течение 3 дней с оплаты при неиспользовании Pro — по обращению
          на контакты ниже. Если Администратор закрыл доступ без нарушения пользователем этих условий, возвращается стоимость неиспользованных
          полных месяцев.</p>`)}
        ${sec(8, 'Изменение условий', `
          <p>Администратор может изменять эти условия, публикуя новую редакцию на этой странице. Продолжение использования Сервиса
          после публикации означает согласие с новой редакцией.</p>`)}
        ${sec(9, 'Применимое право', `
          <p>К отношениям сторон применяется законодательство Республики Узбекистан. Споры решаются переговорами, а при недостижении
          согласия — в суде по месту нахождения Администратора.</p>`)}
        ${sec(10, 'Товарные знаки', `
          <p>Названия компаний, документов и платёжных систем упоминаются только для описания и принадлежат их правообладателям.
          Их упоминание не означает связи с ними или их одобрения.</p>`)}
      </div>

      <div class="card" id="contacts">
        <div class="card-head">${icon('info')}<h2>Контакты и реквизиты</h2></div>
        ${
          l.operator
            ? `<p><b>${esc(l.operator)}</b>${l.inn ? ` · ИНН ${esc(l.inn)}` : ''}</p>`
            : '<p class="muted small">Реквизиты исполнителя будут опубликованы до начала приёма платежей.</p>'
        }
        <ul class="legal-contacts">${contacts}</ul>
      </div>

      <button class="card to-calc" data-view="${access === 'active' ? 'calc' : 'profile'}">
        <span>${icon(access === 'active' ? 'calc' : 'user')}<span>${access === 'active' ? 'К расчёту' : 'Вход и регистрация'}</span></span>${icon('chevron', 'icon rot-90')}
      </button>
    </article>`;
}

let authMode: 'login' | 'register' = 'login';

function bindAuth(root: HTMLElement) {
  if (serverUp && !account && authMode === 'register') startPow();
  root.querySelectorAll<HTMLButtonElement>('[data-auth]').forEach((b) =>
    b.addEventListener('click', () => {
      authMode = b.dataset.auth as 'login' | 'register';
      if (authMode === 'login') resetPow();
      renderView();
      $<HTMLInputElement>('#a-email', root)?.focus();
    }),
  );
  $<HTMLFormElement>('#auth-form', root)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const email = String(fd.get('email') ?? '').trim();
    const password = String(fd.get('password') ?? '');
    const err = $('#auth-error', root)!;
    const btn = $<HTMLButtonElement>('#auth-form [type=submit]', root)!;
    const fail = (msg: string) => {
      err.textContent = msg;
      err.hidden = false;
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Проверьте email.');
    if (password.length < 8) return fail('Пароль — минимум 8 символов.');
    if (authMode === 'register' && !fd.get('accept')) return fail('Отметьте согласие с условиями использования.');
    btn.disabled = true;
    try {
      if (authMode === 'register') {
        btn.textContent = 'Проверка…';
        await registerWithPow({ email, password, name: String(fd.get('name') ?? '').trim(), website: String(fd.get('website') ?? ''), accept: true });
      } else await api.login(email, password);
      await loadAccount();
      if (access === 'active' && view === 'legal') view = 'calc';
      renderShell();
      toast(access === 'active' ? (authMode === 'register' ? 'Аккаунт создан' : 'Вы вошли') : authMode === 'register' ? 'Заявка отправлена' : 'Вы вошли');
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт';
      // Решение одноразовое — для следующей попытки готовим новое.
      if (authMode === 'register') startPow();
      if (ex instanceof ApiError && ex.status === 409 && authMode === 'register') {
        // Такой email уже есть — переключаем на вход и сохраняем введённый адрес.
        authMode = 'login';
        resetPow();
        renderView();
        $<HTMLInputElement>('#a-email', root)!.value = email;
        $('#auth-error', root)!.textContent = 'Этот email уже зарегистрирован — введите пароль, чтобы войти.';
        $('#auth-error', root)!.hidden = false;
        $<HTMLInputElement>('#a-password', root)?.focus();
        return;
      }
      fail(ex instanceof ApiError ? ex.message : ex instanceof Error ? ex.message : 'Сервер недоступен, попробуйте позже.');
    }
  });
}

/** Поле пароля с кнопкой «показать» и, для нового пароля, индикатором надёжности. */
function pwField(id: string, name: string, label: string, autocomplete: string, placeholder = '', meter = false): string {
  return `
    <div class="field">
      <label class="field-label" for="${id}">${icon('shield')}<span>${label}</span></label>
      <div class="pw-wrap">
        <input id="${id}" name="${name}" type="password" autocomplete="${autocomplete}" required minlength="8" placeholder="${esc(placeholder)}"
          spellcheck="false" autocapitalize="off" ${meter ? 'data-meter' : ''} />
        <button type="button" class="pw-toggle" data-pw-toggle="${id}" aria-label="Показать пароль" aria-pressed="false">${icon('eye')}</button>
      </div>
      ${meter ? `<div class="pw-meter" data-meter-for="${id}" data-score="0"><i></i><i></i><i></i><i></i><span></span></div>` : ''}
    </div>`;
}

function passwordStrength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: '' };
  if (pw.length < 8) return { score: 1, label: 'Слишком короткий' };
  let score = 1;
  if (pw.length >= 12) score++;
  if (/[a-zа-я]/.test(pw) && /[A-ZА-Я]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^\p{L}\d]/u.test(pw)) score++;
  else if (/\d/.test(pw) || /[^\p{L}\d]/u.test(pw)) score += 0.5;
  if (/^(.)\1+$/.test(pw) || /^(12345|qwerty|password|йцукен)/i.test(pw)) score = 1;
  const s = Math.min(4, Math.round(score));
  return { score: s, label: ['', 'Слабый', 'Средний', 'Хороший', 'Надёжный'][s] };
}

function bindPasswordChange(root: HTMLElement) {
  const form = $<HTMLFormElement>('#pw-form', root);
  const open = $<HTMLButtonElement>('[data-action=pw-open]', root);
  if (!form || !open) return;
  const toggle = (show: boolean) => {
    open.setAttribute('aria-expanded', String(show));
    if (show) {
      form.hidden = false;
      requestAnimationFrame(() => form.classList.add('open'));
      $<HTMLInputElement>('#pw-current', form)?.focus();
    } else {
      form.classList.remove('open');
      form.reset();
      form.querySelectorAll<HTMLElement>('.pw-meter').forEach((m) => (m.dataset.score = '0'));
      setTimeout(() => (form.hidden = !form.classList.contains('open') ? true : form.hidden), 220);
    }
  };
  open.addEventListener('click', () => toggle(form.hidden || !form.classList.contains('open')));
  $('[data-action=pw-cancel]', form)?.addEventListener('click', () => toggle(false));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const current = String(fd.get('current') ?? '');
    const next = String(fd.get('next') ?? '');
    const repeat = String(fd.get('repeat') ?? '');
    const err = $('#pw-error', form)!;
    const fail = (msg: string, field?: string) => {
      err.textContent = msg;
      err.hidden = false;
      form.classList.remove('shake');
      void form.offsetWidth;
      form.classList.add('shake');
      if (field) $<HTMLInputElement>(`#${field}`, form)?.focus();
    };
    if (!current) return fail('Введите текущий пароль.', 'pw-current');
    if (next.length < 8) return fail('Новый пароль — минимум 8 символов.', 'pw-next');
    if (next !== repeat) return fail('Пароли не совпадают.', 'pw-repeat');
    if (next === current) return fail('Новый пароль совпадает с текущим.', 'pw-next');
    const btn = $<HTMLButtonElement>('[type=submit]', form)!;
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      await api.changePassword(current, next);
      err.hidden = true;
      toggle(false);
      toast('Пароль изменён');
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === 'current') fail(ex.message, 'pw-current');
      else fail(ex instanceof ApiError ? ex.message : 'Сервер недоступен, попробуйте позже.');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  });
}

/** Временный пароль после сброса: показываем один раз, с кнопкой «Скопировать». */
function showTempPassword(email: string, password: string) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tmp-title">
      <div class="modal-icon">${icon('key')}</div>
      <p id="tmp-title"><b>Временный пароль для ${esc(email)}</b></p>
      <div class="temp-pw"><code>${esc(password)}</code><button class="btn small" data-copy>${icon('copy')}Скопировать</button></div>
      <p class="muted small">Передайте его пользователю лично — после входа он сменит пароль в профиле. Больше этот пароль не будет показан.</p>
      <div class="modal-actions"><button class="btn primary" data-close>Готово</button></div>
    </div>`;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  overlay.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t === overlay || t.closest('[data-close]')) return close();
    const copy = t.closest<HTMLButtonElement>('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(password);
        copy.innerHTML = `${icon('check')}Скопировано`;
      } catch {
        toast('Не удалось скопировать — выделите вручную');
      }
    }
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLButtonElement>('[data-copy]')!.focus();
}

/** Форма входа и регистрации — на приветственной странице для гостей. */
function authCardHtml(): string {
  return `
      <form class="card auth" id="auth-form" novalidate>
        <div class="segmented" role="tablist">
          <button type="button" class="seg${authMode === 'login' ? ' active' : ''}" data-auth="login">${icon('user')}<span>Вход</span></button>
          <button type="button" class="seg${authMode === 'register' ? ' active' : ''}" data-auth="register">${icon('plus')}<span>Регистрация</span></button>
        </div>
        <p class="muted small">${
          authMode === 'login'
            ? 'Войдите, если администратор уже открыл вам доступ.'
            : 'После регистрации администратор проверит заявку и откроет доступ. Нужны только email и пароль.'
        }</p>
        ${
          authMode === 'register'
            ? `<div class="field"><label class="field-label" for="a-name">${icon('user')}<span>Имя</span></label><input id="a-name" name="name" type="text" autocomplete="name" placeholder="Как к вам обращаться" /></div>`
            : ''
        }
        <div class="field"><label class="field-label" for="a-email">${icon('info')}<span>Email</span></label><input id="a-email" name="email" type="email" autocomplete="email" required placeholder="name@mail.com" value="${esc(profile?.email ?? '')}" /></div>
        ${pwField('a-password', 'password', 'Пароль', authMode === 'login' ? 'current-password' : 'new-password', authMode === 'login' ? '' : 'Минимум 8 символов', authMode === 'register')}
        ${
          authMode === 'register'
            ? `<div class="hp" aria-hidden="true"><label>Сайт <input name="website" type="text" tabindex="-1" autocomplete="off" /></label></div>
               <p class="pow-status small" id="pow-status">${powStatusHtml()}</p>`
            : ''
        }
        ${
          authMode === 'register'
            ? `<label class="consent"><input type="checkbox" name="accept" id="a-accept" />
                 <span>Я принимаю <button type="button" class="link" data-view="legal">условия использования</button> и даю согласие на обработку моих персональных данных</span></label>`
            : ''
        }
        <p class="form-error" id="auth-error" role="alert" hidden></p>
        <button class="btn primary" type="submit">${authMode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
      </form>`;
}


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

  const migrateCard =
    account && pendingLocal.length
      ? `
      <div class="card migrate">
        <div class="card-head">${icon('upload')}<h2>Перенести в аккаунт</h2></div>
        <p class="muted small">На этом устройстве есть ${pendingLocal.length} ${plural(pendingLocal.length, 'месяц', 'месяца', 'месяцев')}, которых нет в аккаунте: ${esc(pendingLocal.map((h) => monthLabel(h.month)).join(', '))}.</p>
        <button class="btn primary" data-action="migrate">${icon('upload')}Перенести</button>
      </div>`
      : '';

  root.innerHTML = `
    <section class="page">
      ${migrateCard}
      <div class="profile-head card">
        <div class="avatar big">${p.name ? `<span>${esc(initials(p.name))}</span>` : icon('user')}</div>
        <div class="profile-id">
          <h1>${p.name ? esc(displayName(p.name)) : 'Ваш аккаунт'}</h1>
          <p class="muted">${account ? esc(account.email) : p.email ? esc(p.email) : 'Заполните данные из расчётного листка'}</p>
          ${account ? `<p class="small account-ok">${icon('shield')}Аккаунт · данные сохраняются в облаке</p>` : ''}
          ${p.organization || p.employeeId ? `<p class="muted small">${esc([p.organization, p.employeeId && `таб. № ${p.employeeId}`].filter(Boolean).join(' · '))}</p>` : ''}
        </div>
        ${account ? `<button class="btn small ghost logout" data-action="logout">${icon('logout')}Выйти</button>` : ''}
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

      ${
        account
          ? `<div class="card security">
        <div class="card-head">${icon('key')}<h2>Безопасность</h2></div>
        <div class="security-row">
          <div><b>Пароль</b><span class="muted small">Вход по ${esc(account.email)}</span></div>
          <button class="btn small" data-action="pw-open" aria-expanded="false" aria-controls="pw-form">${icon('key')}Сменить пароль</button>
        </div>
        <form class="pw-form collapse" id="pw-form" novalidate hidden>
          ${pwField('pw-current', 'current', 'Текущий пароль', 'current-password')}
          ${pwField('pw-next', 'next', 'Новый пароль', 'new-password', 'Минимум 8 символов', true)}
          ${pwField('pw-repeat', 'repeat', 'Повторите новый пароль', 'new-password')}
          <p class="form-error" id="pw-error" role="alert" hidden></p>
          <p class="field-hint">После смены пароля вы останетесь в аккаунте здесь, а на других устройствах нужно будет войти заново.</p>
          <div class="form-actions">
            <button class="btn primary" type="submit">${icon('check')}Сохранить пароль</button>
            <button class="btn ghost" type="button" data-action="pw-cancel">Отмена</button>
          </div>
        </form>
      </div>`
          : ''
      }

      <div class="card">
        <div class="card-head">${icon('wallet')}<h2>Мои оклады</h2></div>
        ${
          mySalaries
            ? `<ul class="kv">${mySalaries}</ul><p class="field-hint">Подставляются сами при выборе должности.</p>`
            : '<p class="muted small">Введите оклад в расчёте — он запомнится для этой должности.</p>'
        }
      </div>

      ${
        plan?.admin
          ? `<button class="card to-calc plan-link" data-pro><span>${icon('shield')}<span>Пользователи и доступ</span></span><b class="plan-state">администратор</b>${icon('chevron', 'icon rot-90')}</button>`
          : ''
      }
      ${
        serverUp
          ? `<button class="card to-calc plan-link" data-pro><span>${icon('crown')}<span>Подписка</span></span><b class="plan-state">${esc(planLabel())}</b>${icon('chevron', 'icon rot-90')}</button>`
          : ''
      }
      <button class="card to-calc" data-goto="settings"><span>${icon('sliders')}<span>Настройки</span></span>${icon('chevron', 'icon rot-90')}</button>

      <div class="card">
        <div class="card-head">${icon('shield')}<h2>Хранение и перенос</h2></div>
        <p class="muted small">${
          account
            ? 'Расчёты, листки и оклады хранятся в аккаунте и доступны на любом устройстве после входа. Можно также сохранить копию файлом.'
            : 'Без входа данные хранятся только на этом устройстве. Чтобы открыть их на другом телефоне, сохраните копию и загрузите её там.'
        }</p>
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
    profile = { ...next, email: account?.email ?? next.email };
    saveProfile(profile);
    if (account) api.saveProfile(toServerProfile()).catch(() => toast('Не удалось сохранить в аккаунт'));
    renderShell();
    toast('Профиль сохранён');
  });

  $('[data-goto=settings]', root)?.addEventListener('click', () => go('settings'));
  bindPasswordChange(root);
  $('[data-action=logout]', root)?.addEventListener('click', async () => {
    if (!(await ask('Выйти из аккаунта? Данные аккаунта будут удалены с этого устройства (в облаке они сохранятся).', 'Выйти')))
      return;
    try {
      await api.logout();
    } catch {
      /* всё равно выходим локально */
    }
    account = null;
    plan = null;
    proRequest = null;
    rememberPlan();
    pendingLocal = [];
    authMode = 'login';
    applyBackup(makeBackup(null, { ...defaultState(reg), theme: state.theme }, [], {}));
    access = 'guest';
    forgetAccess();
    go('calc');
    toast('Вы вышли');
  });
  $('[data-action=migrate]', root)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    let moved = 0;
    for (const h of pendingLocal) {
      try {
        await api.saveMonth(h.month, h.state, null);
        moved++;
      } catch {
        /* месяц с ошибкой пропускаем */
      }
    }
    await loadAccount();
    renderShell();
    toast(`Перенесено: ${moved}`);
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
  root.innerHTML = `
    <section class="page ref">
      <div class="page-head">
        <h1>Справочник</h1>
        <p class="muted">Ставки и коэффициенты, по которым идёт расчёт. Прочерк — сочетание недоступно.
          Значения справочные и могут отличаться от действующих — сверяйтесь с документами работодателя. Не распространяйте их за пределами сервиса.</p>
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
      syncProfileSoon();
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

// ---------- облако ----------

/** Месяцы на устройстве, которых нет в аккаунте (после входа предлагаем перенести). */
let pendingLocal: HistoryEntry[] = [];

function labelFor(periods: AppState['periods']): string {
  return periods
    .map((p) => {
      const pos = findPosition(reg, p.category, p.positionId);
      const ac = pos?.needsAircraft && p.aircraft >= 0 ? `, ${reg.aircraft[p.aircraft]}` : '';
      return `${pos?.label ?? ''}${ac}`;
    })
    .join(' → ');
}

function toServerProfile(): ServerProfile {
  return {
    name: profile?.name ?? account?.name ?? '',
    employeeId: profile?.employeeId ?? '',
    organization: profile?.organization ?? '',
    department: profile?.department ?? '',
    salaries,
    settings: { ...state.settings },
    theme: state.theme,
  };
}

let profileTimer = 0;
function syncProfileSoon() {
  if (!account) return;
  clearTimeout(profileTimer);
  profileTimer = window.setTimeout(() => api.saveProfile(toServerProfile()).catch(() => {}), 700);
}

function applyServerProfile(sp: ServerProfile) {
  if (!account) return;
  profile = {
    name: sp.name || profile?.name || account.name || '',
    email: account.email,
    employeeId: sp.employeeId || profile?.employeeId || '',
    organization: sp.organization || profile?.organization || '',
    department: sp.department || profile?.department || '',
    createdAt: profile?.createdAt || new Date().toISOString(),
  };
  saveProfile(profile);
  if (sp.salaries) salaries = { ...salaries, ...sp.salaries };
  saveSalaries(salaries);
  if (sp.theme) state.theme = sp.theme;
  if (sp.settings) state.settings = { ...state.settings, ...(sp.settings as Partial<AppState['settings']>) };
  persist();
}

async function loadAccount() {
  try {
    const me = await api.me();
    account = me.user;
    plan = me.plan;
    proRequest = me.request;
    access = me.access;
    rememberPlan();
    if (access !== 'active') {
      forgetAccess();
      return;
    }
    if (!reg) {
      const r = await fetchRegulation();
      if (!r) {
        access = 'offline';
        return;
      }
      initData(r);
    }
    rememberAccess();
    const before = history.slice();
    applyServerProfile(me.profile);
    const { months } = await api.months();
    history = months.map((m) => {
      const st = m.state as HistoryEntry['state'];
      return {
        month: m.month,
        savedAt: m.updatedAt,
        total: m.totals.total,
        net: m.totals.net,
        piece: m.totals.piece,
        time: m.totals.time,
        extras: m.totals.extras,
        label: labelFor(st.periods),
        payslipId: m.payslipId,
        state: st,
      };
    });
    saveHistory(history);
    pendingLocal = before.filter((h) => !history.some((x) => x.month === h.month));
    // Новый аккаунт без данных профиля — отправляем то, что уже есть на устройстве.
    if (!me.profile.employeeId && (profile?.employeeId || Object.keys(salaries).length)) syncProfileSoon();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) console.warn(e);
    account = null;
    plan = null;
    proRequest = null;
    if (e instanceof ApiError && e.status === 401) {
      access = 'guest';
      rememberPlan();
      forgetAccess();
    }
  }
}

// ---------- boot ----------

declare global {
  interface Window {
    __CREWPAY_SEED__?: unknown;
  }
}

async function boot() {
  history = loadHistory();
  profile = loadProfile();
  salaries = loadSalaries();
  if (!IS_EMBED && location.pathname.replace(/\/$/, '') === '/legal') view = 'legal';

  if (IS_EMBED) {
    // Предпросмотр без сервера: ставки встраиваются в файл (в обычную сборку эта ветка не попадает).
    if (import.meta.env.VITE_TARGET === 'embed') initData((await import('../data/regulation.json')).default as Regulation);
    access = 'active';
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
  } else {
    serverUp = await api.available();
    if (serverUp) {
      api.planInfo().then((i) => {
        planInfo = i;
        if (view === 'legal') renderView();
      }).catch(() => {});
      await loadAccount();
      // Вернулись со страницы Payme / Click.
      const paid = Number(new URLSearchParams(location.search).get('paid'));
      if (Number.isSafeInteger(paid) && paid > 0) {
        window.history.replaceState(null, '', location.pathname);
        view = 'pro';
        if (account && access === 'active') watchPayment(paid);
      }
    } else {
      // Офлайн: работаем, только если доступ уже был открыт на этом устройстве.
      const r = cachedRegulation();
      let had = false;
      try {
        had = localStorage.getItem(ACCESS_KEY) === 'active';
      } catch {
        /* хранилище недоступно */
      }
      if (r && had) {
        initData(r);
        access = 'active';
      } else access = 'offline';
    }
  }

  // Показ пароля и индикатор надёжности — для всех полей пароля в приложении.
  app.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-pw-toggle]');
    if (!b) return;
    const input = document.getElementById(b.dataset.pwToggle!) as HTMLInputElement | null;
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.setAttribute('aria-pressed', String(show));
    b.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
    b.innerHTML = icon(show ? 'eyeOff' : 'eye');
    input.focus({ preventScroll: true });
  });
  app.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches('[data-meter]')) return;
    const m = document.querySelector<HTMLElement>(`[data-meter-for="${input.id}"]`);
    if (!m) return;
    const { score, label } = passwordStrength(input.value);
    m.dataset.score = String(score);
    m.querySelector('span')!.textContent = label;
  });

  // Ссылки на разделы внутри страниц (например, «условия использования» в форме регистрации).
  app.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('#view [data-view]');
    if (!t) return;
    e.preventDefault();
    go(t.dataset.view as View);
  });

  // Кнопки «Pro» есть на разных страницах — один обработчик на всё приложение.
  app.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-pro], [data-pro-register], [data-pro-login]');
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute('data-pro')) return go('pro');
    authMode = t.hasAttribute('data-pro-register') ? 'register' : 'login';
    go('profile');
    $<HTMLInputElement>('#a-email')?.focus();
  });

  applyTheme();
  renderShell();
  // Каскад карточек при первом показе; дальше — только при переходах между разделами.
  document.body.classList.add('booted');
  setTimeout(() => document.body.classList.remove('booted'), 900);

  if ('serviceWorker' in navigator && import.meta.env.PROD && !IS_EMBED) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  }
}

boot();
