/**
 * Thin API client. The admin token lives in localStorage for this first cut;
 * swapping it for a session cookie + per-user accounts is the first thing to do
 * before anyone outside the team touches the dashboard, since every action here
 * moves money in someone's books and the audit trail records who did it.
 */

const TOKEN_KEY = 'mpesa-tally-token';
const OPERATOR_KEY = 'mpesa-tally-operator';

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);
export const getOperator = (): string => localStorage.getItem(OPERATOR_KEY) ?? '';
export const setOperator = (name: string): void => localStorage.setItem(OPERATOR_KEY, name);

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${getToken()}`,
      'x-operator': getOperator() || 'operator',
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? 'request failed');
  }
  return res.json() as Promise<T>;
}

export interface Transaction {
  id: string;
  trans_id: string;
  amount: string;
  msisdn: string | null;
  payer_name: string | null;
  bill_ref: string | null;
  trans_time: string;
  status: string;
  received_at: string;
  verified_at: string | null;
  shortcode_label: string;
  shortcode_kind: 'paybill' | 'till';
  match_id: string | null;
  method: string | null;
  confidence: string | null;
  match_state: string | null;
  party_ledger: string | null;
  candidates: Array<{ voucherNumber: string; partyLedger: string; outstanding: string; reason: string }> | null;
  review_reason: string | null;
  voucher_number: string | null;
  post_state: string | null;
  post_error: string | null;
  post_attempt: number | null;
}

export interface Invoice {
  id: string;
  voucher_number: string;
  party_ledger: string;
  party_msisdn: string | null;
  invoice_date: string;
  amount: string;
  amount_settled: string;
  outstanding: string;
  status: string;
}

export interface Health {
  minutesSinceLastCallback: number | null;
  unmatchedCount: number;
  ambiguousCount: number;
  failedPosts: number;
  stuckPosts: number;
  oldestPendingPostMinutes: number | null;
}

export interface VarianceRow {
  day: string;
  mpesa_total: string;
  posted_total: string | null;
  variance: string;
  txn_count: string;
  posted_count: string;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  tally_company: string;
  active: boolean;
  shortcodes: Array<{ id: string; shortcode: string; kind: string; label: string; bankLedger: string; active: boolean }>;
}

export const api = {
  health: () => call<Health>('/health'),
  tenants: () => call<{ tenants: Tenant[] }>('/tenants'),
  transactions: (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    return call<{ transactions: Transaction[] }>(`/transactions?${q}`);
  },
  transaction: (id: string) =>
    call<{
      transaction: Record<string, unknown>;
      matches: Array<Record<string, unknown>>;
      posts: Array<Record<string, unknown>>;
      auditTrail: Array<{ action: string; actor: string; data: Record<string, unknown>; created_at: string }>;
    }>(`/transactions/${id}`),
  invoices: (params: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return call<{ invoices: Invoice[] }>(`/invoices?${q}`);
  },
  match: (id: string, body: { invoiceId?: string; partyLedger?: string; reason?: string }) =>
    call<{ ok: boolean }>(`/transactions/${id}/match`, { method: 'POST', body: JSON.stringify(body) }),
  approve: (id: string) => call<{ ok: boolean }>(`/transactions/${id}/approve`, { method: 'POST' }),
  reject: (id: string, reason: string) =>
    call<{ ok: boolean }>(`/transactions/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  reverse: (id: string, reason: string) =>
    call<{ ok: boolean }>(`/transactions/${id}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) }),
  ignore: (id: string, reason: string) =>
    call<{ ok: boolean }>(`/transactions/${id}/ignore`, { method: 'POST', body: JSON.stringify({ reason }) }),
  rematch: (id: string) => call<{ ok: boolean }>(`/transactions/${id}/rematch`, { method: 'POST' }),
  retryPost: (id: string) => call<{ ok: boolean }>(`/transactions/${id}/retry-post`, { method: 'POST' }),
  syncInvoices: () => call<{ results: unknown[] }>('/sync-invoices', { method: 'POST' }),
  variance: (tenantId: string, days = 14) =>
    call<{ variance: VarianceRow[] }>(`/variance?tenantId=${tenantId}&days=${days}`),
};

export const formatKes = (amount: string | number): string =>
  `KES ${Number(amount).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
