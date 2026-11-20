import { CompensationRule } from '../models/index.js';
// Room-specific active rule wins over the moderator's general rule; both must be effective at `at`.
export async function resolveRule(moderator, room, at = new Date()) {
  const base = { moderator, status: 'ACTIVE', effectiveFrom: { $lte: at } };
  return (await CompensationRule.findOne({ ...base, room }).sort({ effectiveFrom: -1 })) || (await CompensationRule.findOne({ ...base, room: null }).sort({ effectiveFrom: -1 }));
}
