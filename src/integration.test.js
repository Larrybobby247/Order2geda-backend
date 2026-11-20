// Needs a MongoDB REPLICA SET test database: TEST_MONGODB_URI=mongodb://localhost:27017/o2g_test?replicaSet=rs0 npm test
import test, { before, after } from 'node:test'; import assert from 'node:assert'; import mongoose from 'mongoose';
const uri = process.env.TEST_MONGODB_URI; const skip = !uri || !/test/.test(uri) ? 'set TEST_MONGODB_URI (db name must contain "test")' : false;
let M, rooms, orders;
before(async () => { if (skip) return; await mongoose.connect(uri); await mongoose.connection.dropDatabase(); M = await import('./models/index.js'); rooms = await import('./services/roomService.js'); orders = await import('./services/orderService.js'); await Promise.all(Object.values(M).map((m) => m.init?.())); });
after(async () => { if (!skip) await mongoose.disconnect(); });
const mkUser = (n) => M.User.create({ fullName: n, email: `${n}@t.com`, passwordHash: 'x', referralCode: n.toUpperCase() });
test('concurrent submissions close the room exactly once at 105%', { skip }, async () => {
  const users = await Promise.all([1, 2, 3, 4, 5].map((i) => mkUser('u' + i)));
  const room = await M.Room.create({ name: 'r', shoppingPlatform: 'Temu', creator: users[0]._id, targetAmount: 3000000, closingThreshold: 3150000, participants: users.map((u) => u._id) });
  const res = await Promise.allSettled(users.map((u) => rooms.addProducts(room._id, u._id, [{ name: 'p', price: 800000, quantity: 1 }])));
  assert.equal(res.filter((r) => r.status === 'fulfilled' && r.value.closed).length, 1);
  assert.equal((await M.Room.findById(room._id)).status, 'CLOSED');
  await assert.rejects(rooms.addProducts(room._id, users[0]._id, [{ name: 'late', price: 100, quantity: 1 }]));
});
test('duplicate payment confirmation credits referral once', { skip }, async () => {
  const [ref, buyer] = [await mkUser('ref'), await mkUser('buyer')]; await M.Wallet.create({ user: ref._id });
  await M.Referral.create({ referrer: ref._id, referredUser: buyer._id });
  const room = await M.Room.create({ name: 'r2', creator: buyer._id, targetAmount: 100, closingThreshold: 105, status: 'CLOSED' });
  const o = await M.Order.create({ orderReference: 'A1', room: room._id, customer: buyer._id, productSubtotal: 1000, commissionAmount: 100, totalAmount: 1100 });
  await M.Payment.create({ customer: buyer._id, order: o._id, providerReference: 'REF1', amount: 1100 });
  await Promise.all([orders.markPaid('REF1', 1100), orders.markPaid('REF1', 1100)]);
  assert.equal(await M.WalletTransaction.countDocuments({ user: ref._id, type: 'CREDIT' }), 1);
  await assert.rejects(orders.markPaid('REF1', 5));
});
test('refund completion cancels only that customer order and is idempotent', { skip }, async () => {
  const [a, b, admin] = [await mkUser('ra'), await mkUser('rb'), await mkUser('adm')];
  const room = await M.Room.create({ name: 'r3', creator: a._id, targetAmount: 100, closingThreshold: 105, status: 'PROCESSING' });
  const pa = await M.Product.create({ room: room._id, customer: a._id, name: 'x', price: 10, quantity: 1 }), pb = await M.Product.create({ room: room._id, customer: b._id, name: 'y', price: 10, quantity: 1 });
  const oa = await M.Order.create({ orderReference: 'RA', room: room._id, customer: a._id, products: [pa._id], paymentStatus: 'PAID' }), ob = await M.Order.create({ orderReference: 'RB', room: room._id, customer: b._id, products: [pb._id], paymentStatus: 'PAID' });
  const rf = await M.Refund.create({ customer: a._id, order: oa._id, requestedAmount: 10, status: 'APPROVED' });
  await orders.completeRefund(rf._id, admin, 'TRF1'); await orders.completeRefund(rf._id, admin, 'TRF1');
  assert.equal((await M.Order.findById(oa._id)).orderStatus, 'CANCELLED'); assert.notEqual((await M.Order.findById(ob._id)).orderStatus, 'CANCELLED');
  assert.equal((await M.Product.findById(pa._id)).status, 'CANCELLED'); assert.equal((await M.Product.findById(pb._id)).status, 'ACTIVE');
});
