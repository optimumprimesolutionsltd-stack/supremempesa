import { useEffect, useState } from 'react';
import { api, formatKes, type Invoice, type Transaction } from '../lib/api.js';

/**
 * Assign one payment to an invoice, or to a customer on account.
 *
 * Pre-seeded with the payment's own amount so the likely invoice surfaces
 * first -- this dialog is the whole product for a Till-only merchant, and it
 * gets used dozens of times a day.
 */
export function InvoicePicker({
  transaction,
  onDone,
  onCancel,
}: {
  transaction: Transaction;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [search, setSearch] = useState(transaction.bill_ref ?? '');
  const [byAmount, setByAmount] = useState(true);
  const [ledger, setLedger] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .invoices({ q: search || undefined, amount: byAmount ? transaction.amount : undefined })
      .then((r) => !cancelled && setInvoices(r.invoices))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [search, byAmount, transaction.amount]);

  const assign = async (body: { invoiceId?: string; partyLedger?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await api.match(transaction.id, { ...body, reason: 'assigned from review queue' });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <h2>
        Assign {formatKes(transaction.amount)} from {transaction.payer_name ?? transaction.msisdn ?? 'unknown payer'}
      </h2>

      {error && <div className="error">{error}</div>}

      <div className="row" style={{ padding: '12px 16px' }}>
        <input
          placeholder="Search invoice number or customer"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <label className="row small muted" style={{ gap: 5 }}>
          <input type="checkbox" checked={byAmount} onChange={(e) => setByAmount(e.target.checked)} />
          only exact amount
        </label>
        <button className="action" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {invoices.length === 0 ? (
        <div className="empty">No open invoices match.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Date</th>
              <th className="num">Outstanding</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <td>{inv.voucher_number}</td>
                <td>{inv.party_ledger}</td>
                <td className="muted small">{inv.invoice_date}</td>
                <td className="num">{formatKes(inv.outstanding)}</td>
                <td className="num">
                  <button className="action primary" disabled={busy} onClick={() => assign({ invoiceId: inv.id })}>
                    Allocate
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row" style={{ padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
        <span className="small muted">Or credit a customer ledger on account:</span>
        <input
          placeholder="Tally ledger name"
          value={ledger}
          onChange={(e) => setLedger(e.target.value)}
          style={{ minWidth: 200 }}
        />
        <button className="action" disabled={!ledger || busy} onClick={() => assign({ partyLedger: ledger })}>
          Post on account
        </button>
      </div>
    </div>
  );
}
