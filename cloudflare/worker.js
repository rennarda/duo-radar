import { buildPushPayload } from '@block65/webcrypto-web-push';
import { availableItems, getPickup, variants } from '../src/apple.js';

const stockSkus = variants.map(item => item.sku);
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

async function pushNew(env, item) {
  const payload = JSON.stringify({ title: `iPhone Duo available at ${item.storeName}`, body: `${item.storage} ${item.color} · Tap to order for collection`, url: item.url, tag: item.key });
  const subscriptions = (await env.DB.prepare('SELECT endpoint, subscription FROM subscriptions').all()).results;
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  for (const row of subscriptions) {
    try {
      const subscription = JSON.parse(row.subscription);
      const request = await buildPushPayload({ data: payload, options: { ttl: 60 } }, subscription, vapid);
      const response = await fetch(subscription.endpoint, request);
      if (response.status === 404 || response.status === 410) await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(row.endpoint).run();
      else if (!response.ok) console.error('Push failed', response.status);
    } catch (error) { console.error('Push failed', error); }
  }
}

export async function check(env) {
  const now = Date.now();
  const lock = await env.DB.prepare('UPDATE radar SET lock_until = ? WHERE id = 1 AND lock_until < ?').bind(now + 45000, now).run();
  if (lock.meta.changes !== 1) return;
  try {
    const current = await settings(env);
    if (!current.location || !current.watched.length) return;
    const stores = await getPickup(current.location, stockSkus);
    const matches = availableItems(stores, current.watched);
    const old = new Set(current.available.map(item => item.key));
    const fresh = matches.filter(item => !old.has(item.key));
    await env.DB.prepare('UPDATE radar SET available = ?, last_check = ?, last_error = NULL WHERE id = 1').bind(JSON.stringify(matches), new Date().toISOString()).run();
    for (const item of fresh) await pushNew(env, item);
  } catch (error) {
    console.error('Apple pickup check failed', error);
    await env.DB.prepare('UPDATE radar SET last_check = ?, last_error = ? WHERE id = 1').bind(new Date().toISOString(), String(error.message || error)).run();
  } finally {
    await env.DB.prepare('UPDATE radar SET lock_until = 0 WHERE id = 1').run();
  }
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
        return respond({ ...current, subscriptionCount: count.count, publicKey: env.VAPID_PUBLIC_KEY, variants });
      }
      if (request.method === 'GET' && url.pathname === '/api/stores') {
        const stores = await getPickup(url.searchParams.get('location') || '', [stockSkus[0]]);
        return respond({ stores: stores.map(store => ({ number: store.storeNumber, name: store.storeName, city: store.city, state: store.state, address: store.address?.address2 })) });
      }
      if (request.method === 'POST' && url.pathname === '/api/settings') {
        const input = await request.json();
        if (!validLocation(input.location) || !Array.isArray(input.watched) || input.watched.length > 20 || input.watched.some(store => !/^R\d{3,4}$/.test(store))) return respond({ error: 'Choose a UK city or postcode and up to 20 Apple stores.' }, 400);
        await env.DB.prepare('UPDATE radar SET location = ?, watched = ?, available = ? WHERE id = 1').bind(input.location.trim(), JSON.stringify([...new Set(input.watched)]), '[]').run();
        context.waitUntil(check(env));
        return respond({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/subscribe') {
        const subscription = await request.json();
        if (typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://') || typeof subscription.keys?.p256dh !== 'string' || typeof subscription.keys?.auth !== 'string') return respond({ error: 'Invalid push subscription.' }, 400);
        await env.DB.prepare('INSERT OR REPLACE INTO subscriptions(endpoint, subscription) VALUES (?, ?)').bind(subscription.endpoint, JSON.stringify(subscription)).run();
        return respond({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/check') {
        await check(env);
        return respond({ ok: true, lastError: (await settings(env)).lastError });
      }
      return respond({ error: 'Not found' }, 404);
    } catch (error) { console.error(error); return respond({ error: error.message }, 500); }
  },
  scheduled(_event, env, context) { context.waitUntil(check(env)); }
};
