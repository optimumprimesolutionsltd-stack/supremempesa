-- STK Push: the outbound half of the connector.
--
-- C2B waits for a customer to pay. STK Push asks them to, against a named
-- invoice, from the dashboard. The two flows converge: a successful push
-- produces an ordinary M-Pesa receipt that lands in mpesa_transactions like any
-- other payment -- except it arrives already matched.

-- Passkey is per shortcode and is required to sign an STK request. Stored as a
-- reference into the secret store, never as the value (see lib/secrets.ts).
ALTER TABLE shortcodes
  ADD COLUMN daraja_passkey_ref text,
  -- Separate from webhook_secret so the inbound C2B path and the STK result
  -- path can be rotated independently.
  ADD COLUMN stk_callback_secret text UNIQUE;

CREATE TYPE stk_state AS ENUM (
  'pending',    -- sent to Daraja, prompt is on the customer's handset
  'success',    -- customer entered their PIN, we have a receipt
  'failed',     -- declined, wrong PIN, insufficient funds, cancelled
  'timeout',    -- no callback and no answer from the status query
  'error'       -- Daraja rejected the request itself
);

CREATE TABLE stk_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shortcode_id         uuid NOT NULL REFERENCES shortcodes(id) ON DELETE RESTRICT,
  invoice_id           uuid REFERENCES invoices(id) ON DELETE SET NULL,

  -- Daraja's two handles. CheckoutRequestID is the one that comes back on the
  -- callback and the one the status query takes.
  merchant_request_id  text,
  checkout_request_id  text UNIQUE,

  msisdn               text NOT NULL,
  amount               numeric(14, 2) NOT NULL CHECK (amount > 0),
  account_reference    text NOT NULL,
  description          text,

  state                stk_state NOT NULL DEFAULT 'pending',
  result_code          text,
  result_desc          text,

  -- Set once the customer pays; links the push to the money it produced.
  mpesa_receipt        text,
  transaction_id       uuid REFERENCES mpesa_transactions(id) ON DELETE SET NULL,

  request_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload     jsonb,
  callback_payload     jsonb,

  requested_by         text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- When the handset prompt expires. After this a status query decides it.
  expires_at           timestamptz NOT NULL DEFAULT now() + interval '2 minutes'
);

CREATE INDEX stk_tenant_state_idx ON stk_requests (tenant_id, state, created_at DESC);
CREATE INDEX stk_invoice_idx ON stk_requests (invoice_id);
CREATE INDEX stk_msisdn_idx ON stk_requests (tenant_id, msisdn, created_at DESC);

-- One live prompt per invoice. Pushing twice puts two prompts on the customer's
-- phone and invites them to pay the same invoice twice.
CREATE UNIQUE INDEX stk_one_pending_per_invoice
  ON stk_requests (invoice_id)
  WHERE state = 'pending' AND invoice_id IS NOT NULL;
