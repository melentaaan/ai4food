import { db, now } from '../db.js';
import { uid } from './util.js';

/**
 * Records privileged or money-touching actions. Readable by admins only
 * (GET /api/admin/audit) — it is the paper trail behind every stat.
 */
export function audit(req, action, entity, entityId, meta = {}) {
  db.prepare(
    `INSERT INTO audit_log (id, actor_user_id, actor_role, action, entity, entity_id, meta, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uid(),
    req?.user?.id ?? null,
    req?.user?.role ?? null,
    action,
    entity ?? null,
    entityId ?? null,
    JSON.stringify(meta ?? {}),
    req?.ip ?? null,
    now(),
  );
}
