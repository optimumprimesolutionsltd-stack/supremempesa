/** Minimal IPv4 CIDR matching. Safaricom publishes IPv4 ranges only. */

function toInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

/** Strips the ::ffff: prefix node uses for IPv4-mapped addresses. */
export function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const stripped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return stripped.trim() || null;
}

export function ipMatches(ip: string, rule: string): boolean {
  const addr = toInt(ip);
  if (addr === null) return false;

  if (!rule.includes('/')) return addr === toInt(rule);

  const [base = '', bitsRaw = ''] = rule.split('/');
  const network = toInt(base);
  const bits = Number(bitsRaw);
  if (network === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;

  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (network & mask);
}

export function ipAllowed(ip: string | undefined, rules: string[]): boolean {
  if (rules.length === 0) return true; // allowlist disabled
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  return rules.some((rule) => ipMatches(normalized, rule));
}
