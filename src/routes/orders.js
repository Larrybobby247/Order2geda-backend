import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Order, Payment, Refund } from '../models/index.js';
import { requireAuth, requireVerified, wrap } from '../middleware/auth.js';
import { buildCheckout, markPaid } from '../services/orderService.js';
import * as paystack from '../services/paystack.js';
const r = Router();
r.get('/', requireAuth, wrap(async (req, res) => res.json(await Order.find({ customer: req.user._id }).sort({ createdAt: -1 }).limit(50).lean())));
r.post('/checkout/:roomId', requireAuth, wrap(async (req, res) => {
  if (!req.body.acceptPolicies) return res.status(400).json({ error: 'You must accept the purchasing, shipping and refund policies' });
  res.json(await buildCheckout(req.params.roomId, req.user));
}));
r.post('/payments/verify', requireAuth, wrap(async (req, res) => {
  const v = await paystack.verify(req.body.reference);
  if (v.data?.status === 'success') await markPaid(req.body.reference, v.data.amount);
  const p = await Payment.findOne({ providerReference: req.body.reference, customer: req.user._id });
  res.json({ status: p?.status || 'UNKNOWN' }); // status from our DB only
}));
// Unpaid orders are re-priced from the current verified products before being shown, so the amount a customer sees is the amount they pay.
async function loadOrder(filter, user) {
  const o = await Order.findOne(filter); if (!o) return null;
  if (o.paymentStatus === 'UNPAID' && o.orderStatus !== 'CANCELLED') await buildCheckout(o.room, user).catch(() => {});
  return Order.findById(o._id).populate('products').lean();
}
r.get('/room/:roomId', requireAuth, wrap(async (req, res) => res.json(await loadOrder({ room: req.params.roomId, customer: req.user._id }, req.user))));
r.get('/:id', requireAuth, wrap(async (req, res) => {
  const o = await loadOrder({ _id: req.params.id, customer: req.user._id }, req.user);
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
}));
r.get('/:id/tracking', requireAuth, wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, customer: req.user._id }).select('orderStatus paymentStatus refundStatus cancelledAt updatedAt flaggedForAdmin').lean();
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
}));
r.post('/:id/pay', requireAuth, requireVerified, wrap(async (req, res) => {
  if (req.body?.acceptPolicies !== true) return res.status(400).json({ error: 'You must accept the purchasing, shipping and refund policies' });
  let o = await Order.findOne({ _id: req.params.id, customer: req.user._id });
  if (!o || o.orderStatus === 'CANCELLED') return res.status(404).json({ error: 'Not found' });
  if (o.paymentStatus === 'PAID') return res.status(409).json({ error: 'Already paid' });
  o = await buildCheckout(o.room, req.user); // refresh amounts from verified products
  if (!o.totalAmount) return res.status(409).json({ error: 'There is nothing to pay for this order' });
  const reference = 'O2G-PAY-' + crypto.randomBytes(8).toString('hex');
  await Payment.create({ customer: req.user._id, order: o._id, providerReference: reference, amount: o.totalAmount, commissionAmount: o.commissionAmount, shippingAmount: o.estimatedShipping });
  const ps = await paystack.initialize(req.user.email, o.totalAmount, reference, `${process.env.CLIENT_URL}/app/payment/success`);
  res.json({ authorizationUrl: ps.data?.authorization_url, reference });
}));
r.post('/:id/refunds', requireAuth, wrap(async (req, res) => {
  const d = z.object({ reason: z.string().min(3), description: z.string().optional(), bankName: z.string(), accountName: z.string(), accountNumber: z.string().regex(/^\d{10}$/) }).parse(req.body);
  const o = await Order.findOne({ _id: req.params.id, customer: req.user._id, paymentStatus: 'PAID', refundStatus: 'NONE' });
  if (!o) return res.status(409).json({ error: 'Order not eligible' });
  const pay = await Payment.findOne({ order: o._id, status: 'SUCCESS' });
  const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'dev-only', 'o2g', 32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); const enc = Buffer.concat([c.update(d.accountNumber), c.final()]);
  const refund = await Refund.create({ customer: req.user._id, order: o._id, originalPayment: pay?._id, requestedAmount: o.paidAmount, reason: d.reason, description: d.description, bankName: d.bankName, accountName: d.accountName, encryptedAccountNumber: [iv, c.getAuthTag(), enc].map((b) => b.toString('hex')).join('.') });
  await Order.updateOne({ _id: o._id }, { refundStatus: 'REQUESTED' });
  res.status(201).json({ ...refund.toObject(), encryptedAccountNumber: undefined });
}));
export default r;
