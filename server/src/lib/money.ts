/**
 * Money is handled as integer cents internally and as fixed-2dp strings at the
 * database and Tally boundaries. Floats never touch a balance.
 */

export function toCents(value: string | number): number {
  const s = typeof value === 'number' ? value.toFixed(2) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`not a money value: ${value}`);
  }
  const negative = s.startsWith('-');
  const [whole = '0', frac = ''] = s.replace('-', '').split('.');
  const cents =
    Number(whole) * 100 + Number((frac + '00').slice(0, 2).padEnd(2, '0'));
  return negative ? -cents : cents;
}

export function fromCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${s}` : s;
}

export function formatKes(cents: number): string {
  const [whole = '0', frac = '00'] = fromCents(cents).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `KES ${grouped}.${frac}`;
}

/**
 * Normalises a Kenyan MSISDN to 2547XXXXXXXX / 2541XXXXXXXX.
 * Daraja sends 254-prefixed numbers, but manual imports and Tally contact
 * fields carry every other local spelling.
 */
export function normalizeMsisdn(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9 && /^[71]/.test(digits)) return `254${digits}`;
  if (digits.startsWith('254')) return digits;
  return digits;
}

/** Last 9 digits, for comparing numbers stored in inconsistent formats. */
export function msisdnTail(input: string | null | undefined): string | null {
  const n = normalizeMsisdn(input);
  return n ? n.slice(-9) : null;
}
