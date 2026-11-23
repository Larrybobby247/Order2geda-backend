import mongoose from 'mongoose';
import crypto from 'crypto';
import { Order, Product, Room, BulkOrder, Refund, Referral, WalletTransaction, Wallet, Payment, ShippingInvoice, User } from '../models/index.js';
import { pct } from '../utils/money.js';
import { hasCapacity, HOLD_MIN, GRACE_MIN } from '../utils/capacity.js';
import { httpError } from '../utils/httpError.js';
import { getSetting } from './settings.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { closeIfThresholdReached } from './roomService.js';
import { markShippingPaid } from './shippingService.js';
import * as paystack from './paystack.js';
const ref = () => 'O2G-' + crypto.randomBytes(4).toString('hex').toUpperCase();
// ---- cancel/release helpers -------------------------------------------------
export async function releasePending(orderId, reason, cancelProducts = false) {
  const o = await Order.findOneAndUpdate({ _id: orderId, paymentStatus: 'UNPAID', orderStatus: { $ne: 'CANCELLED' } }, { $set: { orderStatus: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason }, $unset: { reservedUntil: 1 } }, { new: true });
  if (!o) return null;
  await Product.updateMany({ _id: { $in: o.products }, locked: false }, cancelProducts ? { status: 'CANCELLED' } : { $unset: { order: 1 } }); return o;
}
// A product can be edited only while it is an unpaid draft and no payment is in flight for it.
export async function assertEditable(p) {
  if (p.locked) throw httpError(409, "Paid items can't be changed. Add another item instead.");
  if (!p.order) return;
  const o = await Order.findById(p.order);
  if (o && o.paymentStatus === 'UNPAID' && o.orderStatus !== 'CANCELLED') {
    if (o.reservedUntil && o.reservedUntil > new Date()) throw httpError(409, 'A payment is in progress for this item. Finish it or cancel the payment first.', 'PAYMENT_IN_PROGRESS');
    await releasePending(o._id, 'The payment window expired.');
  }
}
// ---- paying for products: capacity is held (not counted) while the member is paying ----
export async function reserveCapacity(roomId, user) {
  const session = await mongoose.startSession(); let order;
  try {
    await session.withTransaction(async () => {
      const room = await Room.findOneAndUpdate({ _id: roomId, status: 'OPEN', participants: user._id }, { $inc: { lockSeq: 1 } }, { new: true, session }); // serialises concurrent payers of one room
      if (!room) throw httpError(409, 'This room is closed or you have not joined it.');
      const drafts = await Product.find({ room: roomId, customer: user._id, status: 'ACTIVE', locked: false }).session(session);
      if (!drafts.length) throw httpError(400, 'Add at least one product first.');
      const subtotal = drafts.reduce((s, p) => s + p.price * p.quantity, 0);
      const existing = await Order.findOne({ room: roomId, customer: user._id, paymentStatus: 'UNPAID', orderStatus: { $ne: 'CANCELLED' } }).session(session);
      const now = new Date();
      const agg = await Order.aggregate([{ $match: { room: room._id, paymentStatus: 'UNPAID', orderStatus: { $ne: 'CANCELLED' }, reservedUntil: { $gt: now }, ...(existing && { _id: { $ne: existing._id } }) } }, { $group: { _id: null, t: { $sum: '$productSubtotal' } } }]).session(session);
      if (!hasCapacity({ paid: room.acceptedProductTotal, reserved: agg[0]?.t || 0, threshold: room.closingThreshold })) throw httpError(409, 'Other members are paying and this room is nearly full. Try again in a few minutes.', 'ROOM_FULL_PENDING');
      const rate = existing?.commissionRate ?? await getSetting('commissionRate'); const commission = pct(subtotal, rate);
      const f = { products: drafts.map((p) => p._id), productSubtotal: subtotal, commissionRate: rate, commissionAmount: commission, estimatedShipping: 0, totalAmount: subtotal + commission, reservedUntil: new Date(now.getTime() + HOLD_MIN * 60000) };
      if (existing) { Object.assign(existing, f); order = await existing.save({ session }); } else order = (await Order.create([{ ...f, room: roomId, customer: user._id, orderReference: ref() }], { session }))[0];
      await Product.updateMany({ _id: { $in: f.products } }, { order: order._id }, { session });
    });
  } finally { await session.endSession(); }
  return order;
}
export async function startProductPayment(roomId, user) {
  const order = await reserveCapacity(roomId, user); const reference = 'O2G-PAY-' + crypto.randomBytes(8).toString('hex');
  await Payment.create({ kind: 'PRODUCT', customer: user._id, order: order._id, providerReference: reference, amount: order.totalAmount, commissionAmount: order.commissionAmount, shippingAmount: 0 });
  const ps = await paystack.initialize(user.email, order.totalAmount, reference, `${process.env.CLIENT_URL}/app/payment/success`);
  if (!ps?.data?.authorization_url) { await Payment.updateOne({ providerReference: reference }, { status: 'FAILED' }); await Order.updateOne({ _id: order._id }, { $unset: { reservedUntil: 1 } }); throw httpError(502, 'Could not start the payment. Please try again.'); }
  return { authorizationUrl: ps.data.authorization_url, reference, order };
}
// ---- payment confirmation (idempotent; called only with Paystack-verified data) ----
export async function markPaid(reference, paidKobo, io) {
  const pay = await Payment.findOne({ providerReference: reference }); if (!pay) return null;
  if (paidKobo !== pay.amount) throw new Error('Amount mismatch');
  if (pay.kind === 'SHIPPING') return markShippingPaid(pay, io);
  const session = await mongoose.startSession(); let outcome = null;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const claimed = await Payment.findOneAndUpdate({ _id: pay._id, status: { $ne: 'SUCCESS' } }, { status: 'SUCCESS', verifiedAt: new Date() }, { session }); if (!claimed) return; // duplicate webhook/verify
      const order = await Order.findById(pay.order).session(session); const room = await Room.findById(order.room).session(session);
      const withinGrace = order.reservedUntil && Date.now() <= order.reservedUntil.getTime() + GRACE_MIN * 60000;
      const usable = order.paymentStatus === 'UNPAID' && order.orderStatus !== 'CANCELLED' && (room.status === 'OPEN' || withinGrace);
      if (usable) {
        order.set({ paymentStatus: 'PAID', paidAmount: pay.amount, orderStatus: room.status === 'OPEN' ? 'PAYMENT_COMPLETED' : 'AWAITING_SHIPPING_REVIEW', reservedUntil: undefined }); await order.save({ session });
        await Room.updateOne({ _id: order.room }, { $inc: { acceptedProductTotal: order.productSubtotal } }, { session }); // the ONLY place paid value is added to a room
        await Product.updateMany({ _id: { $in: order.products }, status: 'ACTIVE' }, { locked: true, order: order._id }, { session }); outcome = 'PAID';
      } else {
        order.set({ paymentStatus: 'PAID', paidAmount: pay.amount, orderStatus: 'CANCELLED', refundStatus: 'DUE', flaggedForAdmin: true, cancelledAt: new Date(), reservedUntil: undefined, cancellationReason: 'Your payment arrived after the room closed (or the order was cancelled). A full refund is due.' }); await order.save({ session });
        await Product.updateMany({ _id: { $in: order.products }, locked: false }, { status: 'CANCELLED' }, { session }); outcome = 'DUE';
      }
    });
  } finally { await session.endSession(); }
  if (!outcome) return pay;
  const order = await Order.findById(pay.order);
  if (outcome === 'PAID') {
    await closeIfThresholdReached(order.room, io); await creditReferral(order);
    const room = await Room.findById(order.room).select('name');
    notify(order.customer, 'payment', 'Payment successful', `Order ${order.orderReference} is paid. These items are now locked.`, { kind: 'Order', id: order._id }, io, { template: 'paymentConfirmation', data: { reference: order.orderReference, room: room?.name, subtotal: order.productSubtotal, commission: order.commissionAmount, amount: pay.amount, path: `/app/orders/${order._id}` } });
  } else {
    notify(order.customer, 'refund', 'Refund due', `Your payment for ${order.orderReference} arrived after the room closed. You are eligible for a full refund.`, { kind: 'Order', id: order._id }, io, { template: 'refund', data: { status: 'DUE', reference: order.orderReference, amount: pay.amount } });
    for (const a of await User.find({ role: 'ADMIN' }).select('_id')) notify(a._id, 'refund', 'Late payment needs a refund', `Order ${order.orderReference} was paid after its room closed. Refund due.`);
  }
  return pay;
}
async function creditReferral(order) {
  const r = await Referral.findOneAndUpdate({ referredUser: order.customer, status: 'PENDING' }, { status: 'CREDITED', qualifyingOrder: order._id, creditedAt: new Date(), rewardAmount: await getSetting('referralReward') }, { new: true }); if (!r) return;
  const w = await Wallet.findOneAndUpdate({ user: r.referrer }, { $inc: { availableBalance: r.rewardAmount } }, { upsert: true, new: true });
  await WalletTransaction.create({ wallet: w._id, user: r.referrer, type: 'CREDIT', amount: r.rewardAmount, reference: 'REF-' + r._id, description: 'Referral reward', relatedOrder: order._id });
  notify(r.referrer, 'referral', 'Referral reward credited', 'Your referral reward is in your wallet.', undefined, undefined, { template: 'referralReward', data: { amount: r.rewardAmount, path: '/app/wallet' } });
}
// Refund completion cancels ONLY this order. Transactional + idempotent.
export async function completeRefund(refundId, admin, transferReference, io) {
  const session = await mongoose.startSession(); let result, cancelled;
  try {
    await session.withTransaction(async () => {
      const refund = await Refund.findById(refundId).session(session); if (!refund) throw httpError(404, 'Not found');
      if (refund.status === 'COMPLETED') { result = refund; return; }
      if (!['APPROVED', 'PROCESSING'].includes(refund.status)) throw httpError(409, 'Refund must be approved first');
      Object.assign(refund, { status: 'COMPLETED', completedAt: new Date(), transferReference, admin: admin._id }); await refund.save({ session });
      const order = await Order.findById(refund.order).session(session); const wasActive = order.orderStatus !== 'CANCELLED';
      Object.assign(order, { orderStatus: 'CANCELLED', refundStatus: 'COMPLETED', cancelledAt: new Date(), cancellationReason: 'Refund completed' });
      const bulk = await BulkOrder.findOne({ room: order.room }).session(session); if (bulk?.placedAt) order.flaggedForAdmin = true;
      if (await ShippingInvoice.exists({ order: order._id, status: 'PAID' }).session(session)) order.flaggedForAdmin = true; // shipping was paid separately: admin must refund it too
      await order.save({ session });
      await ShippingInvoice.updateMany({ order: order._id, status: { $in: ['DRAFT', 'PUBLISHED'] } }, { status: 'VOID' }, { session });
      await Product.updateMany({ _id: { $in: order.products } }, { status: 'CANCELLED' }, { session });
      if (wasActive) await Room.updateOne({ _id: order.room, status: 'OPEN' }, { $inc: { acceptedProductTotal: -order.productSubtotal } }, { session }); // frees room capacity again
      if (bulk) await BulkOrder.updateOne({ _id: bulk._id }, { $pull: { customerOrders: order._id } }, { session });
      const rev = await Referral.findOneAndUpdate({ qualifyingOrder: order._id, status: 'CREDITED' }, { status: 'REVERSED' }, { session, new: true });
      if (rev) { const w = await Wallet.findOneAndUpdate({ user: rev.referrer }, { $inc: { availableBalance: -rev.rewardAmount } }, { session, new: true }); await WalletTransaction.create([{ wallet: w._id, user: rev.referrer, type: 'REVERSAL', amount: rev.rewardAmount, reference: 'REV-' + rev._id, description: 'Referral reversed (order refunded)', relatedOrder: order._id }], { session }); }
      await audit(admin, 'REFUND_COMPLETED', 'Refund', refund._id, { status: 'APPROVED' }, { status: 'COMPLETED', orderCancelled: order._id }, session); result = refund; cancelled = order;
    });
  } finally { await session.endSession(); }
  if (cancelled) { io?.to(`user:${cancelled.customer}`).emit('order:cancelled', { orderId: cancelled._id }); io?.to(`room:${cancelled.room}`).emit('order:cancelled', { orderId: cancelled._id }); notify(cancelled.customer, 'refund', 'Refund completed', 'Your refund is complete and your entire order has been cancelled.', { kind: 'Order', id: cancelled._id }, io, { template: 'refund', data: { status: 'COMPLETED', reference: cancelled.orderReference, amount: result.approvedAmount || result.requestedAmount, transfer: transferReference } }); }
  return result;
}
