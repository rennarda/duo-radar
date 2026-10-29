import test from 'node:test';
import assert from 'node:assert/strict';
import { availableItems, getPickup, pickupUrl, variants } from '../src/apple.js';

test('pickup request includes all eight Duo variants', () => {
  const url = pickupUrl('B2 4JH');
  assert.equal(url.searchParams.get('location'), 'B2 4JH');
  assert.match(url.pathname, /^\/uk\/shop\//);
  assert.equal([...url.searchParams.keys()].filter(k => k.startsWith('parts.')).length, 8);
});

test('only eligible, available items at watched stores are alerted', () => {
  const sku = variants[0].sku;
  const stores = [
    { storeNumber: 'R250', storeName: 'West 14th Street', partsAvailability: { [sku]: { pickupDisplay: 'available', storePickEligible: true } } },
    { storeNumber: 'R251', storeName: 'Other', partsAvailability: { [sku]: { pickupDisplay: 'available', storePickEligible: true } } },
    { storeNumber: 'R252', storeName: 'Unavailable', partsAvailability: { [sku]: { pickupDisplay: 'unavailable', storePickEligible: true } } }
  ];
  const result = availableItems(stores, ['R250', 'R252']);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, `R250:${sku}`);
  assert.match(result[0].url, /apple\.com\/uk\/shop\/buy-iphone\/iphone-duo/);
});

test('unexpected Apple response fails closed', async () => {
  await assert.rejects(getPickup('B2 4JH', [variants[0].sku], async () => ({ ok: true, json: async () => ({ body: { stores: [] } }) })), /unexpected/);
});
