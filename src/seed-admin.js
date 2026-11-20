import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User, Wallet } from './models/index.js';
await mongoose.connect(process.env.MONGODB_URI);
const { ADMIN_EMAIL: email, ADMIN_PASSWORD: pw } = process.env;
if (!email || !pw) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD');
const u = await User.create({ fullName: 'Admin', email, passwordHash: await bcrypt.hash(pw, 12), role: 'ADMIN', emailVerified: true, referralCode: 'ADMIN001' });
await Wallet.create({ user: u._id }); console.log('Admin created'); process.exit(0);
