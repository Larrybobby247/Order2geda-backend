import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
const r = Router();
// Signed upload: the browser uploads straight to Cloudinary; the API secret never leaves the server.
r.get('/sign', requireAuth, (req, res) => {
  const folder = { product: 'o2g/products', room: 'o2g/rooms', avatar: 'o2g/avatars', proof: 'o2g/proof', chat: 'o2g/chat' }[req.query.kind] || 'o2g/misc';
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto.createHash('sha1').update(toSign + process.env.CLOUDINARY_API_SECRET).digest('hex');
  res.json({ cloudName: process.env.CLOUDINARY_CLOUD_NAME, apiKey: process.env.CLOUDINARY_API_KEY, timestamp, folder, signature });
});
export default r;
