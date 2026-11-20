import crypto from 'crypto'; // RFC 6238 TOTP (SHA-1, 30s, 6 digits) — compatible with Google/Microsoft Authenticator, Authy
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newSecret() { let bits = ''; for (const x of crypto.randomBytes(20)) bits += x.toString(2).padStart(8, '0'); let out = ''; for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
const decode = (s) => { let bits = ''; for (const c of s.replace(/=+$/, '')) bits += A.indexOf(c).toString(2).padStart(5, '0'); const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); };
export function hotp(secret, counter, digits = 6) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter)); const h = crypto.createHmac('sha1', secret).update(b).digest(); const o = h[19] & 15; const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]; return String(n % 10 ** digits).padStart(digits, '0'); }
export const totp = (b32, t = Date.now()) => hotp(decode(b32), Math.floor(t / 30000));
export const verifyTotp = (b32, code, t = Date.now()) => [-1, 0, 1].some((w) => totp(b32, t + w * 30000) === String(code).trim());
export const otpauth = (email, secret) => `otpauth://totp/Order2Geda:${encodeURIComponent(email)}?secret=${secret}&issuer=Order2Geda`;
