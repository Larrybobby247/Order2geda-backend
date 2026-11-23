// Real-database tests. Needs a MongoDB REPLICA SET: TEST_MONGODB_URI=mongodb://127.0.0.1:27017/o2g_test?replicaSet=rs0 npm test
import test, { before, after } from 'node:test'; import assert from 'node:assert'; import mongoose from 'mongoose';
const uri = process.env.TEST_MONGODB_URI; const skip = !uri || !/test/.test(uri) ? 'set TEST_MONGODB_URI (db name must contain "test")' : false;
process.env.JWT_SECRET ||= 'test-secret'; process.env.CLIENT_URL ||= 'http://localhost:5173';
let M, rooms, orders, ship, n = 0; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => { if (skip) return; await mongoose.connect(uri); await mongoose.connection.dropDatabase(); M = await import('./models/index.js'); rooms = await import('./services/roomService.js'); orders = await import('./services/orderService.js'); ship = await import('./services/shippingService.js'); await Promise.all(Object.values(M).map((m) => m.init?.())); });
after(async () => { if (!skip) await mongoose.disconnect(); });
const mkUser = (name, role = 'CUSTOMER') => M.User.create({ fullName: name, email: `${name}${++n}@t.com`, passwordHash: 'x', referralCode: `R${n}${name}`.toUpperCase(), role });
const mkRoom = async (users, extra = {}) => M.Room.create({ name: 'room' + ++n, shoppingPlatform: 'Temu', creator: users[0]._id, targetAmount: 950, closingThreshold: 1000, participants: users.map((u) => u._id), ...extra });
const draft = (room, u, price, qty = 1) => rooms.addProducts(room._id, u._id, [{ name: 'item', price, quantity: qty }]);
const pay = async (order, user) => { const ref = 'T' + ++n + Math.random(); await M.Payment.create({ kind: 'PRODUCT', customer: user._id, order: order._id, providerReference: ref, amount: order.totalAmount }); await orders.markPaid(ref, order.totalAmount); return ref; };
const status = (id) => M.Order.findById(id).then((o) => o.orderStatus);
test('drafts do not count toward the room; only paid items do', { skip }, async () => {
  const [a, b] = [await mkUser('a'), await mkUser('b')]; const room = await mkRoom([a, b]); await draft(room, a, 600); await draft(room, b, 300);
  assert.equal((await M.Room.findById(room._id)).acceptedProductTotal, 0);
  const o = await orders.reserveCapacity(room._id, a); assert.equal(o.totalAmount, 660); assert.equal((await M.Room.findById(room._id)).acceptedProductTotal, 0); await pay(o, a);
  const r = await M.Room.findById(room._id); assert.equal(r.acceptedProductTotal, 600); assert.equal(r.status, 'OPEN');
  assert.equal((await M.Product.findOne({ customer: a._id })).locked, true); assert.equal((await M.Product.findOne({ customer: b._id })).locked, false);
});
test('capacity is held while someone pays: a third payer is blocked, a second is allowed', { skip }, async () => {
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((x) => mkUser(x))); const room = await mkRoom([a, b, c]); for (const u of [a, b, c]) await draft(room, u, 800);
  await orders.reserveCapacity(room._id, a); await orders.reserveCapacity(room._id, b);
  await assert.rejects(orders.reserveCapacity(room._id, c), (e) => e.appCode === 'ROOM_FULL_PENDING');
});
test('concurrent payers: exactly the allowed number get capacity', { skip }, async () => {
  const us = await Promise.all(['p', 'q', 'r', 's', 't'].map((x) => mkUser(x))); const room = await mkRoom(us); for (const u of us) await draft(room, u, 600);
  const res = await Promise.allSettled(us.map((u) => orders.reserveCapacity(room._id, u))); assert.equal(res.filter((x) => x.status === 'fulfilled').length, 2);
});
test('last payment closes the room once, cancels unpaid drafts, moves paid orders to shipping review', { skip }, async () => {
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((x) => mkUser(x))); const room = await mkRoom([a, b, c]); await draft(room, a, 600); await draft(room, b, 600); await draft(room, c, 300);
  const oa = await orders.reserveCapacity(room._id, a), ob = await orders.reserveCapacity(room._id, b); await pay(oa, a); await pay(ob, b); await sleep(500);
  const r = await M.Room.findById(room._id); assert.equal(r.status, 'CLOSED'); assert.equal(r.acceptedProductTotal, 1200);
  assert.equal(await status(oa._id), 'AWAITING_SHIPPING_REVIEW'); assert.equal(await status(ob._id), 'AWAITING_SHIPPING_REVIEW');
  assert.equal((await M.Product.findOne({ customer: c._id })).status, 'CANCELLED'); assert.equal(await M.Message.countDocuments({ room: room._id, messageType: 'SYSTEM' }), 1);
  assert.ok((await M.Notification.countDocuments({ recipient: c._id })) >= 1);
});
test('closure is idempotent under concurrency', { skip }, async () => {
  const a = await mkUser('a'); const room = await mkRoom([a], { acceptedProductTotal: 1000 }); const res = await Promise.all([1, 2, 3, 4, 5].map(() => rooms.closeIfThresholdReached(room._id))); assert.equal(res.filter(Boolean).length, 1);
});
test('duplicate payment confirmation counts once', { skip }, async () => {
  const [a, ref] = [await mkUser('a'), await mkUser('ref')]; const room = await mkRoom([a]); await M.Wallet.create({ user: ref._id }); await M.Referral.create({ referrer: ref._id, referredUser: a._id }); await draft(room, a, 300);
  const o = await orders.reserveCapacity(room._id, a); const r = 'DUP' + ++n; await M.Payment.create({ kind: 'PRODUCT', customer: a._id, order: o._id, providerReference: r, amount: o.totalAmount });
  await Promise.all([orders.markPaid(r, o.totalAmount), orders.markPaid(r, o.totalAmount)]); await orders.markPaid(r, o.totalAmount);
  assert.equal((await M.Room.findById(room._id)).acceptedProductTotal, 300); assert.equal(await M.WalletTransaction.countDocuments({ user: ref._id, type: 'CREDIT' }), 1); await assert.rejects(orders.markPaid(r, 1));
});
test('payment arriving after the room closed (hold expired) is flagged for refund, not counted', { skip }, async () => {
  const [a, b] = [await mkUser('a'), await mkUser('b')]; const room = await mkRoom([a, b]); await draft(room, a, 400); const oa = await orders.reserveCapacity(room._id, a);
  await M.Order.updateOne({ _id: oa._id }, { reservedUntil: new Date(Date.now() - 3600e3) }); await M.Room.updateOne({ _id: room._id }, { status: 'CLOSED' });
  await pay(await M.Order.findById(oa._id), a); const o = await M.Order.findById(oa._id);
  assert.equal(o.orderStatus, 'CANCELLED'); assert.equal(o.refundStatus, 'DUE'); assert.equal(o.paymentStatus, 'PAID'); assert.equal((await M.Room.findById(room._id)).acceptedProductTotal, 0);
});
test('paid items are locked; items under an active payment cannot be edited', { skip }, async () => {
  const a = await mkUser('a'); const room = await mkRoom([a]); await draft(room, a, 200); await draft(room, a, 100); const [p1, p2] = await M.Product.find({ customer: a._id }).sort({ price: -1 });
  const o = await orders.reserveCapacity(room._id, a); await assert.rejects(orders.assertEditable(await M.Product.findById(p1._id)), (e) => e.appCode === 'PAYMENT_IN_PROGRESS');
  await orders.releasePending(o._id, 'x'); await orders.assertEditable(await M.Product.findById(p1._id)); // free again after cancelling the payment
  const o2 = await orders.reserveCapacity(room._id, a); await pay(o2, a); await assert.rejects(orders.assertEditable(await M.Product.findById(p2._id)), /Paid items/);
});
async function closedRoomWithBuyers(k = 2) {
  const mod = await mkUser('mod', 'MODERATOR'); const us = await Promise.all(Array.from({ length: k }, (_, i) => mkUser('buyer' + i))); const room = await mkRoom(us, { assignedModerator: mod._id, closingThreshold: 100 * k, targetAmount: 100 * k });
  const os = []; for (const u of us) { await draft(room, u, 100); const o = await orders.reserveCapacity(room._id, u); await pay(o, u); os.push(o); } await sleep(500); return { mod, us, room: await M.Room.findById(room._id), os };
}
test('shipping workflow: drafts, publish gate, revise, verified payment only, lock, fulfilment', { skip }, async () => {
  const { mod, us, room, os } = await closedRoomWithBuyers(2); assert.equal(room.status, 'CLOSED');
  let r = await ship.saveFees(room, mod, [{ orderId: String(os[0]._id), amount: 150000 }]); assert.ok(r[0].ok); assert.equal(await status(os[0]._id), 'SHIPPING_FEE_PENDING');
  await assert.rejects(ship.publishFees(room, mod), (e) => e.appCode === 'FEES_MISSING'); // every buyer needs a fee first
  r = await ship.saveFees(room, mod, [{ orderId: String(os[1]._id), amount: 90000 }]); assert.ok(r[0].ok);
  assert.deepEqual(await ship.publishFees(room, mod), { published: 2 }); assert.equal(await status(os[0]._id), 'SHIPPING_PAYMENT_DUE');
  const rev = await ship.saveFees(room, mod, [{ orderId: String(os[0]._id), amount: 120000 }]); assert.ok(rev[0].revised);
  const inv0 = await M.ShippingInvoice.findOne({ order: os[0]._id }); assert.equal(inv0.revision, 1); assert.equal(inv0.amount, 120000);
  const log = await M.ShippingFeeLog.find({ invoice: inv0._id }).sort({ at: 1 }); assert.deepEqual(log.map((l) => [l.action, l.previousAmount, l.newAmount]), [['DRAFT_SAVED', null, 150000], ['PUBLISHED', 150000, 150000], ['REVISED', 150000, 120000]]);
  // buyer pays through the normal payment pipeline; payment records stay separate from product payments
  const ref = 'SHP' + ++n; await M.Payment.create({ kind: 'SHIPPING', customer: us[0]._id, order: os[0]._id, invoice: inv0._id, providerReference: ref, amount: 120000 });
  await orders.markPaid(ref, 120000); await orders.markPaid(ref, 120000);
  assert.equal((await M.ShippingInvoice.findById(inv0._id)).status, 'PAID'); assert.equal(await status(os[0]._id), 'SHIPPING_PAID'); assert.equal((await M.ShippingInvoice.findOne({ order: os[1]._id })).status, 'PUBLISHED'); // independent
  const locked = await ship.saveFees(room, mod, [{ orderId: String(os[0]._id), amount: 1 * 100 }]); assert.equal(locked[0].ok, false);
  const stale = 'OLD' + ++n; await M.Payment.create({ kind: 'SHIPPING', customer: us[0]._id, order: os[0]._id, invoice: inv0._id, providerReference: stale, amount: 150000 }); await orders.markPaid(stale, 150000);
  assert.equal((await M.Payment.findOne({ providerReference: stale })).flag, 'SHIPPING_MISMATCH'); // wrong-amount payment never marks an invoice paid
  const f1 = await ship.setFulfilment(room, mod, [String(os[0]._id), String(os[1]._id)], 'READY_FOR_DISPATCH'); assert.deepEqual([f1.updated, f1.skipped], [1, 1]); // unpaid buyer is skipped
  assert.equal((await ship.setFulfilment(room, mod, [String(os[0]._id)], 'DELIVERED')).updated, 0); // no skipping steps
  await ship.setFulfilment(room, mod, [String(os[0]._id)], 'DISPATCHED'); await ship.setFulfilment(room, mod, [String(os[0]._id)], 'DELIVERED'); assert.equal(await status(os[0]._id), 'DELIVERED');
});
test('only confirmed orders can be invoiced; bulk fee applies to selected buyers', { skip }, async () => {
  const { mod, room, os, us } = await closedRoomWithBuyers(2); const stranger = await mkUser('x'); const fake = await M.Order.create({ orderReference: 'FAKE' + ++n, room: room._id, customer: stranger._id, productSubtotal: 5, paymentStatus: 'UNPAID', orderStatus: 'AWAITING_PAYMENT' });
  const r = await ship.saveFees(room, mod, [{ orderId: String(fake._id), amount: 5000 }, ...os.map((o) => ({ orderId: String(o._id), amount: 40000 }))]);
  assert.deepEqual(r.map((x) => x.ok), [false, true, true]); assert.equal(await M.ShippingInvoice.countDocuments({ room: room._id }), 2);
});
test('refund completion cancels only that order, frees an open room, voids its unpaid invoice', { skip }, async () => {
  const [a, b, admin] = [await mkUser('a'), await mkUser('b'), await mkUser('adm', 'ADMIN')]; const room = await mkRoom([a, b], { closingThreshold: 5000 }); await draft(room, a, 300); await draft(room, b, 200);
  const oa = await orders.reserveCapacity(room._id, a), ob = await orders.reserveCapacity(room._id, b); await pay(oa, a); await pay(ob, b); assert.equal((await M.Room.findById(room._id)).acceptedProductTotal, 500);
  const rf = await M.Refund.create({ customer: a._id, order: oa._id, requestedAmount: 330, status: 'APPROVED' }); await orders.completeRefund(rf._id, admin, 'TRF1'); await orders.completeRefund(rf._id, admin, 'TRF1');
  assert.equal(await status(oa._id), 'CANCELLED'); assert.notEqual(await status(ob._id), 'CANCELLED'); assert.equal((await M.Room.findById(room._id)).acceptedProductTotal, 200); assert.equal((await M.Product.findOne({ customer: a._id })).status, 'CANCELLED'); assert.equal((await M.Product.findOne({ customer: b._id })).status, 'ACTIVE');
});
