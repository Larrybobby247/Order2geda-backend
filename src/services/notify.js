import { Notification, User } from '../models/index.js';
import { render } from './emailTemplates.js';
let _io; export const setIo = (io) => { _io = io; };
async function deliverEmail({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY) return;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, html, text }) });
  if (!r.ok) throw new Error('Resend ' + r.status); // throwing lets BullMQ retry
}
let queue;
if (process.env.REDIS_URL) {
  const { Queue, Worker } = await import('bullmq'); const { default: Redis } = await import('ioredis');
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue('email', { connection, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 1000, removeOnFail: false } });
  if (process.env.RUN_WORKER !== 'false') new Worker('email', (job) => deliverEmail(job.data), { connection, concurrency: 5 }); // or run src/worker.js separately
}
function dispatch(payload) {
  if (queue) queue.add('send', payload).catch((e) => console.error('enqueue', e.message));
  else deliverEmail(payload).catch((e) => console.error('email failed', e.message));
}
export const sendTemplate = (to, template, data) => dispatch({ to, ...render(template, data) });
export const sendEmail = (to, subject, text) => sendTemplate(to, 'notification', { title: subject, body: text });
export const queueStats = async () => (queue ? queue.getJobCounts('waiting', 'active', 'failed', 'delayed') : null);
let fcm;
async function sendPush(tokens, title, body) {
  if (!tokens?.length || !process.env.FIREBASE_SERVICE_ACCOUNT) return;
  try {
    if (!fcm) { const admin = (await import('firebase-admin')).default; admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); fcm = admin.messaging(); }
    await fcm.sendEachForMulticast({ tokens, notification: { title, body } });
  } catch (e) { console.error('push failed', e.message); }
}
const pathFor = (e) => (e?.kind === 'Room' ? `/app/rooms/${e.id}` : e?.kind === 'Order' ? '/app/orders' : e?.kind === 'Invoice' ? `/app/shipping/${e.id}` : '/app/notifications');
export async function notify(userId, type, title, body, relatedEntity, io = _io, email = null) {
  try {
    const n = await Notification.create({ recipient: userId, type, title, body, relatedEntity, channels: ['in-app', 'email', 'push'] });
    io?.to(`user:${userId}`).emit('notification:new', n);
    const u = await User.findById(userId).select('email notificationPreferences fcmTokens');
    if (u?.notificationPreferences?.email !== false) {
      const t = email?.template || 'notification';
      sendTemplate(u.email, t, { title, body, path: pathFor(relatedEntity), ...(email?.data || {}), name: u.fullName });
    }
    if (u?.notificationPreferences?.push !== false) sendPush(u.fcmTokens, title, body);
  } catch (e) { console.error('notify failed', e.message); }
}
