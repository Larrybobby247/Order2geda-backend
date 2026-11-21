import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';
export const sign = (u) => jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
export async function requireAuth(req, res, next) {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET);
    const u = await User.findById(p.id).select('-passwordHash -totpSecret -verifyTokenHash -resetTokenHash');
    if (!u || u.accountStatus !== 'ACTIVE' || (u.passwordChangedAt && (p.iat + 1) * 1000 <= u.passwordChangedAt.getTime())) return res.status(401).json({ error: 'Unauthorized' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}
export const requireRole = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' });
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Enforced when REQUIRE_EMAIL_VERIFICATION=true (enable once Resend is configured). Staff are exempt.
export const requireVerified = (req, res, next) =>
  process.env.REQUIRE_EMAIL_VERIFICATION !== 'true' || req.user.emailVerified || req.user.role !== 'CUSTOMER' ? next() : res.status(403).json({ error: 'Please verify your email first' });
