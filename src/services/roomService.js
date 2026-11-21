import { Room, Product, Message } from '../models/index.js';
import { notify } from './notify.js';
import { buildCheckout } from './orderService.js';
// Atomic add: succeeds only while OPEN and joined; then idempotently closes at threshold.
export async function addProducts(roomId, userId, items, io) {
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const room = await Room.findOneAndUpdate({ _id: roomId, status: 'OPEN', participants: userId }, { $inc: { acceptedProductTotal: total } }, { new: true });
  if (!room) throw Object.assign(new Error('Room is closed or you have not joined'), { status: 409 });
  let docs;
  try { docs = await Product.insertMany(items.map((i) => ({ ...i, room: roomId, customer: userId }))); }
  catch (e) { await Room.updateOne({ _id: roomId }, { $inc: { acceptedProductTotal: -total } }); throw e; }
  const closed = await closeIfThresholdReached(roomId, io);
  io?.to(`room:${roomId}`).emit('room:progress-updated', { roomId, acceptedProductTotal: room.acceptedProductTotal });
  return { docs, closed };
}
async function onClosed(room, io) { // chat announcement + closed-room emails/notifications (failures never affect closure)
  const m = await Message.create({ room: room._id, content: 'The room has reached its closing threshold and is now closed. Review your order and pay.', messageType: 'SYSTEM' });
  io?.to(`room:${room._id}`).emit('message:new', m);
  for (const uid of room.participants) { // create every participant's order now so they can pay immediately, and email the exact total
    try {
      if (!(await Product.exists({ room: room._id, customer: uid, status: 'ACTIVE' }))) continue; // joined but added nothing: nothing to pay
      const order = await buildCheckout(room._id, { _id: uid });
      notify(uid, 'payment', 'Room closed — pay now', `${room.name} has closed. Your total is ready to pay.`, { kind: 'Order', id: order._id }, io,
        { template: 'payNow', data: { room: room.name, subtotal: order.productSubtotal, commission: order.commissionAmount, shipping: order.estimatedShipping, amount: order.totalAmount, path: `/app/pay/${order._id}` } });
    } catch (e) { console.error('close checkout', String(uid), e.message); }
  }
  if (room.assignedModerator) notify(room.assignedModerator, 'room', 'Room closed', `${room.name} has reached its threshold.`, { kind: 'Room', id: room._id }, io);
}
export async function adjustTotal(roomId, delta, io) {
  await Room.updateOne({ _id: roomId, status: 'OPEN' }, { $inc: { acceptedProductTotal: delta } });
  await closeIfThresholdReached(roomId, io);
}
export async function closeIfThresholdReached(roomId, io) {
  const r = await Room.findById(roomId).select('closingThreshold');
  const res = await Room.findOneAndUpdate({ _id: roomId, status: 'OPEN', acceptedProductTotal: { $gte: r.closingThreshold } }, { $set: { status: 'CLOSED', closedAt: new Date() } }, { new: true });
  if (res) { io?.to(`room:${roomId}`).emit('room:closed', { roomId }); onClosed(res, io).catch((e) => console.error('onClosed', e.message)); }
  return !!res; // exactly one caller observes true
}
