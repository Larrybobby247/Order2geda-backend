import mongoose from 'mongoose';
import crypto from 'crypto';
import { Order, Product, Room, BulkOrder, Refund, Referral, WalletTransaction, Wallet, Payment } from '../models/index.js';
import { pct, shippingShare } from '../utils/money.js';
import { getSetting } from './settings.js';
import { audit } from './audit.js';
import { notify } from './notify.js';

export async function buildCheckout(roomId, user) {
  const room = await Room.findById(roomId);
  if (!room || room.status === 'OPEN') throw Object.assign(new Error('Room must be closed before checkout'), { status: 409 });
  const products = await Product.find({ room: roomId, customer: user._id, status: 'ACTIVE', verificationStatus: { $in: ['PENDING', 'VERIFIED'] } });
  const subtotal = products.reduce((s, p) => s + p.price * p.quantity, 0);
  const order = await Order.findOne({ room: roomId, customer: user._id });
  if (order && (order.paymentStatus === 'PAID' || order.orderStatus === 'CANCELLED')) return order;
  const rate = order?.commissionRate ?? await getSetting('commissionRate'); // keep rate stable once set
  const f = { products: products.map((p) => p._id), productSubtotal: subtotal, commissionRate: rate, commissionAmount: pct(subtotal, rate), estimatedShipping: order?.estimatedShipping || 0 };
  f.totalAmount = subtotal + f.commissionAmount + f.estimatedShipping + (order?.otherCharges || 0) - (order?.walletCreditUsed || 0);
  if (order) { Object.assign(order, f); return order.save(); }
  return Order.create({ ...f, room: roomId, customer: user._id, orderReference: 'O2G-' + crypto.randomBytes(4).toString('hex').toUpperCase() });
}
export async function allocateShipping(roomId, totalShipping) {
  const orders = await Order.find({ room: roomId, orderStatus: { $ne: 'CANCELLED' }, paymentStatus: 'UNPAID' });
  const group = orders.reduce((s, o) => s + o.productSubtotal, 0);
  for (const o of orders) {
    o.estimatedShipping = shippingShare(totalShipping, o.productSubtotal, group);
    o.totalAmount = o.productSubtotal + o.commissionAmount + o.estimatedShipping + o.otherCharges - o.walletCreditUsed;
    await o.save();
  }
}
// Idempotent; only called with provider-verified data.
export async function markPaid(reference, paidKobo) {
  const pay = await Payment.findOne({ providerReference: reference });
  if (!pay) return null;
  if (paidKobo !== pay.amount) throw new Error('Amount mismatch');
  const claimed = await Payment.findOneAndUpdate({ _id: pay._id, status: { $ne: 'SUCCESS' } }, { status: 'SUCCESS', verifiedAt: new Date() });
  if (!claimed) return pay;
  const order = await Order.findOneAndUpdate({ _id: pay.order, orderStatus: { $ne: 'CANCELLED' } }, { paymentStatus: 'PAID', paidAmount: pay.amount, orderStatus: 'PAYMENT_COMPLETED' }, { new: true });
  if (order) {
    await creditReferral(order);
    const room = await Room.findById(order.room).select('name');
    notify(order.customer, 'payment', 'Payment successful', `Order ${order.orderReference} is paid.`, { kind: 'Order', id: order._id }, undefined,
      { template: 'paymentConfirmation', data: { reference: order.orderReference, room: room?.name, subtotal: order.productSubtotal, commission: order.commissionAmount, shipping: order.estimatedShipping, amount: pay.amount } });
  }
  return pay;
}
async function creditReferral(order) {
  const ref = await Referral.findOneAndUpdate({ referredUser: order.customer, status: 'PENDING' }, { status: 'CREDITED', qualifyingOrder: order._id, creditedAt: new Date(), rewardAmount: await getSetting('referralReward') }, { new: true });
  if (!ref) return;
  const w = await Wallet.findOneAndUpdate({ user: ref.referrer }, { $inc: { availableBalance: ref.rewardAmount } }, { upsert: true, new: true });
  await WalletTransaction.create({ wallet: w._id, user: ref.referrer, type: 'CREDIT', amount: ref.rewardAmount, reference: 'REF-' + ref._id, description: 'Referral reward', relatedOrder: order._id });
  notify(ref.referrer, 'referral', 'Referral reward credited', 'Your referral reward is in your wallet.', undefined, undefined, { template: 'referralReward', data: { amount: ref.rewardAmount, path: '/app/wallet' } });
}
// Refund completion cancels ONLY this customer's entire order. Transactional + idempotent.
export async function completeRefund(refundId, admin, transferReference, io) {
  const session = await mongoose.startSession(); let result, cancelled;
  try {
    await session.withTransaction(async () => {
      const refund = await Refund.findById(refundId).session(session);
      if (!refund) throw Object.assign(new Error('Not found'), { status: 404 });
      if (refund.status === 'COMPLETED') { result = refund; return; }
      if (!['APPROVED', 'PROCESSING'].includes(refund.status)) throw Object.assign(new Error('Refund must be approved first'), { status: 409 });
      Object.assign(refund, { status: 'COMPLETED', completedAt: new Date(), transferReference, admin: admin._id }); await refund.save({ session });
      const order = await Order.findById(refund.order).session(session);
      Object.assign(order, { orderStatus: 'CANCELLED', refundStatus: 'COMPLETED', cancelledAt: new Date(), cancellationReason: 'Refund completed' });
      const bulk = await BulkOrder.findOne({ room: order.room }).session(session);
      if (bulk?.placedAt) order.flaggedForAdmin = true; // external purchase needs manual resolution
      await order.save({ session });
      await Product.updateMany({ _id: { $in: order.products } }, { status: 'CANCELLED' }, { session }); // retained for history
      if (bulk) await BulkOrder.updateOne({ _id: bulk._id }, { $pull: { customerOrders: order._id } }, { session });
      const rev = await Referral.findOneAndUpdate({ qualifyingOrder: order._id, status: 'CREDITED' }, { status: 'REVERSED' }, { session, new: true });
      if (rev) { // immutable ledger: add a REVERSAL entry, never delete the original credit
        const w = await Wallet.findOneAndUpdate({ user: rev.referrer }, { $inc: { availableBalance: -rev.rewardAmount } }, { session, new: true });
        await WalletTransaction.create([{ wallet: w._id, user: rev.referrer, type: 'REVERSAL', amount: rev.rewardAmount, reference: 'REV-' + rev._id, description: 'Referral reversed (order refunded)', relatedOrder: order._id }], { session });
      }
      await audit(admin, 'REFUND_COMPLETED', 'Refund', refund._id, { status: 'APPROVED' }, { status: 'COMPLETED', orderCancelled: order._id }, session);
      result = refund; cancelled = order;
    });
  } finally { await session.endSession(); }
  if (cancelled) {
    notify(cancelled.customer, 'refund', 'Refund completed', 'Your refund is complete and your entire order has been cancelled.', { kind: 'Order', id: cancelled._id }, io, { template: 'refund', data: { status: 'COMPLETED', reference: cancelled.orderReference, amount: result.approvedAmount || result.requestedAmount, transfer: transferReference } }); io?.to(`user:${cancelled.customer}`).emit('order:cancelled', { orderId: cancelled._id }); io?.to(`room:${cancelled.room}`).emit('order:cancelled', { orderId: cancelled._id }); }
  return result;
}
