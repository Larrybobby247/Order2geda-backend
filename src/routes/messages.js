import { Router } from 'express';
import { Message, Room } from '../models/index.js';
import { requireAuth, wrap } from '../middleware/auth.js';
const r = Router(); r.use(requireAuth);
const canModerate = async (roomId, user) => user.role === 'ADMIN' || !!(await Room.exists({ _id: roomId, assignedModerator: user._id }));
r.post('/:id/pin', wrap(async (req, res) => {
  const m = await Message.findById(req.params.id); if (!m || !(await canModerate(m.room, req.user))) return res.status(403).json({ error: 'Forbidden' });
  m.pinned = !m.pinned; await m.save(); req.app.get('io')?.to(`room:${m.room}`).emit('message:pinned', { id: m._id, pinned: m.pinned }); res.json({ pinned: m.pinned });
}));
r.delete('/:id', wrap(async (req, res) => {
  const m = await Message.findById(req.params.id); if (!m) return res.status(404).json({ error: 'Not found' });
  if (!(m.sender?.equals(req.user._id) || (await canModerate(m.room, req.user)))) return res.status(403).json({ error: 'Forbidden' });
  m.deletedAt = new Date(); await m.save(); req.app.get('io')?.to(`room:${m.room}`).emit('message:deleted', { id: m._id }); res.json({ deleted: true });
}));
r.post('/room/:roomId/announce', wrap(async (req, res) => {
  if (!(await canModerate(req.params.roomId, req.user))) return res.status(403).json({ error: 'Forbidden' });
  const m = await Message.create({ room: req.params.roomId, sender: req.user._id, content: String(req.body.content).slice(0, 2000), messageType: 'ANNOUNCEMENT', pinned: !!req.body.pin });
  req.app.get('io')?.to(`room:${req.params.roomId}`).emit('message:new', m); res.status(201).json(m);
}));
export default r;
