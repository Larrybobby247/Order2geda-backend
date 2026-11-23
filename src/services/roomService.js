import { Room, Product, Message, Order } from '../models/index.js';
import { notify } from './notify.js';
import { httpError } from '../utils/httpError.js';
// Adding products only creates an UNPAID draft. Drafts never count toward the room: only paid items move the progress bar.
export async function addProducts(roomId, userId, items) {
  if (!(await Room.exists({ _id: roomId, status: 'OPEN', participants: userId }))) throw httpError(409, 'Room is closed or you have not joined');
  const drafts = await Product.countDocuments({ room: roomId, customer: userId, status: 'ACTIVE', locked: false });
  if (drafts + items.length > 50) throw httpError(400, 'You can have up to 50 unpaid items at a time. Pay for some first.');
  return { docs: await Product.insertMany(items.map((i) => ({ ...i, room: roomId, customer: userId }))), closed: false };
}
export async function closeIfThresholdReached(roomId, io) {
  const r = await Room.findById(roomId).select('closingThreshold');
  const res = await Room.findOneAndUpdate({ _id: roomId, status: 'OPEN', acceptedProductTotal: { $gte: r.closingThreshold } }, { $set: { status: 'CLOSED', closedAt: new Date() } }, { new: true });
  if (res) { io?.to(`room:${roomId}`).emit('room:closed', { roomId }); onClosed(res, io).catch((e) => console.error('onClosed', e.message)); }
  return !!res; // exactly one caller observes true
}
async function onClosed(room, io) { // failures here never affect the closure itself
  const now = new Date();
  // 1) cancel every unpaid selection. Orders whose payment window is still open keep their items until they pay or the window ends.
  const inflight = await Order.find({ room: room._id, paymentStatus: 'UNPAID', orderStatus: { $ne: 'CANCELLED' }, reservedUntil: { $gt: now } }).select('products');
  const keep = inflight.flatMap((o) => o.products); const unpaid = { room: room._id, status: 'ACTIVE', locked: false, _id: { $nin: keep } };
  const affected = await Product.distinct('customer', unpaid);
  await Product.updateMany(unpaid, { status: 'CANCELLED' });
  await Order.updateMany({ room: room._id, paymentStatus: 'UNPAID', orderStatus: { $ne: 'CANCELLED' }, $or: [{ reservedUntil: null }, { reservedUntil: { $lte: now } }] }, { $set: { orderStatus: 'CANCELLED', cancelledAt: now, cancellationReason: 'The room filled up before this order was paid.' }, $unset: { reservedUntil: 1 } });
  // 2) every confirmed (paid) order now waits for the moderator to review it and set its shipping fee
  await Order.updateMany({ room: room._id, paymentStatus: 'PAID', orderStatus: 'PAYMENT_COMPLETED' }, { orderStatus: 'AWAITING_SHIPPING_REVIEW' });
  const msg = await Message.create({ room: room._id, content: 'The room is full and now closed. Unpaid items were removed. The moderator will review orders and set shipping fees next.', messageType: 'SYSTEM' }); io?.to(`room:${room._id}`).emit('message:new', msg);
  for (const uid of affected) notify(uid, 'room', 'Room filled up before you paid', `${room.name} filled up, so your unpaid items were removed.`, { kind: 'Room', id: room._id }, io, { template: 'roomFilled', data: { room: room.name, path: '/app/discover' } });
  for (const uid of await Order.distinct('customer', { room: room._id, paymentStatus: 'PAID', orderStatus: 'AWAITING_SHIPPING_REVIEW' })) notify(uid, 'room', 'Your room is full', `${room.name} has closed. Your order is confirmed.`, { kind: 'Room', id: room._id }, io, { template: 'roomClosed', data: { room: room.name, path: '/app/orders' } });
  if (room.assignedModerator) notify(room.assignedModerator, 'room', 'Room closed: shipping review needed', `${room.name} has closed. Review the orders and set shipping fees.`, { kind: 'Room', id: room._id }, io, { template: 'notification', data: { path: `/moderator/rooms/${room._id}/shipping`, ctaLabel: 'Open shipping review' } });
}
