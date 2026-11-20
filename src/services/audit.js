import { AuditLog } from '../models/index.js';
export const audit = (actor, action, entityType, entityId, previousValues, newValues, session) =>
  AuditLog.create([{ actor: actor?._id, actorRole: actor?.role, action, entityType, entityId, previousValues, newValues }], session ? { session } : {});
