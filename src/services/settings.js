import { Setting } from '../models/index.js';
const defaults = { commissionRate: 10, bufferPercentage: 5, maxBufferPercentage: 10, referralReward: 50000, moderatorCapacity: 5 };
export async function getSetting(key) { const s = await Setting.findOne({ key }).lean(); return s ? s.value : defaults[key]; }
