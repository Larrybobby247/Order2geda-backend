// Validates configuration at startup and prints which integrations are ON/OFF. See documentation/ENV.md.
const e = process.env, prod = e.NODE_ENV === 'production';
const missing = ['MONGODB_URI', 'JWT_SECRET'].filter((k) => !e[k]);
if (missing.length) { console.error(`✖ Missing required env: ${missing.join(', ')} (see documentation/ENV.md)`); process.exit(1); }
const problems = [];
if (prod) {
  if (e.JWT_SECRET.length < 32) problems.push('JWT_SECRET must be 32+ characters in production');
  if (!e.ENCRYPTION_KEY || e.ENCRYPTION_KEY.length < 32) problems.push('ENCRYPTION_KEY must be set (32+ characters) in production — it encrypts refund bank details and 2FA secrets');
  if (!e.CLIENT_URL) problems.push('CLIENT_URL is required in production (CORS, email links, Paystack callback)');
}
if (problems.length) { console.error(problems.map((p) => `✖ ${p}`).join('\n')); process.exit(1); }
if (!prod && !e.ENCRYPTION_KEY) console.warn('⚠ ENCRYPTION_KEY not set: using an insecure development key');
const on = (v) => (v ? 'ON ' : 'OFF');
console.log(['Order2Geda configuration',
  `  Paystack payments ........ ${on(e.PAYSTACK_SECRET_KEY)}  ${e.PAYSTACK_SECRET_KEY ? '' : '(payments and webhooks will fail)'}`,
  `  Resend emails ............ ${on(e.RESEND_API_KEY && e.EMAIL_FROM)}  ${e.RESEND_API_KEY ? '' : '(emails are skipped)'}`,
  `  Cloudinary uploads ....... ${on(e.CLOUDINARY_CLOUD_NAME && e.CLOUDINARY_API_KEY && e.CLOUDINARY_API_SECRET)}`,
  `  Redis (cache/queue/ws) ... ${on(e.REDIS_URL)}  ${e.REDIS_URL ? '' : '(single-instance mode)'}`,
  `  Push (Firebase) .......... ${on(e.FIREBASE_SERVICE_ACCOUNT)}`,
  `  Sentry ................... ${on(e.SENTRY_DSN)}`,
  `  Contact form ............. ${on(e.SUPPORT_EMAIL && e.RESEND_API_KEY)}`,
  `  Email verification enforced ${on(e.REQUIRE_EMAIL_VERIFICATION === 'true')}`].join('\n'));
