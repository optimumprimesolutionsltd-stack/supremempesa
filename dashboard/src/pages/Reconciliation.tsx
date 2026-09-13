import { useEffect, useState } from 'react';
import { api, formatKes, type Tenant, type VarianceRow } from '../lib/api.js';

/**
 * Daily M-Pesa versus Tally variance.
 *
 * This is the number that decides whether anyone keeps using the product: if
 * the variance column is not zero by the end of the day, money arrived that
 * never reached the books, and the operator needs to know before the accountant
 * finds it a month later.
 */
export function Reconciliation() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [rows, setRows] = useState<VarianceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    api
      .tenants()
      .then((r) => {
        setTenants(r.tenants);
        if (r.tenants[0]) setTenantId(r.tenants[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    api
      .variance(tenantId, 14)
      .then((r) => setRows(r.variance))
      .catch((e) => setError(e.message));
  }, [tenantId]);

  const sync = async () => {
    setSyncing(true);
    try {
      await api.syncInvoices();
      if (tenantId) setRows((await api.variance(tenantId, 14)).variance);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const tenant = tenants.find((t) => t.id === tenantId);

  return (
    <>
      {error && <div className="error">{error}</div>}

      <div className="row" style={{ marginBottom: 12 }}>
        <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button className="action" onClick={() => void sync()} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync invoices from Tally'}
        </button>
        {tenant && (
          <span className="muted small">
            Tally company: {tenant.tally_company} ·{' '}
            {tenant.shortcodes.map((s) => `${s.label} → ${s.bankLedger}`).join(' · ')}
          </span>
        )}
      </div>

      <div className="panel">
        <h2>Daily variance · M-Pesa received vs posted to Tally</h2>
        {rows.length === 0 ? (
          <div className="empty">No payments in the last 14 days.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Payments</th>
                <th className="num">M-Pesa total</th>
                <th className="num">Posted to Tally</th>
                <th className="num">Variance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const variance = Number(r.variance);
                return (
                  <tr key={r.day}>
                    <td>{r.day}</td>
                    <td className="num muted">
                      {r.posted_count} / {r.txn_count}
                    </td>
                    <td className="num">{formatKes(r.mpesa_total)}</td>
                    <td className="num">{formatKes(r.posted_total ?? '0')}</td>
                    <td className="num" style={{ color: variance > 0 ? 'var(--danger)' : 'var(--accent)', fontWeight: 600 }}>
                      {variance > 0 ? formatKes(r.variance) : 'clear'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
