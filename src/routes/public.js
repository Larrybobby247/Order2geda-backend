import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User, Room, Order } from '../models/index.js';
import { wrap } from '../middleware/auth.js';
import { cached } from '../services/cache.js';
import { sendTemplate } from '../services/notify.js';
const r = Router();
// Real, aggregate-only numbers for the landing page (cached 5 min).
r.get('/stats', wrap(async (req, res) => res.json(await cached('public:stats', 300, async () => {
  const [members, openRooms, paidOrders] = await Promise.all([User.countDocuments({ role: 'CUSTOMER' }), Room.countDocuments({ visibility: 'PUBLIC', status: 'OPEN' }), Order.countDocuments({ paymentStatus: 'PAID' })]);
  return { members, openRooms, paidOrders };
}))));
const limiter = rateLimit({ windowMs: 3600e3, limit: 5, message: { error: 'Too many messages. Please try again later.' } });
r.post('/contact', limiter, wrap(async (req, res) => {
  const d = z.object({ name: z.string().min(2).max(80), email: z.string().email(), subject: z.string().max(120).optional(), message: z.string().min(10).max(2000), website: z.string().max(0).optional() }).parse(req.body); // `website` = honeypot
  if (!process.env.SUPPORT_EMAIL || !process.env.RESEND_API_KEY) return res.status(503).json({ error: 'The contact form is unavailable right now. Please email us directly.' });
  sendTemplate(process.env.SUPPORT_EMAIL, 'notification', { title: `Contact form: ${d.subject || 'New message'}`, body: `From: ${d.name} <${d.email}> — reply to this address.\n\n${d.message}`, name: 'Support team', path: '/admin/dashboard' });
  res.json({ sent: true });
}));
export default r;
