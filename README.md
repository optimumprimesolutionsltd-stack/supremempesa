# M-Pesa → TallyPrime connector

Auto-posts M-Pesa Till/Paybill confirmations into TallyPrime as receipt
vouchers, allocated against the right customer invoice, and queues anything it
is not certain about for one-tap human review.

```
Safaricom C2B confirmation
        │  (unsigned POST, ~8s budget)
        ▼
  capture raw ──────────────► raw_callbacks     ← replayable source of truth
        │  respond {"ResultCode":0}
        ▼
  ingest (idempotent on TransID) ──► mpesa_transactions
        ▼
  matching engine ──┬── confident ──► receipt voucher ──► Tally Bridge ──► Tally
                    └── unsure ─────► review queue ──► operator ──► post
```

## What it does and does not decide for you

The matcher runs cheapest-and-most-certain first:

| Tier | Signal | Auto-posts? |
| --- | --- | --- |
| 1 | `BillRefNumber` equals an open invoice number | yes (0.99) |
| 2 | Phone number already confirmed against a Tally party | yes (0.90–0.95) |
| 3 | Exactly one open invoice for that amount, **plus** a corroborating phone or name match | yes (0.90–0.93) |
| 3 | Exactly one open invoice for that amount and nothing else | no — review (0.70) |
| — | Two or more plausible invoices | **never** — always review |
| — | Nothing matched | no — review |

Two rules are structural rather than tunable:

- **Ambiguity never auto-posts.** If two open invoices share an amount, the
  engine returns `ambiguous` with both candidates listed. A confidence score has
  no business picking between them; that is how the wrong customer gets credited.
- **Absence of evidence is not a match.** Every tier fires on a positive signal
  or falls through to the queue.

Thresholds live in `.env` (`AUTO_POST_MIN_CONFIDENCE`, `AUTO_POST_MAX_AMOUNT`),
so you can start with everything in review and loosen it once you trust it.

## Running it

Postgres and Redis are installed **portably** under `.devstack/` (no admin, no
services registered, no Docker): PostgreSQL 16.9 on 5432 and Redis 7.4.0 on
6379. Deleting that directory removes every trace of them.

```bash
npm run stack:start     # postgres + redis (idempotent; safe to re-run)
npm run migrate
npm run seed            # demo tenant, a Paybill and a Till, five open invoices
```

Four processes. The webhook and the workers are separate on purpose — the
callback must stay fast whatever the queue is doing:

```bash
cd server && npm run mock-bridge   # stands in for TallyPrime on :5050
cd server && npm run dev:api       # webhook + admin API on :3000
cd server && npm run dev:worker    # ingest, matching, posting, maintenance
cd dashboard && npm run dev        # :5173
```

Sign in to the dashboard with the `ADMIN_API_TOKEN` from `.env`.
`npm run stack:stop` shuts the databases down.

Redis 7.4 rather than the better-known 5.0 Windows port: BullMQ's delayed jobs
use `ZADD GT`, which is Redis 6.2+. The retry backoff that carries a receipt
through a closed Tally simply does not work on 5.0.

### The mock Bridge

`server/src/scripts/mockBridge.ts` implements `docs/bridge-contract.md` and
nothing else — it answers the way Tally answers, without a Tally. It exists to
make the failure modes reproducible on demand, which a real Tally never is:

```bash
MOCK_BRIDGE_MODE=down     npm run mock-bridge   # Tally closed: retryable
MOCK_BRIDGE_MODE=noledger npm run mock-bridge   # permanent error, needs a human
```

It reports success without writing a voucher anywhere. Never point a tenant at it.

### Without a live shortcode

The matcher is exercised entirely from recorded payloads — the Daraja sandbox is
too unreliable for C2B to sit in a feedback loop:

```bash
cd server && npm test          # 31 assertions, no Postgres or Redis needed
npm run replay                 # prints what the matcher decides for each fixture
```

Drop any real (anonymised) confirmation payload into `server/test/fixtures/` and
it becomes a regression case.

### Going live

`docs/runbook.md` covers shortcode onboarding, the five alarms worth waking up
for, and how to unwind a miscredit. URL registration is a deliberate manual step:

```bash
cd server && npm run register-urls -- 600638
```

## Design decisions worth knowing

**Raw capture happens before anything else.** The confirmation handler writes
the payload to `raw_callbacks` and answers `ResultCode 0` — no matching, no
Tally call, no Daraja round-trip on that thread. Safaricom retries anything slow,
and a duplicate delivery is only harmless because ingestion is idempotent on
`TransID`. If the enqueue fails afterwards, a sweeper replays the row within five
minutes.

**C2B payloads are unsigned.** Three layers stand in for a signature: an IP
allowlist, an unguessable per-shortcode secret in the callback path, and — for
anything above `VERIFY_THRESHOLD_AMOUNT` — a Daraja Transaction Status check
before the receipt is allowed to post. A confirmation Safaricom does not
recognise is a security event, not a data-quality one.

**Tally being closed is the normal case.** Posting retries with long exponential
backoff for about a day, `requeueStuckPosts` re-drives anything that fell
through, and a deterministic `REMOTEID` derived from the M-Pesa receipt number
means a retry after a timeout alters the existing voucher instead of creating a
second one. A partial unique index (`tally_post_log_one_posted_per_txn`) is the
backstop on this side.

**Money is integer cents everywhere.** `numeric` columns come back from Postgres
as strings and are parsed to cents; no balance ever passes through a float.

**Every automatic decision is auditable.** `audit_log` is append-only and records
the match method, confidence, candidates considered, and who or what acted.
Reversal is one click and re-opens the invoice allocation — support will need it.

**Tenancy from day one.** Every table carries `tenant_id`, and shortcodes,
Bridges and Daraja credentials are per tenant, so the first real customer does
not require a migration.

## Layout

```
server/
  src/daraja/      C2B payload parsing, OAuth, URL registration, status queries
  src/matching/    the engine (pure) + an in-memory context builder for tests
  src/services/    ingest, matching, posting, invoice sync, backstop jobs
  src/tally/       receipt voucher XML, Bridge client
  src/routes/      c2b webhook, Daraja result callbacks, admin API
  test/fixtures/   recorded confirmations used by the tests and the replay tool
dashboard/         review queue, transactions + audit trail, daily variance
docs/              Bridge contract, operational runbook
```

## Before this touches real money

- Replace the shared `ADMIN_API_TOKEN` with real accounts. The audit trail
  already records an operator name; right now the dashboard takes it on trust.
- Confirm Safaricom's current source IP ranges rather than trusting the sample
  in `.env.example`.
- Decide where per-tenant Daraja secrets live. `resolveSecret` reads
  `env:NAME` today and takes a Vault or Secrets Manager provider without a
  schema change — the database stores only the reference.
- Set `WEBHOOK_SILENCE_ALERT_MINUTES` above the merchant's quietest normal gap
  and route the alert somewhere a human reads.
