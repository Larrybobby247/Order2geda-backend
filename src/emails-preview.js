import fs from 'fs'; import { render, TEMPLATE_NAMES } from './services/emailTemplates.js';
const S = { name: 'Ada Obi', path: '/app/home', email: 'mod@example.com', days: 3, room: 'Temu Home Haul', platform: 'Temu', inviter: 'Chidi', reference: 'O2G-7F3A91C2', subtotal: 2000000, commission: 200000, shipping: 100000, amount: 2300000, status: 'COMPLETED', transfer: 'TRF-88213', payoutReference: 'PAY-1042', title: 'Order update', body: 'Your order has shipped from China.' };
fs.mkdirSync('../documentation/email-previews', { recursive: true });
for (const n of TEMPLATE_NAMES) fs.writeFileSync(`../documentation/email-previews/${n}.html`, render(n, S).html);
fs.writeFileSync('../documentation/email-previews/index.html', '<h2>Order2Geda email previews</h2>' + TEMPLATE_NAMES.map((n) => `<p><a href="${n}.html">${n}</a></p>`).join(''));
console.log('previews written:', TEMPLATE_NAMES.length);
