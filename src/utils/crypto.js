import crypto from 'crypto';
const key = () => crypto.scryptSync(process.env.ENCRYPTION_KEY || 'dev-only', 'o2g', 32);
export function encrypt(plain) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); const enc = Buffer.concat([c.update(String(plain)), c.final()]); return [iv, c.getAuthTag(), enc].map((b) => b.toString('hex')).join('.'); }
export function decrypt(s) { const [iv, tag, enc] = s.split('.').map((h) => Buffer.from(h, 'hex')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString(); }
