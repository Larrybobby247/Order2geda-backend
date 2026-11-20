import { Router } from 'express';
import { validSignature } from '../services/paystack.js';
import { markPaid } from '../services/orderService.js';
const r = Router();
r.post('/paystack', async (req, res) => {
  if (!validSignature(req.body, req.headers['x-paystack-signature'])) return res.sendStatus(401);
  try { const ev = JSON.parse(req.body.toString()); if (ev.event === 'charge.success') await markPaid(ev.data.reference, ev.data.amount); res.sendStatus(200); }
  catch (e) { console.error('webhook', e.message); res.sendStatus(500); }
});
export default r;
