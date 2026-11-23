import crypto from 'crypto';
import mongoose from 'mongoose';
import { Order, Payment, Room, User, ShippingInvoice, ShippingFeeLog } from '../models/index.js';
import { notify } from './notify.js';
import { httpError } from '../utils/httpError.js';
import * as paystack from './paystack.js';
const CONFIRMED = { paymentStatus: 'PAID', orderStatus: { $nin: ['CANCELLED'] }, refundStatus: { $nin: ['DUE', 'COMPLETED'] } }; // only confirmed product orders can be invoiced
export const confirmedOrders = (roomId) => Order.find({ room: roomId, ...CONFIRMED });
const log = (inv, action, prev, next, actor, note) => ShippingFeeLog.create({ invoice: inv._id, order: inv.order, room: inv.room, action, previousAmount: prev, newAmount: next, by: actor?._id, byRole: actor?.role, note });
const newNumber = () => 'SHP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
export async function saveFees(room, actor, entries) {
  const results = [];
  for (const e of entries) {
    const order = await Order.findOne({ _id: e.orderId, room: room._id, ...CONFIRMED });
    if (!order) { results.push({ orderId: e.orderId, ok: false, error: 'Not a confirmed order in this room' }); continue; }
    let inv = await ShippingInvoice.findOne({ order: order._id });
    if (inv?.status === 'PAID') { results.push({ orderId: e.orderId, ok: false, error: 'Already paid. The fee is locked.' }); continue; }
    if (inv?.status === 'VOID') { results.push({ orderId: e.orderId, ok: false, error: 'This invoice was voided' }); continue; }
    if (!inv) {
      try { inv = await ShippingInvoice.create({ invoiceNumber: newNumber(), room: room._id, order: order._id, customer: order.customer, amount: e.amount, note: e.note, createdBy: actor._id, lastEditedBy: actor._id }); }
      catch (x) { if (x.code !== 11000) throw x; results.push({ orderId: e.orderId, ok: false, error: 'Please retry' }); continue; }
      await log(inv, 'DRAFT_SAVED', null, e.amount, actor, e.note);
      await Order.updateOne({ _id: order._id, orderStatus: 'AWAITING_SHIPPING_REVIEW' }, { orderStatus: 'SHIPPING_FEE_PENDING' });
      results.push({ orderId: e.orderId, ok: true, status: 'DRAFT' }); continue;
    }
    const prev = inv.amount; const published = inv.status === 'PUBLISHED';
    if (prev === e.amount && (e.note ?? inv.note) === inv.note) { results.push({ orderId: e.orderId, ok: true, status: inv.status, unchanged: true }); continue; }
    inv.amount = e.amount; if (e.note !== undefined) inv.note = e.note; inv.lastEditedBy = actor._id; if (published && prev !== e.amount) inv.revision += 1; await inv.save();
    if (prev !== e.amount) await log(inv, published ? 'REVISED' : 'DRAFT_UPDATED', prev, e.amount, actor, e.note);
    if (published && prev !== e.amount) { // unpaid invoice adjusted: stop in-flight payments for the old amount and tell the buyer
      await Payment.updateMany({ invoice: inv._id, status: 'PENDING' }, { status: 'FAILED', flag: 'INVOICE_REVISED' });
      notify(order.customer, 'shipping', 'Shipping fee updated', `The shipping fee for ${order.orderReference} changed.`, { kind: 'Invoice', id: inv._id }, undefined, { template: 'shippingRevised', data: { invoice: inv.invoiceNumber, reference: order.orderReference, previous: prev, amount: e.amount, path: `/app/shipping/${inv._id}` } });
    }
    results.push({ orderId: e.orderId, ok: true, status: inv.status, revised: published && prev !== e.amount });
  }
  return results;
}
export async function publishFees(room, actor) {
  const orders = await confirmedOrders(room._id).select('_id orderReference customer');
  const invs = await ShippingInvoice.find({ room: room._id, order: { $in: orders.map((o) => o._id) } });
  const missing = orders.filter((o) => !invs.some((i) => i.order.equals(o._id) && i.status !== 'VOID')).map((o) => o.orderReference);
  if (missing.length) throw httpError(409, `Set a shipping fee for every buyer before publishing (${missing.length} missing)`, 'FEES_MISSING', { missing });
  let published = 0;
  for (const d of invs.filter((i) => i.status === 'DRAFT')) {
    const inv = await ShippingInvoice.findOneAndUpdate({ _id: d._id, status: 'DRAFT' }, { status: 'PUBLISHED', publishedAt: new Date(), lastEditedBy: actor._id }, { new: true }); if (!inv) continue;
    await Order.updateOne({ _id: inv.order, orderStatus: { $in: ['AWAITING_SHIPPING_REVIEW', 'SHIPPING_FEE_PENDING'] } }, { orderStatus: 'SHIPPING_PAYMENT_DUE' });
    await log(inv, 'PUBLISHED', inv.amount, inv.amount, actor); published++;
    const o = orders.find((x) => x._id.equals(inv.order));
    notify(inv.customer, 'shipping', 'Your shipping fee is ready', `Pay the shipping fee for ${o?.orderReference}.`, { kind: 'Invoice', id: inv._id }, undefined, { template: 'shippingDue', data: { invoice: inv.invoiceNumber, reference: o?.orderReference, room: room.name, amount: inv.amount, path: `/app/shipping/${inv._id}` } });
  }
  if (!published) throw httpError(409, 'There are no draft fees to publish');
  return { published };
}
const NEXT = { READY_FOR_DISPATCH: 'SHIPPING_PAID', DISPATCHED: 'READY_FOR_DISPATCH', DELIVERED: 'DISPATCHED' };
export async function setFulfilment(room, actor, orderIds, status, io) {
  if (!NEXT[status]) throw httpError(400, 'Invalid status');
  const orders = await Order.find({ _id: { $in: orderIds }, room: room._id, orderStatus: NEXT[status] }); const ids = orders.map((o) => o._id);
  if (ids.length) await Order.updateMany({ _id: { $in: ids }, orderStatus: NEXT[status] }, { orderStatus: status });
  for (const o of orders) { io?.to(`user:${o.customer}`).emit('order:updated', { orderId: o._id, status }); notify(o.customer, 'order', 'Order update', `${o.orderReference}: ${status.replace(/_/g, ' ').toLowerCase()}`, { kind: 'Order', id: o._id }, io, { template: 'orderUpdate', data: { reference: o.orderReference, status: status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()), path: `/app/orders/${o._id}` } }); }
  if (status === 'DELIVERED') { const open = await Order.countDocuments({ room: room._id, ...CONFIRMED, orderStatus: { $ne: 'DELIVERED' } }); if (!open) await Room.updateOne({ _id: room._id }, { status: 'COMPLETED' }); }
  return { updated: ids.length, skipped: orderIds.length - ids.length };
}
export async function payShippingInvoice(invoiceId, user) {
  const inv = await ShippingInvoice.findOne({ _id: invoiceId, customer: user._id });
  if (!inv || inv.status === 'DRAFT') throw httpError(404, 'Invoice not found');
  if (inv.status === 'PAID') throw httpError(409, 'This invoice is already paid');
  if (inv.status !== 'PUBLISHED') throw httpError(409, 'This invoice can no longer be paid');
  const reference = 'O2G-SHP-' + crypto.randomBytes(8).toString('hex');
  await Payment.create({ kind: 'SHIPPING', customer: user._id, order: inv.order, invoice: inv._id, providerReference: reference, amount: inv.amount, shippingAmount: inv.amount });
  const ps = await paystack.initialize(user.email, inv.amount, reference, `${process.env.CLIENT_URL}/app/payment/success`);
  if (!ps?.data?.authorization_url) { await Payment.updateOne({ providerReference: reference }, { status: 'FAILED' }); throw httpError(502, 'Could not start the payment. Please try again.'); }
  return { authorizationUrl: ps.data.authorization_url, reference };
}
// Called only from markPaid, i.e. after Paystack verification or a signed webhook. There is no manual "mark as paid" anywhere.
export async function markShippingPaid(pay, io) {
  const session = await mongoose.startSession(); let result = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const claimed = await Payment.findOneAndUpdate({ _id: pay._id, status: { $ne: 'SUCCESS' } }, { status: 'SUCCESS', verifiedAt: new Date() }, { session }); if (!claimed) return;
      const inv = await ShippingInvoice.findById(pay.invoice).session(session);
      if (!inv || inv.status !== 'PUBLISHED' || inv.amount !== pay.amount) { await Payment.updateOne({ _id: pay._id }, { flag: 'SHIPPING_MISMATCH' }, { session }); result = { flagged: true, inv }; return; }
      inv.status = 'PAID'; inv.paidAt = new Date(); inv.paymentReference = pay.providerReference; await inv.save({ session });
      await Order.updateOne({ _id: inv.order, orderStatus: { $in: ['AWAITING_SHIPPING_REVIEW', 'SHIPPING_FEE_PENDING', 'SHIPPING_PAYMENT_DUE'] } }, { orderStatus: 'SHIPPING_PAID' }, { session });
      await ShippingFeeLog.create([{ invoice: inv._id, order: inv.order, room: inv.room, action: 'PAID', previousAmount: inv.amount, newAmount: inv.amount, note: pay.providerReference }], { session });
      result = { paid: true, inv };
    });
  } finally { await session.endSession(); }
  if (result?.paid) { const o = await Order.findById(result.inv.order).select('orderReference'); io?.to(`user:${result.inv.customer}`).emit('order:updated', { orderId: result.inv.order, status: 'SHIPPING_PAID' }); notify(result.inv.customer, 'shipping', 'Shipping payment received', `Shipping for ${o?.orderReference} is paid.`, { kind: 'Invoice', id: result.inv._id }, io, { template: 'shippingPaid', data: { invoice: result.inv.invoiceNumber, reference: o?.orderReference, amount: pay.amount, path: `/app/shipping/${result.inv._id}` } }); }
  if (result?.flagged) { const admins = await User.find({ role: 'ADMIN' }).select('_id'); admins.forEach((a) => notify(a._id, 'shipping', 'Shipping payment needs review', `Payment ${pay.providerReference} did not match its invoice (revised or already paid). Reconcile or refund it.`)); }
  return pay;
}
