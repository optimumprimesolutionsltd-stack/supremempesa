const LABELS: Record<string, string> = {
  received: 'received',
  unmatched: 'needs review',
  ambiguous: 'ambiguous',
  matched: 'posting',
  posted: 'posted',
  failed: 'post failed',
  reversed: 'reversed',
  ignored: 'ignored',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${status}`}>{LABELS[status] ?? status}</span>;
}

/**
 * Confidence is shown as a bar rather than a number because operators judge it
 * relatively -- what matters is "is this one of the shaky ones", not 0.92.
 */
export function Confidence({ value }: { value: string | null }) {
  if (!value) return <span className="muted small">-</span>;
  const pct = Math.round(Number(value) * 100);
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="bar">
        <span style={{ width: `${pct}%`, background: pct >= 90 ? undefined : 'var(--warn)' }} />
      </span>
      <span className="small muted">{pct}%</span>
    </span>
  );
}
