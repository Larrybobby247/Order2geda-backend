// End-to-end over HTTP with a mock Paystack. Needs TEST_MONGODB_URI (replica set).
import test, { before, after } from 'node:test'; import assert from 'node:assert'; import http from 'http'; import crypto from 'crypto'; import mongoose from 'mongoose';
const uri = process.env.TEST_MONGODB_URI?.replace(/\/([^/?]+)\?/, '/$1_http?'); // its own database, so it can run beside the other test file
const skip = !uri || !/test/.test(uri) ? 'set TEST_MONGODB_URI' : false;
Object.assign(process.env, { JWT_SECRET: 'test-secret', CLIENT_URL: 'http://localhost:5173', PAYSTACK_SECRET_KEY: 'sk_test_x', NODE_ENV: 'test' });
let M, base, ps, server, sign; const amounts = {}; let n = 0; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  if (skip) return; await mongoose.connect(uri); await mongoose.connection.dropDatabase();
  ps = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.setHeader('content-type', 'application/json');
    if (req.url.includes('/initialize')) { const j = JSON.parse(b); amounts[j.reference] = j.amount; return res.end(JSON.stringify({ status: true, data: { authorization_url: 'https://paystack.test/' + j.reference } })); }
    const ref = decodeURIComponent(req.url.split('/verify/')[1]); res.end(JSON.stringify({ status: true, data: { status: 'success', amount: amounts[ref] } })); }); });
  await new Promise((r) => ps.listen(0, r)); process.env.PAYSTACK_BASE_URL = `http://127.0.0.1:${ps.address().port}`;
  M = await import('./models/index.js'); ({ sign } = await import('./middleware/auth.js')); const { app } = await import('./app.js'); server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { if (skip) return; server.close(); ps.close(); await mongoose.disconnect(); });
