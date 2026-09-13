import { useCallback, useEffect, useState } from 'react';
import { api, formatKes, formatTime, type Invoice, type StkRequest } from '../lib/api.js';

/**
 * The outbound half: ask a customer to pay, instead of waiting for them to.
 *
 * A payment collected this way never reaches the review queue -- the invoice
 * was named before the money moved, so there is nothing left to work out.
 */
export function Collect() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [requests, setRequests] = useState<StkRequest[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [inv, stk] = await Promise.all([
        api.invoices({ q: search || undefined }),
        api.stkRequests(),
      ]);
      setInvoices(inv.invoices);
      setRequests(stk.requests);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  // A prompt lives on the handset for about a minute; poll while any is open.
  useEffect(() => {
    if (!requests.some((r) => r.state === 'pending')) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [requests, load]);

  const requestPayment = async (invoice: Invoice) => {
    const phone =
      invoice.party_msisdn ??
      prompt(`No phone number on file for ${invoice.party_ledger}. Enter one:`);
    if (!phone) return;

    setBusy(invoice.id);
    setError(null);
    setNotice(null);
    try {
      const res = await api.requestPayment(invoice.id, { msisdn: phone });
      // A refusal here is usually a business fact, not a fault: already
      // settled, a prompt already on the phone, cents that STK cannot collect.
      if (res.status === 'sent') {
        setNotice(`Prompt sent to ${phone} for ${invoice.voucher_number}. Waiting for the customer…`);
      } else {
        setError(res.reason ?? 'the prompt could not be sent');
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error && <div className="error">{error}</div>}
      {notice && (
        <div className="error" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          {notice}
        </div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          placeholder="Search invoice number or customer"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button className="action" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <h2>
          Open invoices <span className="muted small">ask the customer to pay</span>
        </h2>
        {invoices.length === 0 ? (
          <div className="empty">Nothing outstanding.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Phone</th>
                <th>Date</th>
                <th className="num">Outstanding</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const pending = requests.some(
                  (r) => r.state === 'pending' && r.voucher_number === inv.voucher_number,
                );
                return (
                  <tr key={inv.id}>
                    <td>{inv.voucher_number}</td>
                    <td>{inv.party_ledger}</td>
                    <td className="muted small">{inv.party_msisdn ?? 'not on file'}</td>
                    <td className="muted small">{inv.invoice_date}</td>
                    <td className="num">{formatKes(inv.outstanding)}</td>
                    <td className="num">
                      <button
                        className="action primary"
                        disabled={busy === inv.id || pending}
                        onClick={() => void requestPayment(inv)}
                      >
                        {pending ? 'Prompt sent' : busy === inv.id ? 'Sending…' : 'Request payment'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>
          Payment prompts{' '}
          <button
            className="action"
            style={{ float: 'right', marginTop: -4 }}
            onClick={() =>
              void api
                .reconcileStk()
                .then((r) => setNotice(`Checked with M-Pesa: ${r.settled} prompt(s) settled`))
                .then(load)
                .catch((e) => setError((e as Error).message))
            }
          >
            Chase unanswered
          </button>
        </h2>
        {requests.length === 0 ? (
          <div className="empty">No payment prompts sent yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Sent</th>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Phone</th>
                <th className="num">Amount</th>
                <th>Outcome</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="stack">
                    <span className="muted small">{formatTime(r.created_at)}</span>
                    <span className="muted small">by {r.requested_by}</span>
                  </td>
                  <td>{r.voucher_number ?? r.account_reference}</td>
                  <td>{r.party_ledger ?? '—'}</td>
                  <td className="muted small">{r.msisdn}</td>
                  <td className="num">{formatKes(r.amount)}</td>
                  <td>
                    <StkState request={r} />
                  </td>
                  <td className="stack">
                    <span>{r.mpesa_receipt ?? '—'}</span>
                    {r.transaction_status && (
                      <span className="muted small">{r.transaction_status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function StkState({ request }: { request: StkRequest }) {
  const cls =
    request.state === 'success'
      ? 'posted'
      : request.state === 'pending'
        ? 'matched'
        : request.state === 'timeout'
          ? 'unmatched'
          : 'failed';

  const label =
    request.state === 'pending' ? 'on the handset…' : request.state === 'success' ? 'paid' : request.state;

  return (
    <div className="stack">
      <span className={`pill ${cls}`}>{label}</span>
      {request.state !== 'success' && request.result_desc && (
        <span className="muted small">{request.result_desc}</span>
      )}
    </div>
  );
}
