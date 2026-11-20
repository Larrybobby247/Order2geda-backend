import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { ChatRead, Room, Product, Message } from '../models/index.js';
import { requireAuth, requireVerified, wrap } from '../middleware/auth.js';
import { closingThreshold } from '../utils/money.js';
import { getSetting } from '../services/settings.js';
import { cached } from '../services/cache.js';
import { sendTemplate } from '../services/notify.js';
import { fetchPreview } from '../utils/linkPreview.js';
import { addProducts, adjustTotal, closeIfThresholdReached } from '../services/roomService.js';
const r = Router();
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const pub = 'name description shoppingPlatform category coverImage targetAmount bufferPercentage closingThreshold acceptedProductTotal status deadline participants createdAt visibility';
r.get('/', wrap(async (req, res) => {
  const { q, platform, status = 'OPEN', sort = 'new', page = 1 } = req.query;
  const f = { visibility: 'PUBLIC', status }; // private rooms never listed
  if (platform) f.shoppingPlatform = platform;
  if (q) f.name = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const rooms = await cached('rooms:' + JSON.stringify(req.query), 15, () => Room.find(f).select(pub).sort(sort === 'progress' ? { acceptedProductTotal: -1 } : { createdAt: -1 }).skip((page - 1) * 20).limit(20).lean());
  res.json(rooms.map((x) => ({ ...x, participantCount: x.participants.length, participants: undefined })));
}));
const create = z.object({ name: z.string().min(3), description: z.string().optional(), shoppingPlatform: z.string(), category: z.string().optional(), coverImage: z.string().url().optional(), targetAmount: z.number().int().positive(), bufferPercentage: z.number().min(0).optional(), visibility: z.enum(['PUBLIC', 'PRIVATE']), deadline: z.string().optional() });
r.post('/', requireAuth, requireVerified, wrap(async (req, res) => {
  const d = create.parse(req.body);
  const buf = Math.min(d.bufferPercentage ?? await getSetting('bufferPercentage'), await getSetting('maxBufferPercentage'));
  let token; const extra = {};
  if (d.visibility === 'PRIVATE') { token = crypto.randomBytes(24).toString('hex'); extra.invitationTokenHash = hash(token); extra.invitationExpiresAt = new Date(Date.now() + 7 * 864e5); }
  const room = await Room.create({ ...d, ...extra, bufferPercentage: buf, closingThreshold: closingThreshold(d.targetAmount, buf), creator: req.user._id, participants: [req.user._id] });
  res.status(201).json({ room, inviteToken: token });
}));
r.post('/join-by-token', requireAuth, wrap(async (req, res) => {
  const room = await Room.findOneAndUpdate({ invitationTokenHash: hash(req.body.token || ''), invitationExpiresAt: { $gt: new Date() }, status: 'OPEN' }, { $addToSet: { participants: req.user._id } });
  room ? res.json({ roomId: room._id }) : res.status(404).json({ error: 'Invalid or expired invitation' });
}));
r.get('/mine', requireAuth, wrap(async (req, res) => {
  const rooms = await Room.find({ participants: req.user._id }).select(pub).sort({ updatedAt: -1 }).limit(50).lean();
  const reads = await ChatRead.find({ user: req.user._id, room: { $in: rooms.map((x) => x._id) } }).lean();
  res.json(await Promise.all(rooms.map(async (x) => ({ ...x, participantCount: x.participants.length, participants: undefined,
    unread: await Message.countDocuments({ room: x._id, deletedAt: null, sender: { $ne: req.user._id }, createdAt: { $gt: reads.find((y) => y.room.equals(x._id))?.lastReadAt || new Date(0) } }) }))));
}));
r.patch('/products/:pid', requireAuth, wrap(async (req, res) => { // edit while OPEN; total adjusted atomically, product goes back to PENDING review
  const d = prod.partial().parse(req.body);
  const p = await Product.findOne({ _id: req.params.pid, customer: req.user._id, status: 'ACTIVE' }); if (!p) return res.status(404).json({ error: 'Not found' });
  const before = p.price * p.quantity; Object.assign(p, d, { verificationStatus: 'PENDING' }); const delta = p.price * p.quantity - before;
  const upd = await Room.updateOne({ _id: p.room, status: 'OPEN' }, { $inc: { acceptedProductTotal: delta } });
  if (!upd.matchedCount) return res.status(409).json({ error: 'Room is closed; products are read-only' });
  try { await p.save(); } catch (e) { await Room.updateOne({ _id: p.room }, { $inc: { acceptedProductTotal: -delta } }); throw e; }
  await closeIfThresholdReached(p.room, req.app.get('io')); req.app.get('io')?.to(`room:${p.room}`).emit('room:progress-updated', { roomId: p.room }); res.json(p);
}));
r.delete('/products/:pid', requireAuth, wrap(async (req, res) => {
  const p = await Product.findOne({ _id: req.params.pid, customer: req.user._id, status: 'ACTIVE' });
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!(await Room.exists({ _id: p.room, status: 'OPEN' }))) return res.status(409).json({ error: 'Room is closed; products are read-only' });
  await p.deleteOne(); await adjustTotal(p.room, -p.price * p.quantity, req.app.get('io')); res.json({ deleted: true });
}));
r.get('/:id', requireAuth, wrap(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  const ok = room && (room.visibility === 'PUBLIC' || req.user.role === 'ADMIN' || room.participants.some((p) => p.equals(req.user._id)) || room.assignedModerator?.equals(req.user._id));
  ok ? res.json(room) : res.status(404).json({ error: 'Not found' });
}));
r.post('/:id/join', requireAuth, requireVerified, wrap(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (room.visibility === 'PRIVATE') return res.status(403).json({ error: 'Use your invitation link' });
  const upd = await Room.findOneAndUpdate({ _id: room._id, status: 'OPEN' }, { $addToSet: { participants: req.user._id } });
  if (!upd) return res.status(409).json({ error: 'Room is closed' });
  if (!upd.participants.some((p) => p.equals(req.user._id))) { const m = await Message.create({ room: room._id, content: `${req.user.fullName} joined the room`, messageType: 'SYSTEM' }); req.app.get('io')?.to(`room:${room._id}`).emit('message:new', m); }
  req.app.get('io')?.to(`room:${room._id}`).emit('room:member-joined', { userId: req.user._id }); res.json({ joined: true });
}));
r.post('/:id/leave', requireAuth, wrap(async (req, res) => {
  const n = await Room.updateOne({ _id: req.params.id, status: 'OPEN', creator: { $ne: req.user._id } }, { $pull: { participants: req.user._id } }); res.json({ left: n.modifiedCount === 1 });
}));
r.post('/:id/invite/regenerate', requireAuth, wrap(async (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  const n = await Room.updateOne({ _id: req.params.id, creator: req.user._id, visibility: 'PRIVATE' }, { invitationTokenHash: hash(token), invitationExpiresAt: new Date(Date.now() + 7 * 864e5) });
  n.matchedCount ? res.json({ inviteToken: token }) : res.status(404).json({ error: 'Not found' });
}));
r.post('/:id/invite/revoke', requireAuth, wrap(async (req, res) => { await Room.updateOne({ _id: req.params.id, creator: req.user._id }, { $unset: { invitationTokenHash: 1 } }); res.json({ revoked: true }); }));
const prod = z.object({ name: z.string().min(1), price: z.number().int().positive(), quantity: z.number().int().positive(), image: z.string().url().optional(), productUrl: z.string().url().optional(), category: z.string().optional(), size: z.string().optional(), colour: z.string().optional(), description: z.string().optional(), instructions: z.string().optional() });
r.get('/:id/products/mine', requireAuth, wrap(async (req, res) => res.json(await Product.find({ room: req.params.id, customer: req.user._id }).lean())));
r.post('/:id/products', requireAuth, requireVerified, wrap(async (req, res) => res.status(201).json(await addProducts(req.params.id, req.user._id, z.array(prod).min(1).max(30).parse(req.body.items), req.app.get('io')))));
r.get('/:id/messages', requireAuth, wrap(async (req, res) => {
  const room = await Room.findOne({ _id: req.params.id, $or: [{ participants: req.user._id }, { assignedModerator: req.user._id }] }).select('_id');
  if (!room) return res.status(403).json({ error: 'Not a member' });
  const f = { room: room._id, deletedAt: null }; if (req.query.before) f.createdAt = { $lt: new Date(req.query.before) };
  res.json((await Message.find(f).sort({ createdAt: -1 }).limit(40).populate('sender', 'fullName profileImage role').populate('replyTo', 'content').lean()).reverse());
}));
r.get('/:id/members', requireAuth, wrap(async (req, res) => {
  const room = await Room.findOne({ _id: req.params.id, $or: [{ participants: req.user._id }, { assignedModerator: req.user._id }, ...(req.user.role === 'ADMIN' ? [{}] : [])] }).populate('participants', 'fullName profileImage').populate('assignedModerator', 'fullName').lean();
  if (!room) return res.status(403).json({ error: 'Not a member' });
  res.json({ members: room.participants, moderator: room.assignedModerator, creator: room.creator });
}));
r.post('/:id/read', requireAuth, wrap(async (req, res) => { await ChatRead.updateOne({ user: req.user._id, room: req.params.id }, { lastReadAt: new Date() }, { upsert: true }); res.json({ ok: true }); }));
r.post('/:id/invite/email', requireAuth, wrap(async (req, res) => { // note: issues a fresh link, which replaces the previous one
  const email = z.string().email().parse(req.body.email);
  const room = await Room.findOne({ _id: req.params.id, creator: req.user._id, visibility: 'PRIVATE', status: 'OPEN' }); if (!room) return res.status(404).json({ error: 'Not found' });
  const token = crypto.randomBytes(24).toString('hex'); await Room.updateOne({ _id: room._id }, { invitationTokenHash: hash(token), invitationExpiresAt: new Date(Date.now() + 7 * 864e5) });
  sendTemplate(email, 'roomInvitation', { inviter: req.user.fullName, room: room.name, platform: room.shoppingPlatform, path: `/invite/${token}` }); res.json({ sent: true });
}));
r.get('/:id/link-preview', requireAuth, wrap(async (req, res) => {
  if (!(await Room.exists({ _id: req.params.id, $or: [{ participants: req.user._id }, { assignedModerator: req.user._id }] }))) return res.status(403).json({ error: 'Not a member' });
  try { res.json(await cached('lp:' + req.query.url, 3600, () => fetchPreview(String(req.query.url)))); } catch { res.status(404).json({ error: 'No preview' }); }
}));
export default r;
