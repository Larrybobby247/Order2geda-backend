import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { cached } from '../services/cache.js';
import { resolveRule } from '../services/compensation.js';
import { snapshot } from '../services/metrics.js';
import { queueStats } from '../services/notify.js';
import { decrypt } from '../utils/crypto.js';
import { ShippingInvoice, CompensationRule, Referral, Wallet, WalletTransaction, User, Room, Order, Payment, Refund, Setting, ModeratorInvitation, ModeratorAssignment, ModeratorCompensation } from '../models/index.js';
import { requireAuth, requireRole, wrap } from '../middleware/auth.js';
import { completeRefund } from '../services/orderService.js';
import { notify, sendTemplate } from '../services/notify.js';
import { audit } from '../services/audit.js';
import { pct } from '../utils/money.js';
const r = Router(); r.use(requireAuth, requireRole('ADMIN'));
r.get('/dashboard', wrap(async (req, res) => {
  const ship = await ShippingInvoice.aggregate([{ $match: { status: { $in: ['PUBLISHED', 'PAID'] } } }, { $group: { _id: '$status', t: { $sum: '$amount' } } }]);
  const [customers, activeRooms, orders, rev, pendingRefunds] = await Promise.all([
    User.countDocuments({ role: 'CUSTOMER' }), Room.countDocuments({ status: 'OPEN' }), Order.countDocuments(),
    Order.aggregate([{ $match: { paymentStatus: 'PAID' } }, { $group: { _id: null, gross: { $sum: '$productSubtotal' }, commission: { $sum: '$commissionAmount' } } }]),
    Refund.countDocuments({ status: 'PENDING' })]);
  res.json({ customers, activeRooms, orders, gross: rev[0]?.gross || 0, commission: rev[0]?.commission || 0, pendingRefunds, shippingReceived: ship.find((x) => x._id === 'PAID')?.t || 0, shippingOutstanding: ship.find((x) => x._id === 'PUBLISHED')?.t || 0 });
}));
r.get('/users', wrap(async (req, res) => res.json(await User.find().select('-passwordHash -totpSecret -verifyTokenHash -resetTokenHash').sort({ createdAt: -1 }).limit(100).lean())));
r.patch('/users/:id/status', wrap(async (req, res) => {
  const u = await User.findByIdAndUpdate(req.params.id, { accountStatus: req.body.status });
  await audit(req.user, 'USER_STATUS', 'User', u._id, { status: u.accountStatus }, { status: req.body.status }); res.json({ ok: true });
}));
r.get('/rooms', wrap(async (req, res) => res.json(await Room.find().sort({ createdAt: -1 }).limit(100).lean())));
r.post('/rooms/:id/assign', wrap(async (req, res) => {
  const mod = await User.findOne({ _id: req.body.moderatorId, role: 'MODERATOR', accountStatus: 'ACTIVE' });
  if (!mod) return res.status(404).json({ error: 'Moderator not found' });
  const active = await ModeratorAssignment.countDocuments({ moderator: mod._id, status: 'ACTIVE' });
  if (active >= mod.maxActiveRooms) return res.status(409).json({ error: `Moderator at capacity (${active}/${mod.maxActiveRooms})` });
  await ModeratorAssignment.updateMany({ room: req.params.id, status: 'ACTIVE' }, { status: 'RELEASED', releasedAt: new Date() });
  await ModeratorAssignment.create({ moderator: mod._id, room: req.params.id, compensationRuleSnapshot: (await resolveRule(mod._id, req.params.id))?.toObject() }); // rule as approved at assignment time
  await Room.updateOne({ _id: req.params.id }, { assignedModerator: mod._id });
  await audit(req.user, 'MODERATOR_ASSIGNED', 'Room', req.params.id, null, { moderator: mod._id }); res.json({ ok: true });
}));
r.post('/moderators/invite', wrap(async (req, res) => {
  const email = z.string().email().parse(req.body.email); const token = crypto.randomBytes(24).toString('hex');
  await ModeratorInvitation.create({ email, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3 * 864e5), invitedBy: req.user._id });
  sendTemplate(email, 'moderatorInvitation', { email, days: 3, path: `/moderator/invite/${token}` });
  res.status(201).json({ ok: true, devInviteToken: process.env.NODE_ENV === 'production' ? undefined : token });
}));
r.get('/payments', wrap(async (req, res) => res.json(await Payment.find().populate('customer', 'fullName email').populate('order', 'orderReference').sort({ createdAt: -1 }).limit(100).lean())));
r.get('/refunds', wrap(async (req, res) => res.json(await Refund.find(req.query.status ? { status: req.query.status } : {}).sort({ createdAt: -1 }).limit(100).select('-encryptedAccountNumber').lean())));
r.patch('/refunds/:id/status', wrap(async (req, res) => {
  const { status, transferReference } = req.body;
  if (status === 'COMPLETED') {
    if (!transferReference) return res.status(400).json({ error: 'transferReference required' });
    return res.json(await completeRefund(req.params.id, req.user, transferReference, req.app.get('io')));
  }
  if (!['APPROVED', 'REJECTED', 'PROCESSING'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  const rf = await Refund.findOneAndUpdate({ _id: req.params.id, status: { $ne: 'COMPLETED' } }, { status, admin: req.user._id }, { new: true });
  if (!rf) return res.status(409).json({ error: 'Already completed or not found' });
  await Order.updateOne({ _id: rf.order }, { refundStatus: status }); await audit(req.user, 'REFUND_' + status, 'Refund', rf._id);
  if (status !== 'PROCESSING') { const o = await Order.findById(rf.order).select('orderReference'); notify(rf.customer, 'refund', 'Refund ' + status.toLowerCase(), 'Your refund request was ' + status.toLowerCase() + '.', { kind: 'Order', id: rf.order }, undefined, { template: 'refund', data: { status, reference: o?.orderReference, amount: rf.requestedAmount, reason: req.body.reason } }); }
  res.json(rf);
}));
r.put('/settings/:key', wrap(async (req, res) => {
  await Setting.findOneAndUpdate({ key: req.params.key }, { value: req.body.value }, { upsert: true }); await audit(req.user, 'SETTING', 'Setting', undefined, null, { [req.params.key]: req.body.value }); res.json({ ok: true });
}));
r.post('/compensation/calculate/:roomId', wrap(async (req, res) => {
  const room = await Room.findById(req.params.roomId); let { type, rate, basis } = req.body;
  if (!room?.assignedModerator) return res.status(409).json({ error: 'No moderator assigned' });
  if (room.status !== 'COMPLETED') return res.status(409).json({ error: 'Compensation becomes eligible when the room is COMPLETED' });
  if (req.body.useRule) { const rule = await resolveRule(room.assignedModerator, room._id); if (!rule) return res.status(409).json({ error: 'No active compensation rule for this moderator/room' }); ({ compensationType: type, rate, calculationBasis: basis } = rule); }
  const agg = await Order.aggregate([{ $match: { room: room._id, paymentStatus: 'PAID', orderStatus: { $ne: 'CANCELLED' } } }, { $group: { _id: null, products: { $sum: '$productSubtotal' }, paid: { $sum: '$paidAmount' } } }]);
  const eligible = basis === 'PAID_ORDER_VALUE' ? agg[0]?.paid || 0 : agg[0]?.products || 0;
  const doc = await ModeratorCompensation.findOneAndUpdate({ moderator: room.assignedModerator, room: room._id },
    { $setOnInsert: { compensationType: type, rate, calculationBasis: type === 'FIXED' ? 'FIXED_PER_ROOM' : basis, eligibleAmount: eligible, compensationAmount: type === 'FIXED' ? rate : pct(eligible, rate) } }, { upsert: true, new: true });
  res.json(doc);
}));
r.patch('/compensation/:id', wrap(async (req, res) => {
  if (req.body.status === 'PAID' && !req.body.payoutReference) return res.status(400).json({ error: 'payoutReference required' });
  const set = req.body.status === 'PAID' ? { status: 'PAID', payoutReference: req.body.payoutReference, paidAt: new Date() } : { status: req.body.status, approvedBy: req.user._id };
  const c = await ModeratorCompensation.findByIdAndUpdate(req.params.id, set, { new: true }).populate('room', 'name');
  if (['APPROVED', 'PAID'].includes(c.status)) notify(c.moderator, 'compensation', 'Compensation ' + c.status.toLowerCase(), 'Your moderator compensation was ' + c.status.toLowerCase() + '.', undefined, undefined, { template: 'compensation', data: { status: c.status, amount: c.compensationAmount, room: c.room?.name, payoutReference: c.payoutReference } });
  res.json(c);
}));
r.get('/moderators', wrap(async (req, res) => {
  const mods = await User.find({ role: 'MODERATOR' }).select('fullName email accountStatus maxActiveRooms').lean();
  const counts = await ModeratorAssignment.aggregate([{ $match: { status: 'ACTIVE' } }, { $group: { _id: '$moderator', n: { $sum: 1 } } }]);
  res.json(mods.map((m) => ({ ...m, activeRooms: counts.find((c) => c._id.equals(m._id))?.n || 0 })));
}));
r.patch('/moderators/:id', wrap(async (req, res) => {
  const set = {}; if (req.body.maxActiveRooms) set.maxActiveRooms = Number(req.body.maxActiveRooms); if (req.body.accountStatus) set.accountStatus = req.body.accountStatus;
  await User.updateOne({ _id: req.params.id, role: 'MODERATOR' }, set); await audit(req.user, 'MODERATOR_UPDATED', 'User', req.params.id, null, set); res.json({ ok: true });
}));
r.get('/moderators/invitations', wrap(async (req, res) => res.json(await ModeratorInvitation.find().select('-tokenHash').sort({ createdAt: -1 }).limit(100).lean())));
r.post('/moderators/invitations/:id/revoke', wrap(async (req, res) => { await ModeratorInvitation.updateOne({ _id: req.params.id, status: 'PENDING' }, { status: 'REVOKED' }); res.json({ ok: true }); }));
r.get('/compensation', wrap(async (req, res) => {
  const items = await ModeratorCompensation.find().populate('moderator', 'fullName').populate('room', 'name').sort({ createdAt: -1 }).limit(100).lean();
  const sum = (st) => items.filter((i) => i.status === st).reduce((s, i) => s + i.compensationAmount, 0);
  res.json({ items, totals: { pending: sum('PENDING'), approved: sum('APPROVED'), paid: sum('PAID') } });
}));
r.get('/commissions', wrap(async (req, res) => {
  const [gross, refunded, byRoom] = await Promise.all([
    Order.aggregate([{ $match: { paymentStatus: 'PAID' } }, { $group: { _id: null, c: { $sum: '$commissionAmount' } } }]),
    Order.aggregate([{ $match: { paymentStatus: 'PAID', refundStatus: 'COMPLETED' } }, { $group: { _id: null, c: { $sum: '$commissionAmount' } } }]),
    Order.aggregate([{ $match: { paymentStatus: 'PAID', orderStatus: { $ne: 'CANCELLED' } } }, { $group: { _id: '$room', c: { $sum: '$commissionAmount' } } }, { $sort: { c: -1 } }, { $limit: 20 }])]);
  const g = gross[0]?.c || 0, f = refunded[0]?.c || 0; res.json({ gross: g, refunded: f, net: g - f, byRoom });
}));
r.get('/settings', wrap(async (req, res) => res.json(Object.fromEntries((await Setting.find().lean()).map((s) => [s.key, s.value])))));
r.get('/wallets/:userId', wrap(async (req, res) => res.json({ wallet: await Wallet.findOne({ user: req.params.userId }).lean(), transactions: await WalletTransaction.find({ user: req.params.userId }).sort({ createdAt: -1 }).limit(100).lean() })));
r.post('/wallets/:userId/adjust', wrap(async (req, res) => { // immutable ledger entry, reason mandatory
  const { amount, reason } = z.object({ amount: z.number().int().refine((n) => n !== 0), reason: z.string().min(5) }).parse(req.body);
  const w = await Wallet.findOneAndUpdate({ user: req.params.userId }, { $inc: { availableBalance: amount } }, { upsert: true, new: true });
  await WalletTransaction.create({ wallet: w._id, user: req.params.userId, type: amount > 0 ? 'CREDIT' : 'DEBIT', amount: Math.abs(amount), reference: 'ADJ-' + crypto.randomBytes(6).toString('hex'), description: 'Admin adjustment: ' + reason });
  await audit(req.user, 'WALLET_ADJUSTMENT', 'Wallet', w._id, null, { amount, reason }); res.json(w);
}));
r.post('/announcements', wrap(async (req, res) => {
  const { title, body } = z.object({ title: z.string().min(2), body: z.string().min(2) }).parse(req.body);
  const users = await User.find({ accountStatus: 'ACTIVE' }).select('_id').lean(); users.forEach((u) => notify(u._id, 'announcement', title, body)); res.json({ queued: users.length });
}));
r.post('/rooms/:id/status', wrap(async (req, res) => {
  const { status, reason } = z.object({ status: z.enum(['CLOSED', 'CANCELLED']), reason: z.string().min(5) }).parse(req.body);
  const prev = await Room.findOneAndUpdate({ _id: req.params.id, status: { $in: ['OPEN', 'CLOSED'] } }, { status, closedAt: new Date() });
  if (!prev) return res.status(409).json({ error: 'Room cannot be changed from its current status' });
  await audit(req.user, 'ROOM_' + status, 'Room', prev._id, { status: prev.status }, { status, reason });
  req.app.get('io')?.to(`room:${prev._id}`).emit('room:closed', { roomId: prev._id }); res.json({ ok: true }); // refunds for paid orders are handled separately by an admin
}));
r.get('/compensation/rules', wrap(async (req, res) => res.json(await CompensationRule.find().populate('moderator', 'fullName').populate('room', 'name').sort({ createdAt: -1 }).limit(100).lean())));
r.post('/compensation/rules', wrap(async (req, res) => {
  const d = z.object({ moderatorId: z.string(), roomId: z.string().optional(), type: z.enum(['PERCENTAGE', 'FIXED']), rate: z.number().positive(), basis: z.enum(['PRODUCT_VALUE', 'PAID_ORDER_VALUE', 'FIXED_PER_ROOM']), effectiveFrom: z.string().optional() })
    .refine((x) => x.type !== 'PERCENTAGE' || x.rate <= 100, 'Percentage cannot exceed 100').parse(req.body);
  const rule = await CompensationRule.create({ moderator: d.moderatorId, room: d.roomId || undefined, compensationType: d.type, rate: d.rate, calculationBasis: d.type === 'FIXED' ? 'FIXED_PER_ROOM' : d.basis, effectiveFrom: d.effectiveFrom ? new Date(d.effectiveFrom) : new Date(), createdBy: req.user._id });
  await audit(req.user, 'COMPENSATION_RULE_CREATED', 'CompensationRule', rule._id, null, rule.toObject()); res.status(201).json(rule);
}));
r.patch('/compensation/rules/:id/deactivate', wrap(async (req, res) => { await CompensationRule.updateOne({ _id: req.params.id }, { status: 'INACTIVE' }); await audit(req.user, 'COMPENSATION_RULE_DEACTIVATED', 'CompensationRule', req.params.id); res.json({ ok: true }); }));
r.get('/refunds/:id/bank', wrap(async (req, res) => { // decrypted on demand, every view is audit-logged
  const rf = await Refund.findById(req.params.id); if (!rf) return res.status(404).json({ error: 'Not found' });
  await audit(req.user, 'BANK_DETAILS_VIEWED', 'Refund', rf._id); res.json({ bankName: rf.bankName, accountName: rf.accountName, accountNumber: decrypt(rf.encryptedAccountNumber) });
}));
r.get('/analytics', wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365); const since = new Date(Date.now() - days * 864e5);
  const d = (f) => ({ $dateToString: { format: '%Y-%m-%d', date: f } });
  res.json(await cached(`admin:analytics:${days}`, 60, async () => {
    const [revenue, signups, orders, rooms, workload, referrals] = await Promise.all([
      Payment.aggregate([{ $match: { status: 'SUCCESS', verifiedAt: { $gte: since } } }, { $group: { _id: d('$verifiedAt'), amount: { $sum: '$amount' }, commission: { $sum: '$commissionAmount' } } }, { $sort: { _id: 1 } }]),
      User.aggregate([{ $match: { role: 'CUSTOMER', createdAt: { $gte: since } } }, { $group: { _id: d('$createdAt'), n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Order.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: d('$createdAt'), n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Room.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      ModeratorAssignment.aggregate([{ $match: { status: 'ACTIVE' } }, { $group: { _id: '$moderator', n: { $sum: 1 } } }, { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } }, { $project: { n: 1, name: { $arrayElemAt: ['$u.fullName', 0] } } }]),
      Referral.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])]);
    return { revenue, signups, orders, rooms, workload, referrals };
  }));
}));
r.get('/metrics', wrap(async (req, res) => res.json({ ...snapshot(), sockets: req.app.get('io')?.engine?.clientsCount ?? 0, emailQueue: await queueStats() })));
export default r;
