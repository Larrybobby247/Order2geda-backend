import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { User, Referral, Wallet } from '../models/index.js';
import { sendTemplate } from '../services/notify.js';
import { audit } from '../services/audit.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { newSecret, verifyTotp, otpauth } from '../utils/totp.js';
import { sign, requireAuth, wrap } from '../middleware/auth.js';
const r = Router();
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const reg = z.object({ fullName: z.string().min(2), email: z.string().email(), phone: z.string().min(7), password: z.string().min(8), referralCode: z.string().optional() });
r.post('/register', wrap(async (req, res) => {
  const d = reg.parse(req.body);
  if (await User.exists({ email: d.email.toLowerCase() })) return res.status(409).json({ error: 'Email already registered' });
  const referrer = d.referralCode ? await User.findOne({ referralCode: d.referralCode }) : null;
  const u = await User.create({ fullName: d.fullName, email: d.email, phone: d.phone, passwordHash: await bcrypt.hash(d.password, 12), referralCode: crypto.randomBytes(4).toString('hex').toUpperCase(), referredBy: referrer?._id });
  await Wallet.create({ user: u._id });
  if (referrer) await Referral.create({ referrer: referrer._id, referredUser: u._id, referralCode: d.referralCode });
  const vt = crypto.randomBytes(24).toString('hex'); await User.updateOne({ _id: u._id }, { verifyTokenHash: sha(vt) });
  sendTemplate(u.email, 'verifyEmail', { name: u.fullName, path: `/verify-email/${vt}` });
  res.status(201).json({ token: sign(u), user: { id: u._id, fullName: u.fullName, role: u.role, referralCode: u.referralCode } });
}));
r.post('/login', wrap(async (req, res) => {
  const u = await User.findOne({ email: String(req.body.email).toLowerCase() });
  if (!u || !(await bcrypt.compare(req.body.password || '', u.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  if (u.accountStatus !== 'ACTIVE') return res.status(403).json({ error: 'Account suspended' });
  if (u.totpEnabled) {
    if (!req.body.code) return res.json({ twoFactorRequired: true });
    if (!verifyTotp(decrypt(u.totpSecret), req.body.code)) return res.status(401).json({ error: 'Invalid authentication code' });
  }
  if (u.role !== 'CUSTOMER') await audit(u, 'LOGIN', 'User', u._id, null, { ip: req.ip });
  res.json({ token: sign(u), user: { id: u._id, fullName: u.fullName, role: u.role } });
}));
r.get('/me', requireAuth, (req, res) => res.json(req.user));
r.post('/verify-email', wrap(async (req, res) => {
  const u = await User.findOneAndUpdate({ verifyTokenHash: sha(req.body.token) }, { emailVerified: true, $unset: { verifyTokenHash: 1 } });
  u ? res.json({ verified: true }) : res.status(400).json({ error: 'Invalid or used link' });
}));
r.post('/forgot-password', wrap(async (req, res) => { // same response whether or not the email exists
  const u = await User.findOne({ email: String(req.body.email).toLowerCase() });
  if (u) { const t = crypto.randomBytes(24).toString('hex'); await User.updateOne({ _id: u._id }, { resetTokenHash: sha(t), resetExpiresAt: new Date(Date.now() + 3600e3) });
    sendTemplate(u.email, 'passwordReset', { name: u.fullName, path: `/reset-password/${t}` }); }
  res.json({ ok: true });
}));
r.post('/reset-password', wrap(async (req, res) => {
  z.string().min(8).parse(req.body.password);
  const u = await User.findOneAndUpdate({ resetTokenHash: sha(req.body.token), resetExpiresAt: { $gt: new Date() } }, { passwordHash: await bcrypt.hash(req.body.password, 12), $unset: { resetTokenHash: 1, resetExpiresAt: 1 } });
  u ? res.json({ ok: true }) : res.status(400).json({ error: 'Invalid or expired link' });
}));
const staff = (req, res, next) => (req.user.role === 'CUSTOMER' ? res.status(403).json({ error: 'Forbidden' }) : next());
r.post('/2fa/setup', requireAuth, staff, wrap(async (req, res) => { const secret = newSecret(); await User.updateOne({ _id: req.user._id }, { totpSecret: encrypt(secret), totpEnabled: false }); res.json({ secret, otpauthUrl: otpauth(req.user.email, secret) }); }));
r.post('/2fa/enable', requireAuth, staff, wrap(async (req, res) => {
  const u = await User.findById(req.user._id); if (!u.totpSecret || !verifyTotp(decrypt(u.totpSecret), req.body.code)) return res.status(400).json({ error: 'Invalid code' });
  await User.updateOne({ _id: u._id }, { totpEnabled: true }); await audit(u, '2FA_ENABLED', 'User', u._id); res.json({ enabled: true });
}));
export default r;
