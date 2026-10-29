import { buildPushPayload } from '@block65/webcrypto-web-push';
import { availableItems, variants } from '../src/apple.js';

const chosenStores = [
  { number: 'R118', name: 'Birmingham', city: 'Birmingham' },
  { number: 'R255', name: 'Touchwood Centre', city: 'Solihull' },
  { number: 'R308', name: 'Highcross', city: 'Leicester' },
  { number: 'R215', name: 'Manchester Arndale', city: 'Manchester' },
  { number: 'R136', name: 'Trafford Centre', city: 'Manchester' },
  { number: 'R153', name: 'Meadowhall', city: 'Sheffield' }
];
const respond = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const validLocation = location => typeof location === 'string' && /^[A-Za-z0-9 ,.-]{2,80}$/.test(location);

function authorized(request, env) {
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  const expected = env.ADMIN_TOKEN || '';
  if (given.length !== expected.length || expected.length < 24) return false;
  let difference = 0;
  for (let i = 0; i < given.length; i++) difference |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

async function settings(env) {
  const row = await env.DB.prepare('SELECT location, watched, available, last_check, last_error FROM radar WHERE id = 1').first();
  if (!row) throw new Error('D1 schema is missing. Apply cloudflare/schema.sql.');
  return { location: row.location, watched: JSON.parse(row.watched), available: JSON.parse(row.available), lastCheck: row.last_check, lastError: row.last_error };
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function vapidKeys(env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  }
  const subject = env.VAPID_SUBJECT || 'https://github.com/rennarda/duo-radar';
  let row = await env.DB.prepare('SELECT public_key, private_key FROM vapid_keys WHERE id = 1').first();
  if (!row) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicBytes = new Uint8Array(65);
    publicBytes[0] = 4;
    publicBytes.set(decodeBase64Url(publicJwk.x), 1);
    publicBytes.set(decodeBase64Url(publicJwk.y), 33);
    await env.DB.prepare('INSERT OR IGNORE INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)')
      .bind(encodeBase64Url(publicBytes), privateJwk.d).run();
    row = await env.DB.prepare('SELECT public_key, private_key FROM vapid_keys WHERE id = 1').first();
  }
  return { subject, publicKey: row.public_key, privateKey: row.private_key };
}

async function sendPush(env, notification, onlyEndpoint) {
  const payload = JSON.stringify(notification);
  const query = onlyEndpoint
    ? env.DB.prepare('SELECT endpoint, subscription FROM subscriptions WHERE endpoint = ?').bind(onlyEndpoint)
    : env.DB.prepare('SELECT endpoint, subscription FROM subscriptions');
  const subscriptions = (await query.all()).results;
  if (!subscriptions.length) return 0;
  const vapid = await vapidKeys(env);
  let sent = 0;
  for (const row of subscriptions) {
    try {
      const subscription = JSON.parse(row.subscription);
      const request = await buildPushPayload({ data: payload, options: { ttl: 300, urgency: 'high' } }, subscription, vapid);
      const response = await fetch(subscription.endpoint, request);
      if (response.status === 404 || response.status === 410) await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(row.endpoint).run();
      else if (!response.ok) console.error('Push failed', response.status);
      else sent++;
    } catch (error) { console.error('Push failed', error); }
  }
  return sent;
}

async function pushNew(env, item) {
  return sendPush(env, { title: `iPhone Duo available at ${item.storeName}`, body: `${item.storage} ${item.color} · Tap to order for collection`, url: item.url, tag: item.key });
}

async function ingest(env, input) {
  if (typeof input?.error === 'string') {
    await env.DB.prepare('UPDATE radar SET last_check = ?, last_error = ? WHERE id = 1')
      .bind(new Date().toISOString(), input.error.slice(0, 300)).run();
    return { ok: false, error: input.error.slice(0, 300) };
  }
  if (!Array.isArray(input?.stores) || input.stores.length > 30 || input.stores.some(store =>
    !/^R\d{3,4}$/.test(store?.storeNumber) || typeof store.storeName !== 'string' || typeof store.partsAvailability !== 'object')) {
    return null;
  }
  const current = await settings(env);
  const matches = availableItems(input.stores, current.watched);
  const old = new Set(current.available.map(item => item.key));
  const fresh = matches.filter(item => !old.has(item.key));
  await env.DB.prepare('UPDATE radar SET available = ?, last_check = ?, last_error = NULL WHERE id = 1')
    .bind(JSON.stringify(matches), new Date().toISOString()).run();
  for (const item of fresh) await pushNew(env, item);
  return { ok: true, available: matches.length, alerts: fresh.length };
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return respond({ ok: true });
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!authorized(request, env)) return respond({ error: 'Enter your dashboard access token.' }, 401);
    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const current = await settings(env);
        const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM subscriptions').first();
        return respond({ ...current, subscriptionCount: count.count, publicKey: (await vapidKeys(env)).publicKey, variants, checkMode: 'external' });
      }
      if (request.method === 'GET' && url.pathname === '/api/stores') {
        return respond({ stores: chosenStores });
      }
      if (request.method === 'POST' && url.pathname === '/api/settings') {
        const input = await request.json();
        if (!validLocation(input.location) || !Array.isArray(input.watched) || input.watched.length > 20 || input.watched.some(store => !/^R\d{3,4}$/.test(store))) return respond({ error: 'Choose a UK city or postcode and up to 20 Apple stores.' }, 400);
        await env.DB.prepare('UPDATE radar SET location = ?, watched = ?, available = ? WHERE id = 1').bind(input.location.trim(), JSON.stringify([...new Set(input.watched)]), '[]').run();
        return respond({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/ingest') {
        const result = await ingest(env, await request.json());
        return result ? respond(result) : respond({ error: 'Invalid stock report.' }, 400);
      }
      if (request.method === 'POST' && url.pathname === '/api/subscribe') {
        const subscription = await request.json();
        if (typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://') || typeof subscription.keys?.p256dh !== 'string' || typeof subscription.keys?.auth !== 'string') return respond({ error: 'Invalid push subscription.' }, 400);
        await env.DB.prepare('INSERT OR REPLACE INTO subscriptions(endpoint, subscription) VALUES (?, ?)').bind(subscription.endpoint, JSON.stringify(subscription)).run();
        return respond({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/test-push') {
        const input = await request.json();
        if (typeof input.endpoint !== 'string' || !input.endpoint.startsWith('https://') || input.endpoint.length > 2048) return respond({ error: 'Invalid push endpoint.' }, 400);
        const sent = await sendPush(env, { title: 'Duo Radar is ready', body: 'You will get an alert when a watched iPhone Duo is available.', url: new URL('/', request.url).href, tag: 'duo-radar-test' }, input.endpoint);
        return respond({ ok: true, sent });
      }
      if (request.method === 'POST' && url.pathname === '/api/check') {
        return respond({ error: 'Checks run from your home computer about every minute.' }, 409);
      }
      return respond({ error: 'Not found' }, 404);
    } catch (error) { console.error(error); return respond({ error: error.message }, 500); }
  },
};