const mk = async (name, role = 'CUSTOMER') => { const u = await M.User.create({ fullName: name, email: `${name}${++n}@t.com`, passwordHash: 'x', referralCode: `C${n}`, role, emailVerified: true }); return { u, t: sign(u) }; };
const call = async (method, path, t, body) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t && { authorization: 'Bearer ' + t }) }, body: body && JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const webhook = (reference) => { const raw = JSON.stringify({ event: 'charge.success', data: { reference, amount: amounts[reference] } }); return fetch(base + '/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': crypto.createHmac('sha512', 'sk_test_x').update(raw).digest('hex') }, body: raw }); };
test('location: filters and nearby ranking; private rooms never listed; creation needs a valid location', { skip }, async () => {
  const { u, t } = await mk('creator'); const mkRoom = (name, state, area, extra = {}) => call('POST', '/rooms', t, { name, shoppingPlatform: 'Temu', targetAmount: 3000000, visibility: 'PUBLIC', state, area, ...extra });
  assert.equal((await mkRoom('NoLoc', 'Narnia', 'x')).s, 400); assert.equal((await call('POST', '/rooms', t, { name: 'nolocation', shoppingPlatform: 'Temu', targetAmount: 100000, visibility: 'PUBLIC' })).s, 400);
  for (const [n1, s, a] of [['Wuse Room', 'FCT (Abuja)', 'Wuse'], ['Lekki Room', 'lagos', 'Lekki'], ['Ikeja Room', 'Lagos', 'Ikeja']]) assert.equal((await mkRoom(n1, s, a)).s, 201);
  await mkRoom('Secret Ikeja', 'Lagos', 'Ikeja', { visibility: 'PRIVATE' });
  const near = await call('GET', '/rooms?sort=nearby&nearState=Lagos&nearArea=ikeja'); assert.deepEqual(near.j.map((r) => [r.name, r.match]), [['Ikeja Room', 'area'], ['Lekki Room', 'state'], ['Wuse Room', null]]);
  assert.deepEqual((await call('GET', '/rooms?state=FCT')).j.map((r) => r.name), ['Wuse Room']); assert.deepEqual((await call('GET', '/rooms?state=Lagos&area=Lekki')).j.map((r) => r.name), ['Lekki Room']);
  assert.ok(!near.j.some((r) => r.name === 'Secret Ikeja')); assert.equal(near.j[0].participants, undefined); assert.equal(near.j[0].invitationTokenHash, undefined);
});
test('pay-as-you-go over HTTP: drafts do not count; webhook confirms; second payer blocked when full', { skip }, async () => {
  const a = await mk('a'), b = await mk('b'), c = await mk('c'); const created = await call('POST', '/rooms', a.t, { name: 'Pay room', shoppingPlatform: 'Shein', targetAmount: 1000000, bufferPercentage: 0, visibility: 'PUBLIC', state: 'Lagos', area: 'Yaba' }); const id = created.j.room._id;
  for (const x of [b, c]) assert.equal((await call('POST', `/rooms/${id}/join`, x.t)).s, 200);
  assert.equal((await call('POST', `/rooms/${id}/products`, b.t, { items: [{ name: 'Bag', price: 600000, quantity: 1 }] })).s, 201); assert.equal((await call('POST', `/rooms/${id}/products`, c.t, { items: [{ name: 'Shoe', price: 600000, quantity: 1 }] })).s, 201);
  let room = await M.Room.findById(id); assert.equal(room.acceptedProductTotal, 0); // adding products alone changes nothing
  assert.equal((await call('POST', `/orders/room/${id}/pay`, b.t, {})).s, 400); // policies must be accepted
  const pb = await call('POST', `/orders/room/${id}/pay`, b.t, { acceptPolicies: true }); assert.equal(pb.s, 200); assert.equal(pb.j.total, 660000); const refB = pb.j.reference;
  const pc = await call('POST', `/orders/room/${id}/pay`, c.t, { acceptPolicies: true }); assert.equal(pc.s, 200); // 600k held < 1M, so c may also start
  const edit = await call('PATCH', `/rooms/products/${(await M.Product.findOne({ customer: b.u._id }))._id}`, b.t, { price: 1 }); assert.equal(edit.s, 409); assert.equal(edit.j.code, 'PAYMENT_IN_PROGRESS');
  assert.equal((await webhook(refB)).status, 200); assert.equal((await webhook(refB)).status, 200); await sleep(200);
  room = await M.Room.findById(id); assert.equal(room.acceptedProductTotal, 600000); assert.equal(room.status, 'OPEN');
  assert.equal((await fetch(base + '/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': 'bad' }, body: '{}' })).status, 401);
  const cart = await call('GET', `/orders/room/${id}/cart`, b.t); assert.equal(cart.j.paidOrders.length, 1); assert.equal(cart.j.items.length, 0); assert.equal(cart.j.capacity.remaining, 400000);
  assert.equal((await call('GET', `/orders/room/${id}/cart`, (await mk('out')).t)).s, 403);
  await webhook(pc.j.reference); await sleep(600); room = await M.Room.findById(id); assert.equal(room.status, 'CLOSED'); assert.equal(room.acceptedProductTotal, 1200000);
});
test('shipping access control and the buyer payment path', { skip }, async () => {
  const mod = await mk('mod', 'MODERATOR'), other = await mk('othermod', 'MODERATOR'), admin = await mk('adm', 'ADMIN'), buyer = await mk('buyer'), buyer2 = await mk('buyer2'), stranger = await mk('stranger');
  const created = await call('POST', '/rooms', buyer.t, { name: 'Ship room', shoppingPlatform: 'Temu', targetAmount: 100000, bufferPercentage: 0, visibility: 'PUBLIC', state: 'Oyo', area: 'Bodija' }); const id = created.j.room._id; await call('POST', `/rooms/${id}/join`, buyer2.t);
  await M.Room.updateOne({ _id: id }, { assignedModerator: mod.u._id });
  assert.equal((await call('GET', `/shipping/rooms/${id}`, mod.t)).s, 409); // still open
  for (const x of [buyer, buyer2]) { await call('POST', `/rooms/${id}/products`, x.t, { items: [{ name: 'Item', price: 60000, quantity: 1 }] }); const p = await call('POST', `/orders/room/${id}/pay`, x.t, { acceptPolicies: true }); await webhook(p.j.reference); }
  await sleep(600); assert.equal((await M.Room.findById(id)).status, 'CLOSED');
  assert.equal((await call('GET', `/shipping/rooms/${id}`, buyer.t)).s, 403); assert.equal((await call('GET', `/shipping/rooms/${id}`, other.t)).s, 403); assert.equal((await call('GET', `/shipping/rooms/${id}`)).s, 401);
  const view = await call('GET', `/shipping/rooms/${id}`, mod.t); assert.equal(view.s, 200); assert.equal(view.j.buyers.length, 2); assert.equal((await call('GET', `/shipping/rooms/${id}`, admin.t)).s, 200);
  const [o1, o2] = view.j.buyers.map((b) => b.order._id);
  assert.equal((await call('PUT', `/shipping/rooms/${id}/fees`, mod.t, { fees: [{ orderId: o1, amount: 50 }] })).s, 400); // below the ₦1 minimum
  assert.equal((await call('POST', `/shipping/rooms/${id}/fees/bulk`, mod.t, { orderIds: [o1, o2], amount: 250000 })).s, 200);
  assert.equal((await call('POST', `/shipping/rooms/${id}/publish`, other.t)).s, 403); assert.equal((await call('POST', `/shipping/rooms/${id}/publish`, mod.t)).j.published, 2);
  const inv = (await call('GET', '/shipping/mine', buyer.t)).j[0]; assert.equal(inv.amount, 250000); assert.equal((await call('GET', `/shipping/invoices/${inv._id}`, stranger.t)).s, 404);
  assert.equal((await call('POST', `/shipping/invoices/${inv._id}/pay`, buyer.t, {})).s, 400); const pay = await call('POST', `/shipping/invoices/${inv._id}/pay`, buyer.t, { acceptPolicies: true }); assert.equal(pay.s, 200);
  for (const verb of ['PATCH', 'PUT', 'POST']) assert.equal((await call(verb, `/shipping/invoices/${inv._id}/paid`, mod.t, { status: 'PAID' })).s, 404); // no endpoint can mark an invoice paid
  assert.equal((await M.ShippingInvoice.findById(inv._id)).status, 'PUBLISHED'); await webhook(pay.j.reference); await sleep(300);
  assert.equal((await M.ShippingInvoice.findById(inv._id)).status, 'PAID'); assert.equal((await M.ShippingInvoice.findOne({ room: id, customer: buyer2.u._id })).status, 'PUBLISHED');
  const kinds = await M.Payment.find({ order: inv.order._id }).distinct('kind'); assert.deepEqual(kinds.sort(), ['PRODUCT', 'SHIPPING']); // separate transactions
  assert.equal((await call('PUT', `/shipping/rooms/${id}/fees`, mod.t, { fees: [{ orderId: inv.order._id, amount: 100000 }] })).j.results[0].ok, false); // paid fee is locked
  const after = (await call('GET', `/shipping/rooms/${id}`, mod.t)).j.totals; assert.deepEqual([after.received, after.outstanding], [250000, 250000]);
});
