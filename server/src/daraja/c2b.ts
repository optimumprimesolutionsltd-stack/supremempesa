import { z } from 'zod';
import { normalizeMsisdn, toCents } from '../lib/money.js';

/**
 * Daraja C2B confirmation payload.
 *
 * Safaricom sends every field as a string and sends "" rather than omitting
 * empty ones, so the schema is deliberately permissive: anything that parses
 * to a TransID + amount + shortcode is worth capturing. Validation strictness
 * belongs in the matcher, not in the ingest path -- rejecting a real payment
 * because a field shape drifted is worse than storing it and reviewing it.
 */
export const c2bConfirmationSchema = z
  .object({
    TransactionType: z.string().optional(),
    TransID: z.string().min(1),
    TransTime: z.string().min(8),
    TransAmount: z.union([z.string(), z.number()]),
    BusinessShortCode: z.union([z.string(), z.number()]),
    BillRefNumber: z.string().optional().default(''),
    InvoiceNumber: z.string().optional().default(''),
    OrgAccountBalance: z.union([z.string(), z.number()]).optional(),
    ThirdPartyTransID: z.string().optional().default(''),
    MSISDN: z.union([z.string(), z.number()]).optional(),
    FirstName: z.string().optional().default(''),
    MiddleName: z.string().optional().default(''),
    LastName: z.string().optional().default(''),
  })
  .passthrough();

export type C2bConfirmation = z.infer<typeof c2bConfirmationSchema>;

export interface NormalizedTransaction {
  transId: string;
  transType: string | null;
  transTime: Date;
  amountCents: number;
  shortcode: string;
  msisdn: string | null;
  payerName: string | null;
  billRef: string | null;
  invoiceNumber: string | null;
  orgBalance: string | null;
  thirdPartyId: string | null;
}

/** Daraja timestamps are yyyyMMddHHmmss in East Africa Time (UTC+3), no offset given. */
export function parseTransTime(value: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(value.trim());
  if (!m) {
    const fallback = new Date(value);
    if (Number.isNaN(fallback.getTime())) {
      throw new Error(`unparseable TransTime: ${value}`);
    }
    return fallback;
  }
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  return new Date(
    `${y}-${mo}-${d}T${h}:${mi}:${s}+03:00`,
  );
}

const clean = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
};

export function normalizeConfirmation(
  payload: C2bConfirmation,
): NormalizedTransaction {
  const name = [payload.FirstName, payload.MiddleName, payload.LastName]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(' ');

  return {
    transId: payload.TransID.trim(),
    transType: clean(payload.TransactionType),
    transTime: parseTransTime(payload.TransTime),
    amountCents: toCents(String(payload.TransAmount)),
    shortcode: String(payload.BusinessShortCode).trim(),
    msisdn: normalizeMsisdn(
      payload.MSISDN === undefined ? null : String(payload.MSISDN),
    ),
    payerName: name || null,
    billRef: clean(payload.BillRefNumber),
    invoiceNumber: clean(payload.InvoiceNumber),
    orgBalance: clean(
      payload.OrgAccountBalance === undefined
        ? undefined
        : String(payload.OrgAccountBalance),
    ),
    thirdPartyId: clean(payload.ThirdPartyTransID),
  };
}

/**
 * Bill references are typed by humans on a phone keypad. Strip the noise before
 * comparing to a Tally voucher number, but keep the original for the audit trail.
 */
export function canonicalRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const c = ref.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length > 0 ? c : null;
}
