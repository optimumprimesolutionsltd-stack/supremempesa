-- M-Pesa <-> TallyPrime connector: initial schema.
-- Every business table carries tenant_id from day one (do not retrofit multi-tenancy).

CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE,
  name           text NOT NULL,
  tally_company  text NOT NULL,
  -- Outbound-only agent or tunnel endpoint for the Tally Bridge. Never a public :5050.
  bridge_url     text NOT NULL,
  bridge_token   text,
  timezone       text NOT NULL DEFAULT 'Africa/Nairobi',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE shortcode_kind AS ENUM ('paybill', 'till');

CREATE TABLE shortcodes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shortcode           text NOT NULL UNIQUE,
  kind                shortcode_kind NOT NULL,
  label               text NOT NULL,
  -- Tally ledger the money lands in (debit side of the receipt voucher).
  tally_bank_ledger   text NOT NULL,
  -- Unguessable path segment; C2B payloads are unsigned, so the URL itself is a secret.
  webhook_secret      text NOT NULL UNIQUE,
  daraja_consumer_key text,
  -- Reference into the secret store, NOT the secret itself.
  daraja_secret_ref   text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shortcodes_tenant_idx ON shortcodes (tenant_id);

-- Raw capture. Written inside the webhook request, before any parsing or matching.
CREATE TABLE raw_callbacks (
  id          bigserial PRIMARY KEY,
  shortcode   text,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,
  path        text NOT NULL,
  source_ip   text,
  headers     jsonb NOT NULL DEFAULT '{}'::jsonb,
  body        jsonb,
  body_text   text,
  trans_id    text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed   boolean NOT NULL DEFAULT false
);

CREATE INDEX raw_callbacks_trans_idx ON raw_callbacks (trans_id);
CREATE INDEX raw_callbacks_received_idx ON raw_callbacks (received_at DESC);

CREATE TYPE transaction_status AS ENUM (
  'received',    -- captured, not yet processed
  'unmatched',   -- processed, no confident match: sits in the review queue
  'ambiguous',   -- more than one candidate: never auto-posts
  'matched',     -- match approved, queued for posting
  'posted',      -- receipt voucher in Tally
  'failed',      -- posting failed after retries
  'reversed',    -- voucher reversed/cancelled
  'ignored'      -- deliberately excluded by an operator
);

CREATE TYPE transaction_source AS ENUM ('webhook', 'backstop_poll', 'manual_import');

CREATE TABLE mpesa_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shortcode_id     uuid NOT NULL REFERENCES shortcodes(id) ON DELETE RESTRICT,
  -- Safaricom's receipt number. The idempotency key for the whole pipeline.
  trans_id         text NOT NULL UNIQUE,
  trans_type       text,
  trans_time       timestamptz NOT NULL,
  amount           numeric(14, 2) NOT NULL CHECK (amount > 0),
  msisdn           text,
  payer_name       text,
  bill_ref         text,
  invoice_number   text,
  org_balance      numeric(16, 2),
  third_party_id   text,
  source           transaction_source NOT NULL DEFAULT 'webhook',
  status           transaction_status NOT NULL DEFAULT 'received',
  raw              jsonb NOT NULL,
  raw_callback_id  bigint REFERENCES raw_callbacks(id) ON DELETE SET NULL,
  -- Daraja Transaction Status cross-check (unsigned webhooks cannot be trusted alone).
  verified_at      timestamptz,
  verification     jsonb,
  received_at      timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX txn_tenant_status_idx ON mpesa_transactions (tenant_id, status, trans_time DESC);
CREATE INDEX txn_bill_ref_idx ON mpesa_transactions (tenant_id, bill_ref);
CREATE INDEX txn_msisdn_idx ON mpesa_transactions (tenant_id, msisdn);
CREATE INDEX txn_amount_time_idx ON mpesa_transactions (tenant_id, amount, trans_time);

CREATE TYPE invoice_status AS ENUM ('open', 'partial', 'closed', 'void');

-- Cache of open receivables pulled from Tally through the Bridge.
CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tally_guid      text,
  voucher_number  text NOT NULL,
  party_ledger    text NOT NULL,
  party_msisdn    text,
  invoice_date    date NOT NULL,
  amount          numeric(14, 2) NOT NULL,
  amount_settled  numeric(14, 2) NOT NULL DEFAULT 0,
  status          invoice_status NOT NULL DEFAULT 'open',
  synced_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, voucher_number)
);

CREATE INDEX invoices_open_idx ON invoices (tenant_id, status, invoice_date DESC);
CREATE INDEX invoices_party_idx ON invoices (tenant_id, party_ledger);
CREATE INDEX invoices_amount_idx ON invoices (tenant_id, amount) WHERE status IN ('open', 'partial');

-- Learned phone -> Tally party mapping, built from confirmed matches.
CREATE TABLE party_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  msisdn       text NOT NULL,
  party_ledger text NOT NULL,
  hits         integer NOT NULL DEFAULT 1,
  confirmed    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, msisdn)
);

CREATE TYPE match_method AS ENUM (
  'exact_ref',      -- BillRefNumber == invoice number
  'known_party',    -- msisdn -> ledger, single open invoice for the amount
  'amount_window',  -- exactly one open invoice with that amount in the date window
  'manual',         -- an operator picked it
  'on_account'      -- no invoice: credit the party ledger directly
);

CREATE TYPE match_state AS ENUM ('proposed', 'approved', 'rejected', 'reversed');

CREATE TABLE matches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES mpesa_transactions(id) ON DELETE CASCADE,
  invoice_id     uuid REFERENCES invoices(id) ON DELETE SET NULL,
  party_ledger   text NOT NULL,
  method         match_method NOT NULL,
  confidence     numeric(3, 2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  amount_applied numeric(14, 2) NOT NULL CHECK (amount_applied > 0),
  is_partial     boolean NOT NULL DEFAULT false,
  state          match_state NOT NULL DEFAULT 'proposed',
  candidates     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by     text NOT NULL DEFAULT 'matcher',
  created_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_by    text,
  reviewed_at    timestamptz
);

-- At most one live match per transaction; rejected/reversed ones stay for the audit trail.
CREATE UNIQUE INDEX matches_one_live_per_txn
  ON matches (transaction_id)
  WHERE state IN ('proposed', 'approved');

CREATE INDEX matches_tenant_state_idx ON matches (tenant_id, state, created_at DESC);

CREATE TYPE post_state AS ENUM ('pending', 'posted', 'failed', 'reversed');

CREATE TABLE tally_post_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id  uuid NOT NULL REFERENCES mpesa_transactions(id) ON DELETE CASCADE,
  match_id        uuid REFERENCES matches(id) ON DELETE SET NULL,
  voucher_xml     text NOT NULL,
  state           post_state NOT NULL DEFAULT 'pending',
  attempt         integer NOT NULL DEFAULT 0,
  response_status integer,
  response_body   text,
  tally_guid      text,
  voucher_number  text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Belt and braces against double-posting the same receipt into Tally.
CREATE UNIQUE INDEX tally_post_log_one_posted_per_txn
  ON tally_post_log (transaction_id)
  WHERE state = 'posted';

CREATE INDEX tally_post_log_state_idx ON tally_post_log (tenant_id, state, updated_at DESC);

-- Append-only. No UPDATE or DELETE grant should ever be issued on this table.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  action      text NOT NULL,
  actor       text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_tenant_idx ON audit_log (tenant_id, created_at DESC);
