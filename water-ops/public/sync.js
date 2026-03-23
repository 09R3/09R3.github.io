import { getPendingReadings, markSynced, getPendingCount } from './db.js';
import { api } from './config.js';

const SYNC_INTERVAL_MS = 30_000;
let syncTimer = null;
let onStatusChange = null;

export function setSyncStatusCallback(fn) { onStatusChange = fn; }

function notifyStatus(msg, type = 'info') {
  if (onStatusChange) onStatusChange(msg, type);
}

export async function syncNow() {
  const pending = await getPendingReadings();
  if (pending.length === 0) {
    notifyStatus('All synced', 'success');
    return { synced: 0, failed: 0 };
  }

  notifyStatus(`Syncing ${pending.length} reading(s)…`, 'info');

  try {
    const resp = await fetch(api('/api/sync/batch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pending),
    });

    if (!resp.ok) throw new Error(`Server error ${resp.status}`);
    const result = await resp.json();

    if (result.synced.length > 0) await markSynced(result.synced);

    const stillPending = await getPendingCount();
    if (stillPending === 0) {
      notifyStatus('All synced', 'success');
    } else {
      notifyStatus(`${stillPending} reading(s) pending sync`, 'warning');
    }

    return { synced: result.synced.length, failed: result.failed.length };
  } catch (e) {
    const count = await getPendingCount();
    notifyStatus(`Offline — ${count} reading(s) queued`, 'warning');
    return { synced: 0, failed: pending.length };
  }
}

export function startAutoSync() {
  stopAutoSync();
  syncTimer = setInterval(async () => {
    if (navigator.onLine) await syncNow();
  }, SYNC_INTERVAL_MS);

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
}

export function stopAutoSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
}

async function handleOnline() {
  notifyStatus('Back online — syncing…', 'info');
  await syncNow();
}

function handleOffline() {
  notifyStatus('Offline — readings will queue locally', 'warning');
}

// Try to POST a single reading or maintenance record; if it fails, queue it locally
export async function submitReading(type, data, queueFn) {
  const endpoint = type.startsWith('maintenance-')
    ? api(`/api/maintenance/${type.replace('maintenance-', '')}`)
    : api(`/api/readings/${type}`);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!resp.ok) throw new Error(`Server ${resp.status}`);
    return { ok: true, queued: false };
  } catch (e) {
    await queueFn(type, data);
    return { ok: true, queued: true };
  }
}
