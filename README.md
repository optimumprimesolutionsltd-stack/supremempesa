# M-Pesa → TallyPrime connector

[![CI](https://github.com/optimumprimesolutionsltd-stack/supremempesa/actions/workflows/ci.yml/badge.svg)](https://github.com/optimumprimesolutionsltd-stack/supremempesa/actions/workflows/ci.yml)

Two-way M-Pesa for TallyPrime. Requests payment from a customer for a named
invoice (STK Push), auto-posts the resulting Till/Paybill confirmations as
receipt vouchers allocated against the right invoice, and queues anything it is
not certain about for one-tap human review.

```
                         ask                      pay
   dashboard ── STK Push ───► customer's handset ───► Safaricom
                                                         │
                                                         ▼
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

An STK payment skips the matcher: the push named the invoice before the
money moved, so it arrives already matched.
```

## What it does and does not decide for you

The matcher runs cheapest-and-most-certain first:

| Tier | Signal | Auto-posts? |
| --- | --- | --- |
| 0 | The payment answers an STK Push we sent for a named invoice | yes (1.00 — not an inference) |
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

You need Postgres 14+ and Redis 6.2+. If you already have them, set
`DATABASE_URL` and `REDIS_URL` and skip to `npm run migrate`.

If you do not, `docker compose up -d postgres redis` is the easy path. On a
machine with neither Docker nor admin rights, the project is set up to run
against a **portable stack** under `.devstack/` -- unpacked binaries, no
installer, no service registered, and deleting the directory removes every
trace:

```bash
# .devstack/ is ~350 MB of vendor build and is deliberately not committed.
mkdir -p .devstack && cd .devstack
curl -LO https://get.enterprisedb.com/postgresql/postgresql-16.9-1-windows-x64-binaries.zip
curl -L -o redis.zip https://github.com/redis-windows/redis-windows/releases/download/7.4.0/Redis-7.4.0-Windows-x64-msys2.zip
unzip -q postgresql-16.9-1-windows-x64-binaries.zip      # -> .devstack/pgsql
unzip -q redis.zip -d redis && mv redis/*/* redis/       # -> .devstack/redis
./pgsql/bin/initdb -D data/pg -U mpesa --pwfile=<(echo mpesa)   -E UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256
cd .. && npm run stack:start   # uses scripts/mpesa-redis.conf
./.devstack/pgsql/bin/createdb -h 127.0.0.1 -U mpesa mpesa_tally
```

Then, however you got a database:

```bash
npm run stack:start     # only for the portable stack; idempotent
npm run stack:status    # what is up, and on which port
npm run migrate
npm run seed            # demo tenant, a Paybill and a Till, five open invoices
```

Four processes. The webhook and the workers are separate on purpose — the
callback must stay fast whatever the queue is doing:

```bash
cd server && npm run mock-bridge   # stands in for TallyPrime on :5050
cd server && npm run mock-daraja   # stands in for Safaricom on :5060
cd server && npm run dev:api       # webhook + admin API on :3000
cd server && npm run dev:worker    # ingest, matching, posting, maintenance
cd dashboard && npm run dev        # :5173
```

Sign in to the dashboard with the `ADMIN_API_TOKEN` from `.env`.
`npm run stack:stop` shuts the databases down.

If something else on your machine already holds port 3000, set `API_PORT` in
`.env` -- the dashboard's dev proxy reads the same file, so both move together.
Set `PUBLIC_BASE_URL` to match, or STK callbacks will be delivered to whatever
is on the old port instead.

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

### The mock Daraja

`server/src/scripts/mockDaraja.ts` does the same for Safaricom, which matters
more than it sounds: the sandbox cannot be made to decline a PIN or go silent on
demand, and those are the cases worth testing.

```bash
MOCK_DARAJA_MODE=paid       npm run mock-daraja   # customer pays (default)
MOCK_DARAJA_MODE=cancelled  npm run mock-daraja   # customer cancels  (1032)
MOCK_DARAJA_MODE=timeout    npm run mock-daraja   # handset silent    (1037)
MOCK_DARAJA_MODE=nocallback npm run mock-daraja   # paid, but the callback is lost
```

`nocallback` is the one that earns its keep: it is the case the status-query
reconciler exists for.

### Without a live shortcode

The matcher is exercised entirely from recorded payloads — the Daraja sandbox is
too unreliable for C2B to sit in a feedback loop:

```bash
cd server && npm test          # 46 assertions, no Postgres or Redis needed
npm run replay                 # prints what the matcher decides for each fixture
```

Drop any real (anonymised) confirmation payload into `server/test/fixtures/` and
it becomes a regression case.

### Integration tests

The unit suite cannot catch the failures that actually happen. The first three
bugs found in this project all passed 31/31 unit assertions: job ids BullMQ
rejected at enqueue time, a webhook secret leaking through a log serializer, and
review candidates the dashboard could not read. So there is a second suite that
wires the real pieces together -- HTTP callback, BullMQ, Postgres, mock Bridge --
and drives payments end to end.

It truncates its database and flushes its Redis index, so give it dedicated
ones. It refuses to start unless the database name contains `test`:

```bash
cd server
createdb mpesa_tally_test     # or: .devstack/pgsql/bin/createdb.exe -h 127.0.0.1 -U mpesa mpesa_tally_test
DATABASE_URL=postgres://mpesa:mpesa@127.0.0.1:5432/mpesa_tally_test REDIS_URL=redis://127.0.0.1:6379/1 ADMIN_API_TOKEN=0123456789abcdef0123456789abcdef npm run test:integration
```

The separate Redis index matters: a dev worker on index 0 would steal the jobs
and the test would time out waiting for a receipt it never gets.

CI runs all of it on every push -- unit tests on Node 22 and 24, the dashboard
build, and the pipeline suite against real Postgres 16 and Redis 7 service
containers. See `.github/workflows/ci.yml`.

### Going live

`docs/runbook.md` covers shortcode onboarding, the six alarms worth waking up
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

**An STK payment is never matched, only recorded.** The push chose the invoice
before the money moved, so the resulting receipt is linked at confidence 1.00 --
the one case in the system where that number is a fact rather than an estimate.
The same payment also arrives as an ordinary C2B confirmation on a Paybill;
idempotency on the M-Pesa receipt number is what stops it being posted twice.

**A prompt whose callback never arrives is chased, not forgotten.** STK
callbacks go missing often enough that a reconciler queries Daraja for any
prompt past its expiry. Without it a customer who paid stays 'pending' forever
while the merchant chases money they already have.

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
  src/daraja/      C2B parsing, STK Push, OAuth, URL registration, status queries
  src/matching/    the engine (pure) + an in-memory context builder for tests
  src/services/    ingest, matching, posting, invoice sync, backstop jobs
  src/tally/       receipt voucher XML, Bridge client
  src/routes/      c2b webhook, STK callbacks, Daraja results, admin API
  test/fixtures/   recorded confirmations used by the tests and the replay tool
  test/integration/ end-to-end pipeline tests (need Postgres + Redis)
dashboard/         collect (STK), review queue, transactions + trail, variance
docs/              Bridge contract, operational runbook
.github/workflows/ CI: unit, dashboard build, end-to-end pipeline
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
