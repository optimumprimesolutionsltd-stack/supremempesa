import { canonicalRef } from '../daraja/c2b.js';
import { toCents } from '../lib/money.js';
import { msisdnTail } from '../lib/money.js';
import { nameSimilarity } from './similarity.js';

export type MatchMethod =
  | 'exact_ref'
  | 'known_party'
  | 'amount_window'
  | 'manual'
  | 'on_account';

export interface InvoiceCandidate {
  id: string;
  voucher_number: string;
  party_ledger: string;
  party_msisdn: string | null;
  invoice_date: string;
  amount: string;
  amount_settled: string;
  status: string;
}

export interface TransactionInput {
  id: string;
  amountCents: number;
  msisdn: string | null;
  payerName: string | null;
  billRef: string | null;
  invoiceNumber: string | null;
  transTime: Date;
  shortcodeKind: 'paybill' | 'till';
}

export interface MatchCandidateNote {
  invoiceId: string;
  voucherNumber: string;
  partyLedger: string;
  outstanding: string;
  reason: string;
}

export type MatchDecision =
  | {
      kind: 'match';
      method: MatchMethod;
      invoiceId: string | null;
      partyLedger: string;
      confidence: number;
      amountAppliedCents: number;
      isPartial: boolean;
      isOverpayment: boolean;
      candidates: MatchCandidateNote[];
      reason: string;
    }
  | { kind: 'ambiguous'; candidates: MatchCandidateNote[]; reason: string }
  | { kind: 'unmatched'; candidates: MatchCandidateNote[]; reason: string };

export interface MatchContext {
  invoicesByRef: InvoiceCandidate[];
  /** Open invoices for the ledger linked to this payer's phone number, if any. */
  linkedPartyLedger: string | null;
  invoicesForParty: InvoiceCandidate[];
  /** Open invoices whose outstanding equals the paid amount, inside the date window. */
  invoicesByAmount: InvoiceCandidate[];
}

export const outstandingCents = (inv: InvoiceCandidate): number =>
  toCents(inv.amount) - toCents(inv.amount_settled);

const note = (inv: InvoiceCandidate, reason: string): MatchCandidateNote => ({
  invoiceId: inv.id,
  voucherNumber: inv.voucher_number,
  partyLedger: inv.party_ledger,
  outstanding: (outstandingCents(inv) / 100).toFixed(2),
  reason,
});

/**
 * Tiered matching, most certain first. Two rules override everything else:
 *
 *   1. More than one plausible candidate is always 'ambiguous'. A confidence
 *      score has no business picking between two open invoices for the same
 *      amount -- that is how the wrong customer gets credited.
 *   2. A tier only fires on a positive signal. Absence of evidence produces
 *      'unmatched' and a queue entry, never a guess.
 *
 * Pure function: all database work happens in the caller and arrives as context,
 * which is what lets the fixture-replay harness exercise it without Postgres.
 */
export function decideMatch(txn: TransactionInput, ctx: MatchContext): MatchDecision {
  const ref = canonicalRef(txn.billRef) ?? canonicalRef(txn.invoiceNumber);

  // Tier 1 -- exact reference. Paybill customers type the invoice number.
  if (ref && ctx.invoicesByRef.length > 0) {
    if (ctx.invoicesByRef.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: ctx.invoicesByRef.map((i) => note(i, 'duplicate voucher number for reference')),
        reason: `reference ${ref} matches ${ctx.invoicesByRef.length} invoices`,
      };
    }
    const invoice = ctx.invoicesByRef[0]!;
    return settle(txn, invoice, 'exact_ref', 0.99, `bill reference matches ${invoice.voucher_number}`);
  }

  // Tier 2 -- known party. The phone number has been confirmed against a ledger before.
  if (ctx.linkedPartyLedger) {
    const exact = ctx.invoicesForParty.filter((i) => outstandingCents(i) === txn.amountCents);

    if (exact.length === 1) {
      return settle(
        txn,
        exact[0]!,
        'known_party',
        0.95,
        `known payer ${ctx.linkedPartyLedger}, exact outstanding amount`,
      );
    }
    if (exact.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: exact.map((i) => note(i, 'same outstanding amount for known payer')),
        reason: `known payer has ${exact.length} invoices open for this exact amount`,
      };
    }
    if (ctx.invoicesForParty.length === 1) {
      const only = ctx.invoicesForParty[0]!;
      // Partial payment against the single open invoice is a normal, safe case.
      if (txn.amountCents < outstandingCents(only)) {
        return settle(txn, only, 'known_party', 0.92, 'known payer, part payment of only open invoice');
      }
      return settle(txn, only, 'known_party', 0.9, 'known payer, only open invoice');
    }
    if (ctx.invoicesForParty.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: ctx.invoicesForParty.map((i) => note(i, 'open invoice for known payer')),
        reason: 'known payer with several open invoices and no amount or reference match',
      };
    }
    // Known party, nothing open: credit the ledger on account rather than guess.
    return {
      kind: 'match',
      method: 'on_account',
      invoiceId: null,
      partyLedger: ctx.linkedPartyLedger,
      confidence: 0.85,
      amountAppliedCents: txn.amountCents,
      isPartial: false,
      isOverpayment: false,
      candidates: [],
      reason: 'known payer with no open invoice: post on account',
    };
  }

  // Tier 3 -- amount inside the date window. The only tool a Till-only merchant has.
  if (ctx.invoicesByAmount.length === 1) {
    const invoice = ctx.invoicesByAmount[0]!;
    const phoneAgrees =
      msisdnTail(invoice.party_msisdn) !== null &&
      msisdnTail(invoice.party_msisdn) === msisdnTail(txn.msisdn);
    const nameScore = nameSimilarity(txn.payerName, invoice.party_ledger);

    // A lone amount match is circumstantial. It auto-posts only when a second,
    // independent signal agrees: the phone number on file, or a strong name match.
    const confidence = phoneAgrees ? 0.93 : nameScore >= 0.5 ? 0.9 : 0.7;
    const why = phoneAgrees
      ? 'unique amount match, phone number on file agrees'
      : nameScore >= 0.5
        ? `unique amount match, payer name similar to party (${nameScore.toFixed(2)})`
        : 'unique amount match only, no corroborating signal';

    return settle(txn, invoice, 'amount_window', confidence, why);
  }

  if (ctx.invoicesByAmount.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: ctx.invoicesByAmount.map((i) => note(i, 'same outstanding amount')),
      reason: `${ctx.invoicesByAmount.length} open invoices share this amount`,
    };
  }

  return {
    kind: 'unmatched',
    candidates: [],
    reason: ref
      ? `reference ${ref} matched no open invoice, and no other signal applied`
      : 'no reference, no known payer, no unique amount match',
  };
}

function settle(
  txn: TransactionInput,
  invoice: InvoiceCandidate,
  method: MatchMethod,
  confidence: number,
  reason: string,
): MatchDecision {
  const outstanding = outstandingCents(invoice);
  const isPartial = txn.amountCents < outstanding;
  const isOverpayment = txn.amountCents > outstanding;

  return {
    kind: 'match',
    method,
    invoiceId: invoice.id,
    partyLedger: invoice.party_ledger,
    // An overpayment leaves money on account, which an operator should see.
    confidence: isOverpayment ? Math.min(confidence, 0.85) : confidence,
    amountAppliedCents: txn.amountCents,
    isPartial,
    isOverpayment,
    candidates: [note(invoice, reason)],
    reason: isOverpayment
      ? `${reason} (overpayment: ${((txn.amountCents - outstanding) / 100).toFixed(2)} on account)`
      : reason,
  };
}
