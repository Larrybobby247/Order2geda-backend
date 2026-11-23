import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Order, Payment, Refund, Room, Product, ShippingInvoice, BulkOrder } from '../models/index.js';
import { requireAuth, requireVerified, wrap } from '../middleware/auth.js';
import { markPaid, startProductPayment, releasePending } from '../services/orderService.js';
import { getSetting } from '../services/settings.js';
import { pct } from '../utils/money.js';
import { httpError } from '../utils/httpError.js';
import * as paystack from '../services/paystack.js';
const r = Router();
const needPolicies = (req) => { if (req.body?.acceptPolicies !== true) throw httpError(400, 'You must accept the purchasing, shipping and refund policies'); };
const visibleInvoice = (i) => i && ['PUBLISHED', 'PAID'].includes(i.status);
r.get('/', requireAuth, wrap(async (req, res) => {
  const [orders, invs] = await Promise.all([Order.find({ customer: req.user._id }).sort({ createdAt: -1 }).limit(100).lean(), ShippingInvoice.find({ customer: req.user._id, status: { $in: ['PUBLISHED', 'PAID'] } }).select('-createdBy -lastEditedBy').lean()]);
  res.json(orders.map((o) => ({ ...o, shippingInvoice: invs.find((i) => i.order.equals(o._id)) || null })));
}));
r.post('/payments/verify', requireAuth, wrap(async (req, res) => { // works for both product and shipping payments
  const mine = await Payment.findOne({ providerReference: req.body.reference, customer: req.user._id }); if (!mine) return res.json({ status: 'UNKNOWN' });
  const v = await paystack.verify(req.body.reference);
  if (v.data?.status === 'success') await markPaid(req.body.reference, v.data.amount, req.app.get('io'));
  const p = await Payment.findById(mine._id); res.json({ status: p.status, kind: p.kind, invoice: p.invoice }); // status always comes from our DB
}));
// Everything the "pay for my items" screen needs: unpaid drafts, a server-side price preview, room capacity, paid orders.
r.get('/room/:roomId/cart', requireAuth, wrap(async (req, res) => {
  const room = await Room.findOne({ _id: req.params.roomId, participants: req.user._id }); if (!room) return res.status(403).json({ error: 'Not a member' });
  const now = new Date(); const base = { room: room._id, customer: req.user._id };
  const [items, paidOrders, pending, others, rate] = await Promise.all([Product.find({ ...base, status: 'ACTIVE', locked: false }).lean(), Order.find({ ...base, paymentStatus: 'PAID' }).sort({ createdAt: -1 }).lean(),
    Order.findOne({ ...base, paymentStatus: 'UNPAID', orderStatus: { $ne: 'CANCELLED' } }).lean(),
    Order.aggregate([{ $match: { room: room._id, customer: { $ne: req.user._id }, paymentStatus: 'UNPAID', orderStatus: { $ne: 'CANCELLED' }, reservedUntil: { $gt: now } } }, { $group: { _id: null, t: { $sum: '$productSubtotal' } } }]), getSetting('commissionRate')]);
  const subtotal = items.reduce((s, p) => s + p.price * p.quantity, 0); const commission = pct(subtotal, rate); const reserved = others[0]?.t || 0;
  res.json({ items, summary: { productSubtotal: subtotal, commissionRate: rate, commissionAmount: commission, total: subtotal + commission }, paidOrders,
    pending: pending && pending.reservedUntil > now ? { _id: pending._id, reservedUntil: pending.reservedUntil } : null,
    capacity: { paid: room.acceptedProductTotal, threshold: room.closingThreshold, remaining: Math.max(0, room.closingThreshold - room.acceptedProductTotal), available: Math.max(0, room.closingThreshold - room.acceptedProductTotal - reserved) } });
}));
r.post('/room/:roomId/pay', requireAuth, requireVerified, wrap(async (req, res) => { needPolicies(req); const { authorizationUrl, reference, order } = await startProductPayment(req.params.roomId, req.user); res.json({ authorizationUrl, reference, total: order.totalAmount }); }));
r.get('/:id', requireAuth, wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, customer: req.user._id }).populate('products').lean(); if (!o) return res.status(404).json({ error: 'Not found' });
  const [inv, bulk] = await Promise.all([ShippingInvoice.findOne({ order: o._id }).select('-createdBy -lastEditedBy').lean(), BulkOrder.findOne({ room: o.room }).select('bulkOrderStatus').lean()]);
  res.json({ ...o, shippingInvoice: visibleInvoice(inv) ? inv : null, bulkStatus: bulk?.bulkOrderStatus || null });
}));
r.get('/:id/tracking', requireAuth, wrap(async (req, res) => { const o = await Order.findOne({ _id: req.params.id, customer: req.user._id }).select('orderStatus paymentStatus refundStatus cancelledAt updatedAt flaggedForAdmin').lean(); o ? res.json(o) : res.status(404).json({ error: 'Not found' }); }));
r.post('/:id/pay', requireAuth, requireVerified, wrap(async (req, res) => { // retry paying an existing unpaid order
  needPolicies(req); const o = await Order.findOne({ _id: req.params.id, customer: req.user._id, paymentStatus: 'UNPAID', orderStatus: { $ne: 'CANCELLED' } }); if (!o) return res.status(404).json({ error: 'Not found' });
  const { authorizationUrl, reference } = await startProductPayment(o.room, req.user); res.json({ authorizationUrl, reference });
}));
r.post('/:id/cancel-payment', requireAuth, wrap(async (req, res) => { const o = await Order.findOne({ _id: req.params.id, customer: req.user._id }); if (!o) return res.status(404).json({ error: 'Not found' }); await releasePending(o._id, 'You cancelled this payment.'); res.json({ ok: true }); }));
r.post('/:id/refunds', requireAuth, wrap(async (req, res) => {
  const d = z.object({ reason: z.string().min(3), description: z.string().optional(), bankName: z.string(), accountName: z.string(), accountNumber: z.string().regex(/^\d{10}$/) }).parse(req.body);
  const o = await Order.findOne({ _id: req.params.id, customer: req.user._id, paymentStatus: 'PAID', refundStatus: { $in: ['NONE', 'DUE'] } }); if (!o) return res.status(409).json({ error: 'Order not eligible' });
  const pay = await Payment.findOne({ order: o._id, kind: 'PRODUCT', status: 'SUCCESS' });
  const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'dev-only', 'o2g', 32), iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const enc = Buffer.concat([c.update(d.accountNumber), c.final()]);
  const refund = await Refund.create({ customer: req.user._id, order: o._id, originalPayment: pay?._id, requestedAmount: o.paidAmount, reason: d.reason, description: d.description, bankName: d.bankName, accountName: d.accountName, encryptedAccountNumber: [iv, c.getAuthTag(), enc].map((b) => b.toString('hex')).join('.') });
  await Order.updateOne({ _id: o._id }, { refundStatus: 'REQUESTED' }); res.status(201).json({ ...refund.toObject(), encryptedAccountNumber: undefined });
}));
export default r;
