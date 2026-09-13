import { useCallback, useEffect, useState } from 'react';
import { InvoicePicker } from '../components/InvoicePicker.js';
import { Confidence, StatusPill } from '../components/StatusPill.js';
import { api, formatKes, formatTime, type Transaction } from '../lib/api.js';

/**
 * The reconciliation queue: everything the matcher refused to decide by itself.
 *
 * Ambiguous items are the important ones -- the matcher found several plausible
 * invoices and deliberately stopped. The candidates are shown inline so the
 * operator can see exactly what it was torn between.
 */
export function ReviewQueue() {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { transactions } = await api.transactions({ status: 'unmatched,ambiguous', limit: 100 });
      setRows(transactions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setSelected(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      {error && <div className="error">{error}</div>}

      <div className="panel">
        <h2>
          Needs review{' '}
          <span className="muted small">
            {rows.length} payment{rows.length === 1 ? '' : 's'}
          </span>
        </h2>

        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">Nothing waiting. Every payment has been matched and posted.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Payer</th>
                <th>Reference</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Proposal</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={selected === t.id ? 'selected' : undefined}>
                  <td className="stack">
                    <span>{formatTime(t.trans_time)}</span>
                    <span className="muted small">
                      {t.trans_id} · {t.shortcode_label}
                    </span>
                  </td>
                  <td className="stack">
                    <span>{t.payer_name ?? '—'}</span>
                    <span className="muted small">{t.msisdn ?? '—'}</span>
                  </td>
                  <td>{t.bill_ref ?? <span className="muted">none</span>}</td>
                  <td className="num">{formatKes(t.amount)}</td>
                  <td>
                    <StatusPill status={t.status} />
                  </td>
                  <td>
                    {t.party_ledger ? (
                      <div className="stack">
                        <span>
                          {t.party_ledger}
                          {t.voucher_number ? ` · ${t.voucher_number}` : ''}
                        </span>
                        <Confidence value={t.confidence} />
                      </div>
                    ) : (
                      <span className="muted small">{t.review_reason ?? 'no proposal'}</span>
                    )}
                    {t.candidates && t.candidates.length > 1 && (
                      <ul className="candidates">
                        {t.candidates.map((c) => (
                          <li key={c.voucherNumber}>
                            {c.voucherNumber} · {c.partyLedger} · {formatKes(c.outstanding)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {t.match_state === 'proposed' && (
                      <button className="action primary" onClick={() => act(() => api.approve(t.id))}>
                        Approve
                      </button>
                    )}
                    <button className="action" onClick={() => setSelected(selected === t.id ? null : t.id)}>
                      Assign…
                    </button>
                    <button
                      className="action danger"
                      onClick={() => {
                        const reason = prompt('Why is this payment being set aside?');
                        if (reason) void act(() => api.ignore(t.id, reason));
                      }}
                    >
                      Ignore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <InvoicePicker
          transaction={rows.find((r) => r.id === selected)!}
          onDone={() => void act(async () => {})}
          onCancel={() => setSelected(null)}
        />
      )}
    </>
  );
}
