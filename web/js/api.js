async function req(method, url, body, opts = {}) {
  const init = { method, keepalive: !!opts.keepalive };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch { /* keep status text */ }
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}

export const api = {
  list: () => req('GET', '/api/projects'),
  create: (name) => req('POST', '/api/projects', { name }),
  get: (id) => req('GET', `/api/projects/${id}`),
  save: (id, patch, opts) => req('PUT', `/api/projects/${id}`, patch, opts),
  remove: (id) => req('DELETE', `/api/projects/${id}`),
  duplicate: (id) => req('POST', `/api/projects/${id}/duplicate`),
  importText: (text) => req('POST', '/api/projects/import', text),
  exportUrl: (id) => `/api/projects/${id}/export`,
};
