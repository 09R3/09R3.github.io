// Shared config — imported by app.js and sync.js
// Server URL is stored in localStorage so it survives page reloads
// and can be changed from the settings screen without touching code.

const KEY = 'wo_server_url';

export function getBaseUrl() {
  return localStorage.getItem(KEY) || window.location.origin;
}

export function setBaseUrl(url) {
  const clean = url.replace(/\/$/, ''); // strip trailing slash
  localStorage.setItem(KEY, clean);
}

export function clearBaseUrl() {
  localStorage.removeItem(KEY);
}

// Prefix any API path with the configured server URL
export const api = (path) => `${getBaseUrl()}${path}`;
