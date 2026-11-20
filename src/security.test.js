import test from 'node:test'; import assert from 'node:assert';
import { hotp, verifyTotp, newSecret, totp } from './utils/totp.js'; import { isPrivateIp } from './utils/linkPreview.js'; import { encrypt, decrypt } from './utils/crypto.js';
test('TOTP matches RFC 6238 vector', () => assert.equal(hotp(Buffer.from('12345678901234567890'), 1, 6), '287082'));
test('TOTP verifies current code, rejects wrong code', () => { const s = newSecret(); assert.ok(verifyTotp(s, totp(s))); assert.ok(!verifyTotp(s, '000000') || totp(s) === '000000'); });
test('private/loopback/link-local IPs are blocked', () => { for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateIp(ip), ip); for (const ip of ['8.8.8.8', '1.1.1.1']) assert.ok(!isPrivateIp(ip), ip); });
test('encryption round-trips and is non-deterministic', () => { const a = encrypt('0123456789'), b = encrypt('0123456789'); assert.notEqual(a, b); assert.equal(decrypt(a), '0123456789'); });
