// One-off migration for databases created before "pay as you go" + separate shipping invoices.
//   node --env-file=.env src/scripts/migrate-payment-first.js
import mongoose from 'mongoose';
import { Order, Product, Room } from '../models/index.js';
await mongoose.connect(process.env.MONGODB_URI);
try { await Order.collection.dropIndex('room_1_customer_1'); console.log('dropped old unique orders index'); } catch { console.log('old orders index already gone'); }
await Order.syncIndexes(); let locked = 0;
for (const o of await Order.find({ paymentStatus: 'PAID', orderStatus: { $ne: 'CANCELLED' } })) { const r = await Product.updateMany({ _id: { $in: o.products }, status: 'ACTIVE' }, { locked: true, order: o._id }); locked += r.modifiedCount; }
for (const room of await Room.find({ status: 'OPEN' })) { const agg = await Order.aggregate([{ $match: { room: room._id, paymentStatus: 'PAID', orderStatus: { $ne: 'CANCELLED' } } }, { $group: { _id: null, t: { $sum: '$productSubtotal' } } }]); await Room.updateOne({ _id: room._id }, { acceptedProductTotal: agg[0]?.t || 0 }); }
console.log(`locked ${locked} paid products; recomputed totals of open rooms from paid orders only`); await mongoose.disconnect();
