import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline/promises';
import { getPickup, variants } from '../src/apple.js';

const base = new URL(process.env.RADAR_URL || 'https://duo-radar.rennard-dc1.workers.dev');
const testStock = process.argv.includes('--test-stock');
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) {
  throw new Error('RADAR_URL must use HTTPS.');
}
const tokenDirectory = join(homedir(), '.duo-radar');
const tokenPath = join(tokenDirectory, 'admin-token');
if (process.argv.includes('--reset-token')) await rm(tokenPath, { force: true });

let token = process.env.RADAR_ADMIN_TOKEN;
if (!token) {
  try { token = (await readFile(tokenPath, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!token) {
  if (!process.stdin.isTTY) throw new Error('Run this in a terminal to enter the dashboard password.');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  token = (await prompt.question('Paste your Duo Radar dashboard password: ')).trim();
  prompt.close();
  if (token.length < 24) throw new Error('The dashboard password must have at least 24 characters.');
  await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, token, { mode: 0o600 });
  console.log('Password saved in your user profile for future starts.');
}
if (token.length < 24) throw new Error('The saved dashboard password is too short. Run with --reset-token.');

async function api(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Duo Radar: ${data.error || `HTTP ${response.status}`}`);
  return data;
}

async function scan() {
  let state;
  try { state = await api('/api/state'); }
  catch (error) { console.error(new Date().toLocaleString(), error.message); return false; }
  if (!state.watched.length) { console.log(new Date().toLocaleString(), 'No stores selected.'); return true; }
  try {
    const stores = await getPickup(state.location, variants.map(item => item.sku));
    const watched = new Set(state.watched);
    const found = new Set(stores.map(store => store.storeNumber));
    const missing = state.watched.filter(number => !found.has(number));
    if (missing.length) throw new Error(`Apple omitted watched stores: ${missing.join(', ')}`);
    const selectedStores = stores.filter(store => watched.has(store.storeNumber));
    let test;
    if (testStock) {
      for (const store of selectedStores) {
        const variant = variants.find(item => {
          const part = store.partsAvailability?.[item.sku];
          return part?.pickupDisplay !== 'available' || part?.storePickEligible !== true;
        });
        if (!variant) continue;
        store.partsAvailability = {
          ...store.partsAvailability,
          [variant.sku]: { ...store.partsAvailability?.[variant.sku], pickupDisplay: 'available', storePickEligible: true }
        };
        test = { storeNumber: store.storeNumber, sku: variant.sku };
        console.log(`TEST ONLY: simulating ${variant.storage} ${variant.color} at ${store.storeName}.`);
        break;
      }
      if (!test) throw new Error('Every watched configuration is already available; there is no unavailable item to simulate.');
    }
    const result = await api('/api/ingest', { stores: selectedStores, ...(test ? { test } : {}) });
    if (test) {
      console.log(`TEST ONLY: sent to ${result.alerts} subscribed device(s). The dashboard test row expires in five minutes.`);
      return true;
    }
    console.log(new Date().toLocaleString(), `Checked ${watched.size} stores; ${result.available} available; ${result.alerts} new alerts.`);
    return true;
  } catch (error) {
    console.error(new Date().toLocaleString(), error.message);
    if (!testStock) {
      try { await api('/api/ingest', { error: error.message }); }
      catch (reportError) { console.error('Could not report check failure:', reportError.message); }
    }
    return false;
  }
}

if (!process.argv.includes('--once') && !testStock) console.log('Duo Radar is checking Apple once a minute. Keep this computer on and this window open.');
do {
  const started = Date.now();
  const successful = await scan();
  if (process.argv.includes('--once') || testStock) {
    if (!successful) process.exitCode = 1;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(1000, 60000 - (Date.now() - started))));
} while (true);
