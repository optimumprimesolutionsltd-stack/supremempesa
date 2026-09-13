# Runbook

## Going live on a new shortcode

1. Create the tenant and shortcode rows (see `src/db/seed.ts` for the shape).
   The `webhook_secret` is generated per shortcode and becomes part of the
   callback URL — treat it as a credential.
2. Put the Bridge behind a tunnel and set `tenants.bridge_url`. Confirm
   `GET {bridge_url}/health` answers before going further.
3. Run an invoice sync and check the cache looks sane:
   `POST /api/sync-invoices`, then `GET /api/invoices?tenantId=…`.
4. Register the callback URLs **last**, once the service is deployed and
   reachable over HTTPS:

   ```bash
   npm run register-urls -- 600638
   ```

   Re-running this overwrites whatever was registered. Never point a live
   shortcode at a staging deployment: Safaricom will deliver real payments
   there and they will not be redelivered.
5. Make a KES 1 test payment. It should appear in the review queue within
   seconds. Check the audit trail shows `transaction.captured`.

## The five alarms that matter

| Signal | Means | First move |
| --- | --- | --- |
| `minutesSinceLastCallback` climbing | Safaricom is not reaching us, or nobody is paying | Check the tunnel/TLS cert, then re-verify URL registration |
| `stuckPosts > 0` | Receipts matched but not in Tally for over an hour | Is Tally open? Is the Bridge reachable? Check `/api/health` |
| `failedPosts > 0` | Permanent Tally rejection | Read `post_error`: usually a missing ledger or voucher type |
| Review queue growing daily | Matching is not earning its keep for this merchant | Check whether they use Paybill references at all; consider phone→ledger seeding |
| `verification.failed` in the audit log | A confirmation Safaricom does not recognise | **Treat as an intrusion.** Rotate the webhook secret, review `raw_callbacks.source_ip` |

## Tally was closed all weekend

Expected, not an incident. Posts retry with exponential backoff for roughly a
day, and `requeueStuckPosts` re-drives anything that exhausted its attempts once
the machine is back. Nothing is lost: matches stay `approved` and the payment
stays `matched` until the voucher lands.

If it has been longer than the retry window, the dashboard's **Retry** button on
each failed transaction re-enqueues it.

## Someone was credited to the wrong account

1. Find the payment in **Transactions** (search by M-Pesa receipt number).
2. **Reverse** it, with a reason. This cancels the Tally voucher by REMOTEID,
   releases the invoice allocation, and returns the payment to the review queue.
3. **Assign…** it to the correct invoice.

Both steps are recorded in `audit_log` with the operator's name. The original
match is kept in `matches` with state `reversed` — nothing is deleted.

Note the learned `party_links` row: if the wrong link caused the miscredit,
correct it, or the next payment from that number repeats the mistake.

```sql
UPDATE party_links SET party_ledger = 'Correct Customer'
 WHERE tenant_id = $1 AND msisdn = '2547…';
```

## A payment never arrived

Check in this order:

1. `SELECT * FROM raw_callbacks WHERE trans_id = 'SI74…'` — did Safaricom ever
   reach us? If the row exists but `processed = false`, the sweeper will pick it
   up within five minutes; if it never came, the problem is upstream of us.
2. `SELECT * FROM mpesa_transactions WHERE trans_id = 'SI74…'` — captured but
   unmatched? It is in the review queue.
3. `SELECT * FROM tally_post_log WHERE transaction_id = …` — matched but not
   posted? Read `error` and `attempt`.

## Restoring after a database loss

`raw_callbacks` is the source of truth for ingestion: replaying those rows
through `ingestRawCallback` rebuilds `mpesa_transactions` exactly. Back it up
with the same care as the rest of the database, and keep the backup as long as
the accounting records it supports.

## Rotating a webhook secret

```sql
UPDATE shortcodes SET webhook_secret = encode(gen_random_bytes(24), 'hex')
 WHERE shortcode = '600638' RETURNING webhook_secret;
```

Then re-run `register-urls` for that shortcode. During the gap Safaricom is
still calling the old path; the connector captures those anyway when the body's
`BusinessShortCode` names a shortcode it serves, and logs
`captured callback on a stale webhook path`. Nothing is lost, but treat that log
line as a reminder that registration has not caught up yet.
