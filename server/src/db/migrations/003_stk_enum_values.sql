-- Enum values only. Postgres allows ALTER TYPE ... ADD VALUE inside a
-- transaction, but the new label cannot be USED until that transaction commits.
-- Since the migration runner wraps each file in one transaction, the values and
-- everything that references them have to live in separate files.

ALTER TYPE transaction_source ADD VALUE IF NOT EXISTS 'stk_push';

-- An STK payment needs no matching: the push named the invoice, so the link is
-- known before the money moves. It is recorded as a match anyway, so that every
-- posted receipt has the same shape of audit trail behind it.
ALTER TYPE match_method ADD VALUE IF NOT EXISTS 'stk_push';
