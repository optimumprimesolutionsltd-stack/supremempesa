import { canonicalRef } from '../daraja/c2b.js';
import { toCents } from '../lib/money.js';
import {
  outstandingCents,
  type InvoiceCandidate,
  type MatchContext,
  type TransactionInput,
} from './engine.js';

/**
 * Builds a MatchContext in memory, mirroring the SQL in services/matching.ts.
 *
 * This is what makes the matcher testable without Postgres and without the
 * Daraja sandbox: recorded confirmation payloads plus a fixed invoice set are
 * enough to assert every tier and every guardrail in CI.
 */
export function buildFixtureContext(
  txn: TransactionInput,
  invoices: InvoiceCandidate[],
  partyLinks: Record<string, string> = {},
  dateWindowDays = 45,
): MatchContext {
  const open = invoices.filter((i) => i.status === 'open' || i.status === 'partial');
  const ref = canonicalRef(txn.billRef) ?? canonicalRef(txn.invoiceNumber);

  const invoicesByRef = ref
    ? open.filter((i) => canonicalRef(i.voucher_number) === ref)
    : [];

  const linkedPartyLedger = txn.msisdn ? (partyLinks[txn.msisdn] ?? null) : null;

  const invoicesForParty = linkedPartyLedger
    ? open.filter((i) => i.party_ledger === linkedPartyLedger)
    : [];

  const windowStart = new Date(txn.transTime.getTime() - dateWindowDays * 86_400_000);
  const windowEnd = new Date(txn.transTime.getTime() + 7 * 86_400_000);

  const invoicesByAmount = open.filter((i) => {
    if (outstandingCents(i) !== txn.amountCents) return false;
    const date = new Date(`${i.invoice_date}T00:00:00+03:00`);
    return date >= windowStart && date <= windowEnd;
  });

  return { invoicesByRef, linkedPartyLedger, invoicesForParty, invoicesByAmount };
}

/** Shapes a normalized C2B payload into matcher input. */
export function transactionInputFrom(
  normalized: {
    transId: string;
    amountCents: number;
    msisdn: string | null;
    payerName: string | null;
    billRef: string | null;
    invoiceNumber: string | null;
    transTime: Date;
  },
  shortcodeKind: 'paybill' | 'till',
): TransactionInput {
  return {
    id: normalized.transId,
    amountCents: normalized.amountCents,
    msisdn: normalized.msisdn,
    payerName: normalized.payerName,
    billRef: normalized.billRef,
    invoiceNumber: normalized.invoiceNumber,
    transTime: normalized.transTime,
    shortcodeKind,
  };
}

export const invoiceFixture = (
  partial: Partial<InvoiceCandidate> & Pick<InvoiceCandidate, 'id' | 'voucher_number' | 'party_ledger' | 'amount'>,
): InvoiceCandidate => ({
  party_msisdn: null,
  invoice_date: '2026-09-01',
  amount_settled: '0.00',
  status: 'open',
  ...partial,
});

export const centsOf = (amount: string): number => toCents(amount);
