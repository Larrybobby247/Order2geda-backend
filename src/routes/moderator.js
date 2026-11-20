import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { BulkOrder, Room, Order, Product, ModeratorCompensation, ModeratorAssignment, ModeratorInvitation, User, Wallet } from '../models/index.js';
import { notify } from '../services/notify.js';
import { requireAuth, requireRole, wrap, sign } from '../middleware/auth.js';
const r = Router();
r.post('/invite/accept', wrap(async (req, res) => {
  const inv = await ModeratorInvitation.findOneAndUpdate({ tokenHash: crypto.createHash('sha256').update(req.body.token || '').digest('hex'), status: 'PENDING', expiresAt: { $gt: new Date() } }, { status: 'ACCEPTED', acceptedAt: new Date() });
  if (!inv) return res.status(400).json({ error: 'Invalid or expired invitation' }); // atomic => single use
  let u = await User.findOne({ email: inv.email });
  if (u) { if (!(await bcrypt.compare(req.body.password || '', u.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' }); u.role = 'MODERATOR'; await u.save(); }
  else { u = await User.create({ fullName: req.body.fullName, email: inv.email, phone: req.body.phone, passwordHash: await bcrypt.hash(req.body.password, 12), role: 'MODERATOR', referralCode: crypto.randomBytes(4).toString('hex').toUpperCase() }); await Wallet.create({ user: u._id }); }
  res.json({ token: sign(u) });
}));
r.use(requireAuth, requireRole('MODERATOR'));
r.get('/dashboard', wrap(async (req, res) => res.json({ activeRooms: await ModeratorAssignment.countDocuments({ moderator: req.user._id, status: 'ACTIVE' }), capacity: req.user.maxActiveRooms })));
r.get('/rooms', wrap(async (req, res) => res.json(await Room.find({ assignedModerator: req.user._id }).lean())));
const own = wrap(async (req, res, next) => (await Room.exists({ _id: req.params.roomId, assignedModerator: req.user._id })) ? next() : res.status(403).json({ error: 'Not your room' }));
r.get('/rooms/:roomId/bulk-order', own, wrap(async (req, res) => {
  const orders = await Order.find({ room: req.params.roomId, paymentStatus: 'PAID', orderStatus: { $ne: 'CANCELLED' } }).populate({ path: 'products', match: { status: 'ACTIVE', verificationStatus: { $ne: 'UNAVAILABLE' } } }).populate('customer', 'fullName').lean();
  res.json({ orders, totalValue: orders.reduce((s, o) => s + o.productSubtotal, 0), cancelledCount: await Order.countDocuments({ room: req.params.roomId, orderStatus: 'CANCELLED' }) });
}));
r.post('/rooms/:roomId/products/:pid/verify', own, wrap(async (req, res) => { await Product.updateOne({ _id: req.params.pid, room: req.params.roomId }, { verificationStatus: req.body.status, moderatorNotes: req.body.notes }); res.json({ ok: true }); }));
const FLOW = ['ROOM_CLOSED','REVIEWING_PRODUCTS','AWAITING_PAYMENT','PAYMENT_COMPLETED','PREPARING_BULK_ORDER','ORDER_PLACED','PROCESSING','SHIPPED','IN_TRANSIT','CUSTOMS_CLEARANCE','ARRIVED_IN_NIGERIA','SORTING_ORDERS','READY_FOR_COLLECTION','OUT_FOR_DELIVERY','COMPLETED'];
r.post('/rooms/:roomId/bulk-order/place', own, wrap(async (req, res) => {
  const { externalPlatform, externalOrderReference, externalShipping = 0 } = req.body;
  if (!externalOrderReference) return res.status(400).json({ error: 'externalOrderReference required' });
  const orders = await Order.find({ room: req.params.roomId, paymentStatus: 'PAID', orderStatus: { $ne: 'CANCELLED' } });
  const bulk = await BulkOrder.findOneAndUpdate({ room: req.params.roomId }, { assignedModerator: req.user._id, customerOrders: orders.map((o) => o._id), externalPlatform, externalOrderReference, externalShipping,
    totalProductValue: orders.reduce((s, o) => s + o.productSubtotal, 0), bulkOrderStatus: 'ORDER_PLACED', placedAt: new Date() }, { upsert: true, new: true });
  await Order.updateMany({ _id: { $in: bulk.customerOrders } }, { orderStatus: 'ORDER_PLACED' });
  await Room.updateOne({ _id: req.params.roomId }, { status: 'PROCESSING' });
  orders.forEach((o) => notify(o.customer, 'order', 'Bulk order placed', `Your order ${o.orderReference} has been placed.`, { kind: 'Order', id: o._id }));
  res.json(bulk);
}));
// Moves every non-cancelled paid order in the room forward; cancelled orders are never touched.
r.patch('/rooms/:roomId/status', own, wrap(async (req, res) => {
  const { status } = req.body; const bulk = await BulkOrder.findOne({ room: req.params.roomId });
  if (!bulk) return res.status(409).json({ error: 'Place the bulk order first' });
  const from = FLOW.indexOf(bulk.bulkOrderStatus), to = FLOW.indexOf(status);
  if (to < 0 || to <= from) return res.status(400).json({ error: 'Invalid status transition' });
  bulk.bulkOrderStatus = status; await bulk.save();
  await Order.updateMany({ _id: { $in: bulk.customerOrders }, orderStatus: { $ne: 'CANCELLED' } }, { orderStatus: status });
  const orders = await Order.find({ _id: { $in: bulk.customerOrders }, orderStatus: { $ne: 'CANCELLED' } }).select('customer orderReference');
  orders.forEach((o) => { req.app.get('io')?.to(`user:${o.customer}`).emit('order:updated', { orderId: o._id, status }); notify(o.customer, 'order', 'Order update', `${o.orderReference}: ${status.replace(/_/g, ' ').toLowerCase()}`, { kind: 'Order', id: o._id }); });
  if (status === 'COMPLETED') await Room.updateOne({ _id: req.params.roomId }, { status: 'COMPLETED' });
  res.json({ status });
}));
r.get('/rooms/:roomId', own, wrap(async (req, res) => res.json(await Room.findById(req.params.roomId).populate('participants', 'fullName').lean())));
r.get('/rooms/:roomId/products', own, wrap(async (req, res) => res.json(await Product.find({ room: req.params.roomId }).populate('customer', 'fullName').sort({ customer: 1 }).lean())));
r.get('/earnings', wrap(async (req, res) => res.json(await ModeratorCompensation.find({ moderator: req.user._id }).lean())));
export default r;
