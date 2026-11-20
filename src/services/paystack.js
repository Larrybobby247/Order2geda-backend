import crypto from 'crypto';
const base = 'https://api.paystack.co';
const h = () => ({ Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' });
export const initialize = async (email, amount, reference, callback_url) => (await fetch(base + '/transaction/initialize', { method: 'POST', headers: h(), body: JSON.stringify({ email, amount, reference, callback_url }) })).json();
export const verify = async (reference) => (await fetch(`${base}/transaction/verify/${encodeURIComponent(reference)}`, { headers: h() })).json();
export const validSignature = (raw, sig) => !!sig && crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex') === sig;
