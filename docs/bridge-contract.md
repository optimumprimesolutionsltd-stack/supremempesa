# Tally Bridge contract

The connector never talks to TallyPrime directly. It talks to **your existing
Bridge**, which runs on (or next to) the Windows machine where Tally is open.
This document is the contract the connector expects; adapt the Bridge to it, or
adapt `src/tally/bridge.ts` to the Bridge — but write it down either way.

## Network shape

Tally listens on `localhost:9000` and the Bridge has historically been a
LAN-only service on `:5050`. The connector is now a cloud service, which changes
the threat model: **do not port-forward 5050 to the internet.** Pick one:

| Option | How | Notes |
| --- | --- | --- |
| Tunnel (recommended to start) | `cloudflared` / `tailscale funnel` from the Tally machine | No inbound firewall rule; the tenant's `bridge_url` is the tunnel hostname |
| mTLS over a fixed hostname | Client cert on the connector, server cert on the Bridge | Works if the site has a static IP and someone to rotate certs |
| Outbound-only agent | Bridge polls the connector for pending vouchers | Most robust for SMEs on dynamic IPs; needs a queue endpoint on this side |

`tenants.bridge_url` holds the base URL and `tenants.bridge_token` a bearer
token sent on every request. The token is per tenant, not global.

## Endpoints

### `GET /health`

Returns 200 while Tally is reachable and the configured company is open.
Anything ≥ 500 (or a connection failure) is read as "Tally is down, retry later"
rather than "this receipt is bad".

```json
{ "ok": true, "company": "Demo Traders Ltd", "tallyVersion": "TallyPrime 4.1" }
```

### `POST /import`

Body: `text/xml` — a complete Tally `<ENVELOPE>` import request, built by
`src/tally/voucher.ts`. The Bridge forwards it to Tally unchanged and returns
Tally's response body verbatim.

Do **not** have the Bridge interpret, rewrite, or "fix" the XML. The connector
asserts on the response, and a helpful Bridge that silently retries or edits
vouchers makes double-posting undetectable from this side.

Expected response (Tally's own):

```xml
<RESPONSE>
  <CREATED>1</CREATED>
  <ALTERED>0</ALTERED>
  <DELETED>0</DELETED>
  <LASTVCHID>4211</LASTVCHID>
  <ERRORS>0</ERRORS>
</RESPONSE>
```

The connector treats `CREATED=0 AND ALTERED=0` as a failure even on HTTP 200 —
a `<LINEERROR>` mentioning a missing ledger is a permanent failure that goes to
a human, everything else is retried.

### `GET /outstanding?company=<name>`

Returns open receivables, used to refresh the local invoice cache every ten
minutes. Either shape is accepted:

```json
{
  "bills": [
    {
      "voucherNumber": "INV-1003",
      "partyLedger": "Kimani Wholesalers",
      "partyMsisdn": "0712345678",
      "invoiceDate": "2026-09-01",
      "amount": "7250.00",
      "amountSettled": "0.00",
      "tallyGuid": "b4f3…-0000000c"
    }
  ]
}
```

Rules:

- Amounts are **fixed-2dp strings**, not floats. The connector parses to integer
  cents and never round-trips through a JS number.
- `voucherNumber` must be exactly what the customer would type as the M-Pesa
  account number. It is the join key for tier-1 matching.
- `partyMsisdn` is optional but valuable: it is the corroborating signal that
  lets a Till-only payment auto-post instead of queueing for review.
- Include partially settled bills with their `amountSettled`, not just the
  untouched ones.

## Idempotency

Every receipt carries a `<REMOTEID>` derived deterministically from the M-Pesa
receipt number (`remoteIdFor(transId)`). If a post times out after Tally has
already committed, the retry carries the same REMOTEID and Tally alters that
voucher rather than creating a second one.

The Bridge must pass REMOTEID through untouched. If your Tally configuration
strips it, say so — the connector's database guard (`tally_post_log_one_posted_per_txn`)
still prevents double-posting from this side, but the Tally-side guarantee is
what covers a crash mid-request.

## Reversals

`buildCancelVoucherXml` sends `ACTION="Cancel"` for the same REMOTEID. Tally
keeps a cancelled voucher in the numbering sequence, which is the correct
accounting behaviour — the money movement is undone without leaving a hole an
auditor has to explain.
