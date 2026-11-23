import { Router } from 'express';
import { requireAuth, wrap } from '../middleware/auth.js';
import { cached } from '../services/cache.js';
import { mapNominatim } from '../utils/locations.js';
const r = Router();
// Reverse geocode (lat/lng -> Nigerian state + candidate areas). The member always confirms or corrects the result in the UI.
r.get('/reverse', requireAuth, wrap(async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 4 || lat > 14.2 || lng < 2.6 || lng > 15) return res.status(400).json({ error: 'That location is outside Nigeria' });
  try {
    res.json(await cached(`geo:${lat.toFixed(3)}:${lng.toFixed(3)}`, 7 * 86400, async () => {
      const base = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org';
      const x = await fetch(`${base}/reverse?format=jsonv2&addressdetails=1&zoom=14&accept-language=en&lat=${lat}&lon=${lng}`, { headers: { 'User-Agent': `Order2Geda/1.0 (${process.env.SUPPORT_EMAIL || 'support@order2geda.com'})` }, signal: AbortSignal.timeout(6000) });
      if (!x.ok) throw new Error('geocoder ' + x.status); return mapNominatim(await x.json());
    }));
  } catch { res.status(502).json({ error: 'We could not detect your area. Please choose it manually.' }); }
}));
export default r;
