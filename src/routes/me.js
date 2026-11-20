import { Router } from 'express';
import { Notification, Wallet, WalletTransaction, Referral, User, Setting } from '../models/index.js';
import { requireAuth, wrap } from '../middleware/auth.js';
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
export default r;
