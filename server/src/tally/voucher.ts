import { createHash } from 'node:crypto';
import { fromCents } from '../lib/money.js';

/** Tally's XML parser is unforgiving; escape everything that goes into a tag. */
export function xmlEscape(value: string): string {
  return stripControlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Tally chokes on raw control characters in narrations and ledger names. */
export function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** Tally dates are yyyyMMdd in the company's own timezone (EAT here). */
export function tallyDate(date: Date, timeZone = 'Africa/Nairobi'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

export interface BillAllocation {
  /** Invoice/voucher number in Tally, or a new reference for on-account money. */
  name: string;
  billType: 'Agst Ref' | 'New Ref' | 'On Account' | 'Advance';
  amountCents: number;
}

export interface ReceiptVoucherInput {
  company: string;
  timezone?: string;
  /** Ledger the money landed in: the Till/Paybill's bank or cash ledger. */
  bankLedger: string;
  partyLedger: string;
  amountCents: number;
  date: Date;
  transId: string;
  msisdn: string | null;
  payerName: string | null;
  shortcodeLabel: string;
  allocations: BillAllocation[];
  voucherTypeName?: string;
}

/**
 * Deterministic REMOTEID derived from the M-Pesa receipt number.
 *
 * This is the idempotency key *inside Tally*: if the Bridge times out after
 * Tally has already committed the voucher, the retry carries the same REMOTEID
 * and Tally updates that voucher instead of creating a second one.
 */
export function remoteIdFor(transId: string): string {
  const h = createHash('sha1').update(`mpesa:${transId}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)]
    .join('-')
    .toUpperCase();
}

export function buildNarration(input: ReceiptVoucherInput): string {
  const bits = [
    `M-PESA ${input.transId}`,
    input.msisdn ? `from ${input.msisdn}` : null,
    input.payerName ? `(${input.payerName})` : null,
    `via ${input.shortcodeLabel}`,
  ].filter(Boolean);
  return bits.join(' ');
}

/**
 * Receipt voucher: debit the M-Pesa bank/cash ledger, credit the customer.
 *
 * Tally's sign convention: the debit side is ISDEEMEDPOSITIVE=Yes with a
 * negative AMOUNT, the credit side is ISDEEMEDPOSITIVE=No with a positive one.
 * Getting this backwards produces a voucher that imports cleanly and reverses
 * the cash book, so it is asserted below rather than trusted.
 */
export function buildReceiptVoucherXml(input: ReceiptVoucherInput): string {
  const allocated = input.allocations.reduce((sum, a) => sum + a.amountCents, 0);
  if (allocated !== input.amountCents) {
    throw new Error(
      `bill allocations (${fromCents(allocated)}) do not sum to voucher amount (${fromCents(input.amountCents)})`,
    );
  }
  if (input.amountCents <= 0) throw new Error('receipt amount must be positive');

  const date = tallyDate(input.date, input.timezone);
  const amount = fromCents(input.amountCents);
  const voucherType = input.voucherTypeName ?? 'Receipt';

  const allocationXml = input.allocations
    .map(
      (a) => `            <BILLALLOCATIONS.LIST>
              <NAME>${xmlEscape(a.name)}</NAME>
              <BILLTYPE>${a.billType}</BILLTYPE>
              <AMOUNT>${fromCents(a.amountCents)}</AMOUNT>
            </BILLALLOCATIONS.LIST>`,
    )
    .join('\n');

  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(input.company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${xmlEscape(voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
            <REMOTEID>${remoteIdFor(input.transId)}</REMOTEID>
            <DATE>${date}</DATE>
            <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>${xmlEscape(voucherType)}</VOUCHERTYPENAME>
            <PARTYLEDGERNAME>${xmlEscape(input.partyLedger)}</PARTYLEDGERNAME>
            <REFERENCE>${xmlEscape(input.transId)}</REFERENCE>
            <NARRATION>${xmlEscape(buildNarration(input))}</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(input.bankLedger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${amount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(input.partyLedger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${amount}</AMOUNT>
${allocationXml}
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/**
 * Reversal. Tally has no "unpost" for an imported voucher, so a miscredit is
 * undone by cancelling the original by its REMOTEID -- which is why REMOTEID is
 * deterministic and stored.
 */
export function buildCancelVoucherXml(company: string, transId: string, voucherType = 'Receipt'): string {
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${xmlEscape(voucherType)}" ACTION="Cancel">
            <REMOTEID>${remoteIdFor(transId)}</REMOTEID>
            <ISCANCELLED>Yes</ISCANCELLED>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/** Splits a payment across the matched invoice and, if it overpays, on account. */
export function allocationsFor(
  amountCents: number,
  invoiceNumber: string | null,
  outstandingCents: number | null,
): BillAllocation[] {
  if (!invoiceNumber || outstandingCents === null) {
    return [{ name: 'On Account', billType: 'On Account', amountCents }];
  }
  if (amountCents <= outstandingCents) {
    return [{ name: invoiceNumber, billType: 'Agst Ref', amountCents }];
  }
  return [
    { name: invoiceNumber, billType: 'Agst Ref', amountCents: outstandingCents },
    { name: 'On Account', billType: 'On Account', amountCents: amountCents - outstandingCents },
  ];
}
