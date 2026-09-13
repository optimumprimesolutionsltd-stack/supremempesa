import { Fragment, useCallback, useEffect, useState } from 'react';
import { Confidence, StatusPill } from '../components/StatusPill.js';
import { api, formatKes, formatTime, type Transaction } from '../lib/api.js';

const STATUSES = ['', 'posted', 'matched', 'unmatched', 'ambiguous', 'failed', 'ignored', 'reversed'];

export function Transactions() {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [trail, setTrail] = useState<Array<{ action: string; actor: string; created_at: string; data: Record<string, unknown> }>>([]);

  const load = useCallback(async () => {
    try {
      const { transactions } = await api.transactions({ status: status || undefined, q: q || undefined, limit: 100 });
      setRows(transactions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [status, q]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (id: string) => {
    if (detail === id) {
      setDetail(null);
      return;
    }
    setDetail(id);
    try {
      const res = await api.transaction(id);
      setTrail(res.auditTrail);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      {error && <div className="error">{error}</div>}

      <div className="row" style={{ marginBottom: 12 }}>
        <input placeholder="Search receipt, phone, reference or name" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'All statuses' : s}
            </option>
          ))}
        </select>
        <button className="action" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="panel">
        <h2>Transactions</h2>
        {rows.length === 0 ? (
          <div className="empty">No transactions match.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Receipt</th>
                <th>Payer</th>
                <th className="num">Amount</th>
                <th>Posted to</th>
                <th>Confidence</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <Fragment key={t.id}>
                  <tr className={detail === t.id ? 'selected' : undefined}>
                    <td className="muted small">{formatTime(t.trans_time)}</td>
                    <td>{t.trans_id}</td>
                    <td className="stack">
                      <span>{t.payer_name ?? '—'}</span>
                      <span className="muted small">{t.msisdn ?? '—'}</span>
                    </td>
                    <td className="num">{formatKes(t.amount)}</td>
                    <td className="stack">
                      <span>{t.party_ledger ?? '—'}</span>
                      {t.voucher_number && <span className="muted small">{t.voucher_number}</span>}
                    </td>
                    <td>
                      <Confidence value={t.confidence} />
                    </td>
                    <td>
                      <StatusPill status={t.status} />
                      {t.post_error && (
                        <div className="muted small" title={t.post_error}>
                          attempt {t.post_attempt}
                        </div>
                      )}
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      <button className="action" onClick={() => void openDetail(t.id)}>
                        {detail === t.id ? 'Hide' : 'Trail'}
                      </button>
                      {t.status === 'failed' && (
                        <button className="action" onClick={() => act(() => api.retryPost(t.id))}>
                          Retry
                        </button>
                      )}
                      {t.status === 'posted' && (
                        <button
                          className="action danger"
                          onClick={() => {
                            const reason = prompt('Why is this receipt being reversed?');
                            if (reason) void act(() => api.reverse(t.id, reason));
                          }}
                        >
                          Reverse
                        </button>
                      )}
                      {(t.status === 'unmatched' || t.status === 'ambiguous') && (
                        <button className="action" onClick={() => act(() => api.rematch(t.id))}>
                          Re-match
                        </button>
                      )}
                    </td>
                  </tr>
                  {detail === t.id && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--bg)' }}>
                        <strong className="small">Audit trail</strong>
                        <table style={{ marginTop: 6 }}>
                          <tbody>
                            {trail.map((e, i) => (
                              <tr key={i}>
                                <td className="muted small" style={{ width: 170 }}>
                                  {formatTime(e.created_at)}
                                </td>
                                <td className="small" style={{ width: 190 }}>
                                  {e.action}
                                </td>
                                <td className="muted small" style={{ width: 110 }}>
                                  {e.actor}
                                </td>
                                <td className="muted small">
                                  <code>{JSON.stringify(e.data)}</code>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
