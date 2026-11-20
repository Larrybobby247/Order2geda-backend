import dns from 'dns/promises'; import net from 'net';
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const l = ip.toLowerCase(); return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || (l.startsWith('::ffff:') && isPrivateIp(l.slice(7)));
}
const meta = (html, prop) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i')); return m?.[1]; };
// SSRF-hardened: https only, public IPs only, no redirects, 4s timeout, 200KB cap. (Residual DNS-rebinding risk: run behind an egress proxy in production.)
export async function fetchPreview(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) throw new Error('Unsupported URL');
  if (net.isIP(u.hostname) ? isPrivateIp(u.hostname) : (await dns.lookup(u.hostname, { all: true })).some((a) => isPrivateIp(a.address))) throw new Error('Blocked address');
  const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Order2GedaLinkPreview/1.0', Accept: 'text/html' } });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) throw new Error('No preview');
  let html = ''; const reader = res.body.getReader(); const dec = new TextDecoder();
  while (html.length < 200000) { const { done, value } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }); if (/<\/head>/i.test(html)) break; }
  reader.cancel().catch(() => {});
  const img = meta(html, 'og:image'); let image; try { const iu = new URL(img, u); if (iu.protocol === 'https:') image = iu.href; } catch {}
  return { host: u.hostname, title: (meta(html, 'og:title') || html.match(/<title[^>]*>([^<]*)/i)?.[1] || '').trim().slice(0, 140), description: (meta(html, 'og:description') || '').slice(0, 220), image };
}
