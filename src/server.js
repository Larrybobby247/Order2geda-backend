import './config/env.js';
import http from 'http';
import mongoose from 'mongoose';
import { app } from './app.js';
import { setIo } from './services/notify.js';
import { sweepExpired } from './services/sweeper.js';
import { initSockets } from './sockets/index.js';
await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 20 });
const server = http.createServer(app);
const io = initSockets(server); app.set('io', io); setIo(io);
setInterval(() => sweepExpired().catch((e) => console.error('sweep', e.message)), 60000).unref(); // cancels stale unpaid orders in closed rooms
server.listen(process.env.PORT || 5000, () => console.log('Order2Geda API listening'));
