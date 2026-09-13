-- Ambiguous and unmatched payments never get a `matches` row -- that is the
-- point, the matcher refused to choose. But the candidates it was torn between
-- are exactly what the operator needs to see, and they were only reachable by
-- reading audit_log. Keep them on the transaction so the review queue can show
-- its reasoning without a join into the audit trail.

ALTER TABLE mpesa_transactions
  ADD COLUMN review_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN review_reason text;
