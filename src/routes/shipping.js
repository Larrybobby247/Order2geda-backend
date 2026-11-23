import { Router } from 'express';
import { z } from 'zod';
import { Room, Order, Product, User, ShippingInvoice, ShippingFeeLog, Payment } from '../models/index.js';
import { requireAuth, requireRole, wrap } from '../middleware/auth.js';
import { confirmedOrders, saveFees, publishFees, setFulfilment, payShippingInvoice } from '../services/shippingService.js';
import { httpError } from '../utils/httpError.js';
const r = Router(); r.use(requireAuth);
// ---------------- buyers ----------------
const own = '-createdBy -lastEditedBy';
r.get('/mine', wrap(async (req, res) => res.json(await ShippingInvoice.find({ customer: req.user._id, status: { $in: ['PUBLISHED', 'PAID'] } }).select(own).populate('order', 'orderReference orderStatus').populate('room', 'name').sort({ createdAt: -1 }).lean())));
r.get('/invoices/:id', wrap(async (req, res) => {
  const inv = await ShippingInvoice.findOne({ _id: req.params.id, customer: req.user._id, status: { $in: ['PUBLISHED', 'PAID'] } }).select(own).populate('room', 'name').populate('customer', 'fullName email phone deliveryAddress').lean(); if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const order = await Order.findById(inv.order).populate('products').lean(); res.json({ ...inv, order });
}));
r.post('/invoices/:id/pay', wrap(async (req, res) => { if (req.body?.acceptPolicies !== true) throw httpError(400, 'You must accept the shipping and refund policies'); res.json(await payShippingInvoice(req.params.id, req.user)); }));
// ---------------- moderators (own rooms) and admins (all rooms) ----------------
const staff = requireRole('MODERATOR', 'ADMIN');
const guard = wrap(async (req, res, next) => {
  const room = await Room.findById(req.params.roomId); if (!room) return res.status(404).json({ error: 'Room not found' });
  if (req.user.role === 'MODERATOR' && !room.assignedModerator?.equals(req.user._id)) return res.status(403).json({ error: 'This room is not assigned to you' });
  if (room.status === 'OPEN') return res.status(409).json({ error: 'Shipping opens when the room closes' });
  if (room.status === 'CANCELLED') return res.status(409).json({ error: 'This room was cancelled' });
  req.room = room; next();
});
const summary = (rows) => { const sum = (f) => rows.filter(f).reduce((s, b) => s + (b.invoice?.amount || 0), 0); return { buyers: rows.length, received: sum((b) => b.invoice?.status === 'PAID'), outstanding: sum((b) => b.invoice?.status === 'PUBLISHED'), drafts: sum((b) => b.invoice?.status === 'DRAFT'), counts: { noFee: rows.filter((b) => !b.invoice).length, draft: rows.filter((b) => b.invoice?.status === 'DRAFT').length, due: rows.filter((b) => b.invoice?.status === 'PUBLISHED').length, paid: rows.filter((b) => b.invoice?.status === 'PAID').length } }; };
r.get('/rooms/:roomId', staff, guard, wrap(async (req, res) => {
  const orders = await confirmedOrders(req.room._id).populate('customer', 'fullName phone email deliveryAddress location').populate({ path: 'products', match: { status: 'ACTIVE' }, select: 'name quantity price image productUrl' }).sort({ createdAt: 1 }).lean();
  const invs = await ShippingInvoice.find({ room: req.room._id }).lean();
  const buyers = orders.map((o) => ({ order: { _id: o._id, orderReference: o.orderReference, productSubtotal: o.productSubtotal, orderStatus: o.orderStatus }, customer: o.customer, items: o.products, invoice: invs.find((i) => i.order.equals(o._id)) || null }));
  res.json({ room: { _id: req.room._id, name: req.room.name, status: req.room.status, state: req.room.state, area: req.room.area }, buyers, totals: summary(buyers) });
}));
const fee = z.object({ orderId: z.string().length(24), amount: z.number().int().min(100).max(1e10), note: z.string().max(200).optional() }); // minimum ₦1; amounts are integer kobo
r.put('/rooms/:roomId/fees', staff, guard, wrap(async (req, res) => { const { fees } = z.object({ fees: z.array(fee).min(1).max(500) }).parse(req.body); res.json({ results: await saveFees(req.room, req.user, fees) }); }));
r.post('/rooms/:roomId/fees/bulk', staff, guard, wrap(async (req, res) => { const d = z.object({ orderIds: z.array(z.string().length(24)).min(1).max(500), amount: z.number().int().min(100).max(1e10), note: z.string().max(200).optional() }).parse(req.body); res.json({ results: await saveFees(req.room, req.user, d.orderIds.map((orderId) => ({ orderId, amount: d.amount, note: d.note }))) }); }));
r.post('/rooms/:roomId/publish', staff, guard, wrap(async (req, res) => res.json(await publishFees(req.room, req.user))));
r.post('/rooms/:roomId/fulfilment', staff, guard, wrap(async (req, res) => { const d = z.object({ orderIds: z.array(z.string().length(24)).min(1), status: z.enum(['READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED']) }).parse(req.body); res.json(await setFulfilment(req.room, req.user, d.orderIds, d.status, req.app.get('io'))); }));
r.get('/rooms/:roomId/log', staff, guard, wrap(async (req, res) => {
  const logs = await ShippingFeeLog.find({ room: req.room._id }).sort({ at: -1 }).limit(200).populate('by', 'fullName').populate('order', 'orderReference').lean(); res.json(logs);
}));
export default r;
