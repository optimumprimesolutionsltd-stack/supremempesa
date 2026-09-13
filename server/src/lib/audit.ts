import type { Sql } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { logger } from './logger.js';

export interface AuditEntry {
  tenantId: string | null;
  entityType: 'transaction' | 'match' | 'post' | 'invoice' | 'shortcode' | 'system';
  entityId: string;
  action: string;
  actor: string;
  data?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Every automatic decision and every operator action
 * lands here: when a customer is miscredited, this is what support unwinds from.
 * Never throws into the caller's path -- a failed audit write is logged loudly
 * but must not roll back a posted receipt.
 */
export async function audit(entry: AuditEntry, client: Sql = pool): Promise<void> {
  try {
    await client.query(
      `INSERT INTO audit_log (tenant_id, entity_type, entity_id, action, actor, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.tenantId,
        entry.entityType,
        entry.entityId,
        entry.action,
        entry.actor,
        JSON.stringify(entry.data ?? {}),
      ],
    );
  } catch (err) {
    logger.error({ err, entry }, 'AUDIT WRITE FAILED');
  }
}
