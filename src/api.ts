// Клиент API. Если сервера нет (предпросмотр, статический хостинг) — приложение работает локально.
import type { Payslip, PayslipImport } from './calc/payslip';

export interface Account {
  id: string;
  email: string;
  name: string;
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
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* не JSON */
    }
    throw new ApiError(res.status, msg);
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
  me: () => req<{ user: Account; profile: ServerProfile }>('api/me'),
  register: (email: string, password: string, name: string) =>
    req<{ user: Account }>('api/auth/register', { method: 'POST', json: { email, password, name } }),
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
};
