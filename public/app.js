const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('duo-token') || '';
let knownStores = [];
let currentWatched = [];
let storesRequested = false;
async function api(path, options = {}) {
  const response = await fetch('/api' + path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function text(el, value) { el.textContent = value; }
function render(state) {
  $('auth').hidden = true; $('dashboard').hidden = false;
  currentWatched = state.watched;
  $('location').value ||= state.location;
  const external = state.checkMode === 'external';
  $('search-form').hidden = external;
  $('check').hidden = external;
  if (!storesRequested && state.location) { storesRequested = true; queueMicrotask(() => $('search-form').requestSubmit()); }
  const overdue = state.lastCheck && Date.now() - Date.parse(state.lastCheck) > 3 * 60 * 1000;
  text($('status'), !state.watched.length ? 'Waiting for setup' : state.lastError ? 'Check failed' : overdue ? 'Checker offline' : state.lastCheck ? 'Monitoring' : 'Waiting for checker');
  text($('checked'), state.lastCheck ? new Date(state.lastCheck).toLocaleTimeString() : '—');
  text($('count'), state.watched.length);
  text($('result-count'), `${state.available.length} FOUND`);
  text($('last-error'), state.lastError || '');
  const list = $('results'); list.replaceChildren();
  if (!state.available.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = state.watched.length ? 'No matching iPhone Duo is available for pickup right now.' : 'Select stores to begin monitoring.'; list.append(p); }
  for (const item of state.available) {
    const row = document.createElement('div'); row.className = 'result';
    const name = document.createElement('strong'); name.textContent = `iPhone Duo · ${item.storage} ${item.color}`;
    const store = document.createElement('small'); store.textContent = item.storeName;
    const info = document.createElement('div'); info.append(name, store);
    const link = document.createElement('a'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Order at Apple ↗';
    row.append(info, link); list.append(row);
  }
}
async function load() { try { render(await api('/state')); } catch { $('auth').hidden = false; $('dashboard').hidden = true; } }
$('auth-form').addEventListener('submit', async event => { event.preventDefault(); token = $('token').value; try { const state = await api('/state'); sessionStorage.setItem('duo-token', token); text($('auth-error'), ''); render(state); } catch (error) { text($('auth-error'), error.message); } });
$('search-form').addEventListener('submit', async event => {
  event.preventDefault(); text($('settings-message'), 'Finding Apple Stores…');
  try { const result = await api('/stores?location=' + encodeURIComponent($('location').value)); knownStores = result.stores; const list = $('stores'); list.replaceChildren();
    for (const store of knownStores) { const label = document.createElement('label'); label.className = 'store'; const input = document.createElement('input'); input.type = 'checkbox'; input.value = store.number; input.checked = currentWatched.includes(store.number); const info = document.createElement('span'); const name = document.createElement('strong'); name.textContent = store.name; const address = document.createElement('small'); address.textContent = [store.address, store.city, store.state].filter(Boolean).join(', '); info.append(name, address); label.append(input, info); list.append(label); } $('save').disabled = !knownStores.length; text($('settings-message'), `${knownStores.length} stores found. Select the ones to watch.`);
  } catch (error) { text($('settings-message'), error.message); }
});
$('save').addEventListener('click', async () => { try { const watched = [...document.querySelectorAll('.store input:checked')].map(x => x.value); if (!watched.length) throw new Error('Select at least one store.'); await api('/settings', { method: 'POST', body: JSON.stringify({ location: $('location').value, watched }) }); text($('settings-message'), 'Saved. Monitoring has started.'); await load(); } catch (error) { text($('settings-message'), error.message); } });
function decodeKey(base64) { const padding = '='.repeat((4 - base64.length % 4) % 4); const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, char => char.charCodeAt(0)); }
$('notify').addEventListener('click', async () => { try { if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push is unavailable here. Use HTTPS or localhost; on iPhone, add this page to Home Screen.'); const permission = await Notification.requestPermission(); if (permission !== 'granted') throw new Error('Notification permission was not granted.'); const state = await api('/state'); await navigator.serviceWorker.register('/sw.js'); const registration = await navigator.serviceWorker.ready; const existing = await registration.pushManager.getSubscription(); const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(state.publicKey) }); await api('/subscribe', { method: 'POST', body: JSON.stringify(subscription) }); const test = await api('/test-push', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) }); text($('notify-message'), test.sent ? 'Push alerts are enabled. A test notification was sent.' : 'Push is enabled, but the test notification did not go through. Check notification settings on this device.'); } catch (error) { text($('notify-message'), error.message); } });
$('check').addEventListener('click', async () => { try { text($('last-error'), 'Checking Apple now…'); await api('/check', { method: 'POST' }); await load(); } catch (error) { text($('last-error'), error.message); } });
if (token) load();
setInterval(() => { if (token) load(); }, 20000);
