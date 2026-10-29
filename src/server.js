import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import webpush from 'web-push';
import { availableItems, getPickup, variants } from './apple.js';

const defaultLocation = 'B2 4JH';
const defaultStores = ['R118', 'R255', 'R308', 'R215', 'R136', 'R153'];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const dataFile = join(dataDir, 'state.json');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const pollMs = Math.max(30000, Number(process.env.POLL_SECONDS || 60) * 1000);
const token = process.env.ADMIN_TOKEN;
if (!token || token.length < 24) { console.error('Set ADMIN_TOKEN to a random value of at least 24 characters.'); process.exit(1); }
await mkdir(dataDir, { recursive: true });
let state;
try { state = JSON.parse(await readFile(dataFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { location: defaultLocation, watched: defaultStores, subscriptions: [], available: [], lastCheck: null, lastError: null, vapid: webpush.generateVAPIDKeys() }; }
if (!state.location && !state.watched?.length) { state.location = defaultLocation; state.watched = defaultStores; }
state.vapid ||= webpush.generateVAPIDKeys();
state.subscriptions ||= [];
state.watched ||= [];
state.available ||= [];
async function save() { await writeFile(dataFile + '.tmp', JSON.stringify(state, null, 2)); await import('node:fs/promises').then(fs => fs.rename(dataFile + '.tmp', dataFile)); }
await save();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:duo-radar@localhost', state.vapid.publicKey, state.vapid.privateKey);

function authorized(req) {
  const given = req.headers.authorization?.replace(/^Bearer /, '') || '';
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(res, code, body) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 50000) throw new Error('Request too large'); }
  return JSON.parse(text || '{}');
}

let checking = false;
async function check() {
  if (checking || !state.location || !state.watched.length) return;
  checking = true;
  try {
    const stores = await getPickup(state.location, variants.map(v => v.sku));
    const matches = availableItems(stores, state.watched);
    const old = new Set(state.available.map(v => v.key));
    const fresh = matches.filter(v => !old.has(v.key));
    state.available = matches;
    state.lastCheck = new Date().toISOString();
    state.lastError = null;
    await save();
    for (const item of fresh) {
      const payload = JSON.stringify({ title: `iPhone Duo available at ${item.storeName}`, body: `${item.storage} ${item.color} · Tap to order for collection`, url: item.url, tag: item.key });
      await Promise.all(state.subscriptions.map(async sub => {
        try { await webpush.sendNotification(sub, payload, { TTL: 60 }); }
        catch (error) { if ([404, 410].includes(error.statusCode)) state.subscriptions = state.subscriptions.filter(s => s.endpoint !== sub.endpoint); else console.error('Push failed:', error.message); }
      }));
    }
    if (fresh.length) await save();
  } catch (error) { state.lastError = error.message; state.lastCheck = new Date().toISOString(); await save(); console.error('Pickup check failed:', error.message); }
  finally { checking = false; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' }); return res.end(await readFile(join(root, 'public/sw.js'))); }
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(await readFile(join(root, 'public/index.html'))); }
    if (url.pathname === '/style.css' || url.pathname === '/app.js') { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); return res.end(await readFile(join(root, 'public' + url.pathname))); }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (!authorized(req)) return send(res, 401, { error: 'Enter your dashboard access token.' });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { location: state.location, watched: state.watched, available: state.available, lastCheck: state.lastCheck, lastError: state.lastError, subscriptionCount: state.subscriptions.length, publicKey: state.vapid.publicKey, variants });
    if (req.method === 'GET' && url.pathname === '/api/stores') { const location = url.searchParams.get('location') || ''; const stores = await getPickup(location, [variants[0].sku]); return send(res, 200, { stores: stores.map(s => ({ number: s.storeNumber, name: s.storeName, city: s.city, state: s.state, address: s.address?.address2 })) }); }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const input = await body(req);
      if (typeof input.location !== 'string' || !/^[A-Za-z0-9 ,.-]{2,80}$/.test(input.location) || !Array.isArray(input.watched) || input.watched.length > 20 || input.watched.some(s => !/^R\d{3,4}$/.test(s))) return send(res, 400, { error: 'Choose a UK city or postcode and up to 20 Apple stores.' });
      state.location = input.location.trim(); state.watched = [...new Set(input.watched)]; state.available = []; await save();
      void check(); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/subscribe') {
      const sub = await body(req);
      if (typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') return send(res, 400, { error: 'Invalid push subscription.' });
      state.subscriptions = state.subscriptions.filter(s => s.endpoint !== sub.endpoint); state.subscriptions.push(sub); await save(); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/check') { await check(); return send(res, 200, { ok: true, lastError: state.lastError }); }
    return send(res, 404, { error: 'Not found' });
  } catch (error) { console.error(error); send(res, 500, { error: error.message }); }
});
server.listen(port, host, () => console.log(`Duo Radar listening on http://${host}:${port}`));
setInterval(() => { void check(); }, pollMs).unref();
void check();
