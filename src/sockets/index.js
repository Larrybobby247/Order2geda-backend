import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { Room, Message } from '../models/index.js';
const CLOUD = 'https://res.cloudinary.com/';
export function initSockets(httpServer) {
  const io = new Server(httpServer, { cors: { origin: process.env.CLIENT_URL, credentials: true } });
  if (process.env.REDIS_URL) Promise.all([import('ioredis'), import('@socket.io/redis-adapter')]).then(([{ default: Redis }, { createAdapter }]) => { const pub = new Redis(process.env.REDIS_URL); io.adapter(createAdapter(pub, pub.duplicate())); }).catch((e) => console.error('redis adapter', e.message));
  io.use((s, next) => { try { s.user = jwt.verify(s.handshake.auth.token, process.env.JWT_SECRET); next(); } catch { next(new Error('unauthorized')); } });
  const presence = async (roomId) => { const socks = await io.in(`room:${roomId}`).fetchSockets(); io.to(`room:${roomId}`).emit('presence:update', { online: new Set(socks.map((x) => x.user.id)).size }); };
  io.on('connection', (s) => {
    s.join(`user:${s.user.id}`);
    s.on('room:join', async (roomId, ack) => {
      const ok = await Room.exists({ _id: roomId, $or: [{ participants: s.user.id }, { assignedModerator: s.user.id }] });
      if (!ok) return ack?.({ error: 'forbidden' }); s.join(`room:${roomId}`); ack?.({ ok: true }); presence(roomId);
    });
    s.on('room:leave', (roomId) => { s.leave(`room:${roomId}`); presence(roomId); });
    s.on('disconnecting', () => { const rooms = [...s.rooms].filter((r) => r.startsWith('room:')); setTimeout(() => rooms.forEach((r) => presence(r.slice(5))), 400); });
    s.on('message:typing', (roomId) => s.rooms.has(`room:${roomId}`) && s.to(`room:${roomId}`).emit('message:typing', { userId: s.user.id }));
    s.on('message:new', async ({ roomId, content = '', replyTo: reply, attachments = [] }, ack) => {
      let replyTo = reply;
      const atts = (Array.isArray(attachments) ? attachments : []).filter((u) => typeof u === 'string' && u.startsWith(CLOUD)).slice(0, 3);
      if (!s.rooms.has(`room:${roomId}`) || (!content.trim() && !atts.length) || content.length > 2000) return ack?.({ error: 'invalid' });
      if (replyTo && !(await Message.exists({ _id: replyTo, room: roomId }))) replyTo = undefined;
      const m = await Message.create({ room: roomId, sender: s.user.id, content: content.trim(), replyTo, attachments: atts }); // persist before broadcast
      await m.populate([{ path: 'sender', select: 'fullName profileImage role' }, { path: 'replyTo', select: 'content sender', populate: { path: 'sender', select: 'fullName' } }]);
      io.to(`room:${roomId}`).emit('message:new', m); ack?.({ ok: true, id: m._id });
    });
  });
  return io;
}
