// IndexedDB wrapper for offline storage
// Stores: pending readings queue, cached assets, cached last-5 readings

const DB_NAME = 'waterops';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // Pending readings waiting to sync
      if (!db.objectStoreNames.contains('pending')) {
        const store = db.createObjectStore('pending', { keyPath: 'localId' });
        store.createIndex('type', 'type');
        store.createIndex('createdAt', 'createdAt');
      }

      // Cached asset lists (sites, wells, etc.)
      if (!db.objectStoreNames.contains('assetCache')) {
        db.createObjectStore('assetCache', { keyPath: 'key' });
      }

      // Cached last-5 readings per asset
      if (!db.objectStoreNames.contains('readingsCache')) {
        db.createObjectStore('readingsCache', { keyPath: 'cacheKey' });
      }
    };

    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

// ─── Pending Queue ───────────────────────────────────────────────────────────

export async function queueReading(type, data) {
  const db = await openDB();
  const localId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item = { localId, type, data, createdAt: new Date().toISOString(), synced: false };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').add(item);
    tx.oncomplete = () => resolve(localId);
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getPendingReadings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readonly');
    const req = tx.objectStore('pending').getAll();
    req.onsuccess = () => resolve(req.result.filter(r => !r.synced));
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function markSynced(localIds) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    const store = tx.objectStore('pending');
    let done = 0;
    for (const id of localIds) {
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) {
          req.result.synced = true;
          store.put(req.result);
        }
        if (++done === localIds.length) resolve();
      };
    }
    tx.onerror = (e) => reject(e.target.error);
    if (localIds.length === 0) resolve();
  });
}

export async function getPendingCount() {
  const pending = await getPendingReadings();
  return pending.length;
}

export async function clearAllPending() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').clear();
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function exportPendingAsCSV() {
  const pending = await getPendingReadings();
  if (pending.length === 0) return null;

  // Collect all unique keys across all readings
  const allKeys = new Set(['localId', 'type', 'createdAt']);
  for (const item of pending) {
    for (const k of Object.keys(item.data || {})) allKeys.add(k);
  }
  const keys = [...allKeys];

  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = [keys.join(',')];
  for (const item of pending) {
    rows.push(keys.map(k => {
      if (k === 'localId') return escape(item.localId);
      if (k === 'type') return escape(item.type);
      if (k === 'createdAt') return escape(item.createdAt);
      return escape((item.data || {})[k]);
    }).join(','));
  }

  return rows.join('\n');
}

// ─── Asset Cache ─────────────────────────────────────────────────────────────

export async function cacheAssets(assets) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('assetCache', 'readwrite');
    const store = tx.objectStore('assetCache');
    store.put({ key: 'all', ...assets, cachedAt: new Date().toISOString() });
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getCachedAssets() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('assetCache', 'readonly');
    const req = tx.objectStore('assetCache').get('all');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

// ─── Readings Cache ───────────────────────────────────────────────────────────

export async function cacheLastReadings(type, assetId, readings) {
  const db = await openDB();
  const cacheKey = `${type}:${assetId}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('readingsCache', 'readwrite');
    tx.objectStore('readingsCache').put({ cacheKey, readings, cachedAt: new Date().toISOString() });
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getCachedLastReadings(type, assetId) {
  const db = await openDB();
  const cacheKey = `${type}:${assetId}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('readingsCache', 'readonly');
    const req = tx.objectStore('readingsCache').get(cacheKey);
    req.onsuccess = () => resolve(req.result ? req.result.readings : []);
    req.onerror = (e) => reject(e.target.error);
  });
}

// Prepend a just-entered reading to the local cache so it shows immediately
export async function prependToCache(type, assetId, reading) {
  const existing = await getCachedLastReadings(type, assetId);
  const updated = [reading, ...existing].slice(0, 5);
  await cacheLastReadings(type, assetId, updated);
}
