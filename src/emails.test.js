import test from 'node:test'; import assert from 'node:assert';
import { render, TEMPLATE_NAMES } from './services/emailTemplates.js';
const d = { name: 'Ada <b>Obi</b>', reference: 'O2G-1', amount: 2300000, subtotal: 2000000, commission: 200000, shipping: 100000, path: '/app/orders', status: 'COMPLETED', title: '<script>x</script>', body: 'b' };
test('every template renders subject, html and text', () => { for (const n of TEMPLATE_NAMES) { const r = render(n, d); assert.ok(r.subject && r.html.includes('Order') && r.text.length > 10, n); } });
test('payment email shows reference and formatted total', () => { const r = render('paymentConfirmation', d); assert.ok(r.html.includes('O2G-1') && r.html.includes('₦23,000')); });
test('user input is HTML-escaped', () => { const r = render('notification', d); assert.ok(!r.html.includes('<script>x') && !r.html.includes('Ada <b>')); });
test('CTA links are absolute', () => { process.env.CLIENT_URL = 'https://order2geda.com'; assert.ok(render('verifyEmail', { ...d, path: '/verify-email/abc' }).html.includes('https://order2geda.com/verify-email/abc')); });
