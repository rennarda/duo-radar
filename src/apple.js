export const variants = [
  ['MK2E4QN/A', '256GB', 'Night Sky'],
  ['MK2D4QN/A', '256GB', 'Star White'],
  ['MK2G4QN/A', '512GB', 'Night Sky'],
  ['MK2F4QN/A', '512GB', 'Star White'],
  ['MK2J4QN/A', '1TB', 'Night Sky'],
  ['MK2H4QN/A', '1TB', 'Star White'],
  ['MK2L4QN/A', '2TB', 'Night Sky'],
  ['MK2K4QN/A', '2TB', 'Star White']
].map(([sku, storage, color]) => ({ sku, storage, color }));

export function orderUrl(sku) {
  return `https://www.apple.com/uk/shop/buy-iphone/iphone-duo?product=${encodeURIComponent(sku)}`;
}

export function pickupUrl(location, skus = variants.map(v => v.sku)) {
  const url = new URL('https://www.apple.com/uk/shop/retail/pickup-message');
  skus.forEach((sku, i) => url.searchParams.set(`parts.${i}`, sku));
  url.searchParams.set('location', location);
  return url;
}

export async function getPickup(location, skus, fetcher = fetch) {
  if (!/^[A-Za-z0-9 ,.-]{2,80}$/.test(location)) throw new Error('Enter a valid UK city or postcode.');
  const response = await fetcher(pickupUrl(location, skus), {
    headers: { accept: 'application/json', 'user-agent': 'DuoRadar/1.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Apple pickup check returned HTTP ${response.status}`);
  const data = await response.json();
  if (data?.head?.status !== '200' || !Array.isArray(data?.body?.stores)) throw new Error('Apple returned an unexpected pickup response.');
  return data.body.stores;
}

export function availableItems(stores, watched) {
  const matches = [];
  for (const store of stores) {
    if (!watched.includes(store.storeNumber)) continue;
    for (const variant of variants) {
      const part = store.partsAvailability?.[variant.sku];
      if (part?.pickupDisplay === 'available' && part.storePickEligible === true) {
        matches.push({ key: `${store.storeNumber}:${variant.sku}`, storeNumber: store.storeNumber,
          storeName: store.storeName, ...variant, url: orderUrl(variant.sku) });
      }
    }
  }
  return matches;
}
