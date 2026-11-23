import { Order, Room } from '../models/index.js';
import { releasePending } from './orderService.js';
import { notify } from './notify.js';
import { GRACE_MIN } from '../utils/capacity.js';
// Cancels unpaid orders left behind in rooms that already closed (their payment window and grace period ended). Safe to run on every instance.
export async function sweepExpired() {
  const stale = await Order.find({ paymentStatus: 'UNPAID', orderStatus: { $ne: 'CANCELLED' }, reservedUntil: { $lte: new Date(Date.now() - GRACE_MIN * 60000) } }).limit(200);
  for (const o of stale) {
    const room = await Room.findById(o.room).select('status name'); if (!room || room.status === 'OPEN') continue;
    if (await releasePending(o._id, 'The room filled up before this order was paid.', true)) notify(o.customer, 'room', 'Room filled up before you paid', `${room.name} filled up, so your unpaid items were removed.`, { kind: 'Room', id: o.room }, undefined, { template: 'roomFilled', data: { room: room.name, path: '/app/discover' } });
  }
}
