import { Router } from 'express';
import { Notification, Wallet, WalletTransaction, Referral, User, Setting } from '../models/index.js';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { requireAuth, wrap, sign } from '../middleware/auth.js';
const r = Router(); r.use(requireAuth);
r.get('/notifications', wrap(async (req, res) => {
  const f = { recipient: req.user._id, ...(req.query.unread && { readAt: null }) };
  const [items, unread] = await Promise.all([Notification.find(f).sort({ createdAt: -1 }).limit(50).lean(), Notification.countDocuments({ recipient: req.user._id, readAt: null })]);
  res.json({ items, unread });
}));
r.post('/notifications/read', wrap(async (req, res) => {
  const f = { recipient: req.user._id, readAt: null, ...(req.body.id && { _id: req.body.id }) };
  await Notification.updateMany(f, { readAt: new Date() }); res.json({ ok: true });
}));
// Balance is read from the wallet, which is only ever changed together with a ledger entry.
r.get('/wallet', wrap(async (req, res) => {
  const w = await Wallet.findOne({ user: req.user._id }).lean();
  const tx = await WalletTransaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50).lean();
  const earned = tx.filter((t) => t.type === 'CREDIT').reduce((s, t) => s + t.amount, 0);
  res.json({ balance: w?.availableBalance || 0, totalEarned: earned, transactions: tx });
}));
r.get('/referrals', wrap(async (req, res) => {
  const list = await Referral.find({ referrer: req.user._id }).populate('referredUser', 'fullName createdAt').lean();
  res.json({ code: req.user.referralCode, link: `${process.env.CLIENT_URL}/register?ref=${req.user.referralCode}`,
    invited: list.length, successful: list.filter((x) => x.status === 'CREDITED').length, pending: list.filter((x) => x.status === 'PENDING').length,
    rewards: list.filter((x) => x.status === 'CREDITED').reduce((s, x) => s + x.rewardAmount, 0), history: list });
}));
r.patch('/preferences', wrap(async (req, res) => {
  const { email, push, chatEmail } = req.body;
  await User.updateOne({ _id: req.user._id }, { notificationPreferences: { email: email !== false, push: push !== false, chatEmail: !!chatEmail } }); res.json({ ok: true });
}));
r.post('/push-token', wrap(async (req, res) => { await User.updateOne({ _id: req.user._id }, { $addToSet: { fcmTokens: String(req.body.token) } }); res.json({ ok: true }); }));
const SAFE = '-passwordHash -totpSecret -verifyTokenHash -resetTokenHash';
const addr = z.object({ recipientName: z.string().max(80), phone: z.string().max(20), line1: z.string().max(200), city: z.string().max(80), state: z.string().max(60), landmark: z.string().max(120) }).partial();
r.patch('/profile', wrap(async (req, res) => {
  const d = z.object({ fullName: z.string().trim().min(2).max(80).optional(), phone: z.string().trim().min(7).max(20).optional(),
    profileImage: z.string().url().startsWith('https://res.cloudinary.com/').optional(), deliveryAddress: addr.optional() }).parse(req.body);
  res.json(await User.findByIdAndUpdate(req.user._id, { $set: d }, { new: true }).select(SAFE)); // email is not editable here
}));
r.post('/change-password', wrap(async (req, res) => {
  const { currentPassword, newPassword } = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(100) }).parse(req.body);
  const u = await User.findById(req.user._id);
  if (!(await bcrypt.compare(currentPassword, u.passwordHash))) return res.status(400).json({ error: 'Your current password is incorrect' });
  u.passwordHash = await bcrypt.hash(newPassword, 12); u.passwordChangedAt = new Date(); await u.save(); // revokes every older login token
  res.json({ token: sign(u) });
}));
export default r;
