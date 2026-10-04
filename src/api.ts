// Клиент API. Если сервера нет (предпросмотр, статический хостинг) — приложение работает локально.
import type { Payslip, PayslipImport } from './calc/payslip';
import type { PowChallenge, PowSolution } from './pow';

export interface Account {
  id: string;
  email: string;
  name: string;
}

export interface Plan {
  pro: boolean;
  /** Окончание Pro (ISO); null — бессрочно (администратор) или нет подписки. */
  until: string | null;
  source: 'trial' | 'paid' | 'admin' | null;
  admin: boolean;
}

export interface PlanInfo {
  price: number;
  trialDays: number;
  terms: number[];
  contactUrl: string;
}

export interface ProRequest {
  id: string;
  months: number;
  createdAt: string;
}

export interface AdminUser {
  email: string;
  name: string;
  proUntil: string | null;
  proSource: string | null;
  createdAt: string;
  plan: Plan;
}

export interface AdminRequest {
  id: string;
  months: number;
  note: string;
  createdAt: string;
  email: string;
  name: string;
  proUntil: string | null;
}

export interface ServerProfile {
  name?: string;
  employeeId?: string;
  organization?: string;
  department?: string;
  salaries?: Record<string, string>;
  settings?: Record<string, string>;
  theme?: 'system' | 'light' | 'dark';
}

export interface ServerMonth {
  month: string;
  state: unknown;
  totals: { total: number; net: number; tax: number; piece: number; time: number; extras: number };
  payslipId: string | null;
  updatedAt: string;
}

export interface UploadedPayslip {
  id: string;
  filename: string;
  createdAt: string;
  parsed: Payslip;
  imported: PayslipImport;
}

export interface PayslipSummary {
  id: string;
  month: string | null;
  filename: string;
  parsed: Payslip;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-crewpay', '1');
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, body, headers, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = 'Сервер недоступен';
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string; code?: string };
      msg = j.error ?? msg;
      code = j.code;
    } catch {
      /* не JSON */
    }
    throw new ApiError(res.status, msg, code);
  }
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.blob()) as Promise<T>;
}

export const api = {
  async available(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch('api/health', { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      return res.ok && (res.headers.get('content-type') ?? '').includes('json');
    } catch {
      return false;
    }
  },
  me: () => req<{ user: Account; profile: ServerProfile; plan: Plan; request: ProRequest | null }>('api/me'),
  challenge: () => req<PowChallenge>('api/auth/challenge', { cache: 'no-store' }),
  register: (body: { email: string; password: string; name: string; captcha: PowSolution; website: string }) =>
    req<{ user: Account; plan: Plan }>('api/auth/register', { method: 'POST', json: body }),
  login: (email: string, password: string) => req<{ user: Account }>('api/auth/login', { method: 'POST', json: { email, password } }),
  logout: () => req<{ ok: true }>('api/auth/logout', { method: 'POST' }),
  saveProfile: (p: ServerProfile) => req<{ profile: ServerProfile }>('api/profile', { method: 'PUT', json: p }),
  months: () => req<{ months: ServerMonth[] }>('api/months'),
  saveMonth: (month: string, state: unknown, payslipId: string | null) =>
    req<{ month: string; totals: ServerMonth['totals'] }>(`api/months/${month}`, { method: 'PUT', json: { state, payslipId } }),
  deleteMonth: (month: string) => req<{ ok: true }>(`api/months/${month}`, { method: 'DELETE' }),
  uploadPayslip: (file: File) => {
    const fd = new FormData();
    fd.set('file', file);
    return req<UploadedPayslip>('api/payslips', { method: 'POST', body: fd });
  },
  payslips: () => req<{ payslips: PayslipSummary[] }>('api/payslips'),
  deletePayslip: (id: string) => req<{ ok: true }>(`api/payslips/${id}`, { method: 'DELETE' }),
  payslipUrl: (id: string) => `api/payslips/${id}/file`,
  report: (body: unknown) => req<Blob>('api/report', { method: 'POST', json: body }),
  planInfo: () => req<PlanInfo>('api/plan'),
  requestPro: (months: number, note: string) =>
    req<{ request: ProRequest }>('api/subscription/request', { method: 'POST', json: { months, note } }),
  cancelProRequest: () => req<{ ok: true }>('api/subscription/request', { method: 'DELETE' }),
  adminSubscriptions: (q = '') =>
    req<{ requests: AdminRequest[]; users: AdminUser[] }>(`api/admin/subscriptions${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  adminGrant: (email: string, months: number) =>
    req<{ email: string; plan: Plan }>('api/admin/grant', { method: 'POST', json: { email, months } }),
  adminReject: (id: string) => req<{ ok: true }>(`api/admin/requests/${id}/reject`, { method: 'POST' }),
};
