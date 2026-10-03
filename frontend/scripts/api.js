/* api.js — THE ONLY bridge between the dashboard and the backend.
   The UI never builds SQL or touches data directly: it calls these methods,
   which speak to the secure REST API and return only what the server sends. */

(function () {
  'use strict';

  // If the dashboard is served by the API (dev), same origin. Otherwise set
  // window.VISISIGN_API_BASE before this script to point at the API host.
  const BASE = (window.VISISIGN_API_BASE || '') + '/api';
  const TOKEN_KEY = 'visisign.token';

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

  async function request(method, path, { body, auth = true, raw = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = getToken();
    if (auth && token) headers['Authorization'] = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (_) {
      throw new ApiClientError(0, 'network', 'Cannot reach the server. Is the backend running?');
    }

    if (raw) return res; // for CSV download etc.

    let payload = null;
    try { payload = await res.json(); } catch (_) { /* empty */ }

    if (!res.ok || (payload && payload.ok === false)) {
      const err = payload && payload.error ? payload.error : {};
      // Session expired → clear token so the UI can re-prompt.
      if (res.status === 401) setToken(null);
      throw new ApiClientError(res.status, err.code || 'error', err.message || 'Request failed');
    }
    return payload ? payload.data : null;
  }

  class ApiClientError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  const api = {
    // session
    isLoggedIn: () => !!getToken(),
    setToken,
    getToken,

    auth: {
      login: async (username, password) => {
        const data = await request('POST', '/auth/login', { body: { username, password }, auth: false });
        setToken(data.token);
        return data.user;
      },
      me: () => request('GET', '/auth/me'),
      logout: async () => {
        try { await request('POST', '/auth/logout'); } catch (_) { /* ignore */ }
        setToken(null);
      },
    },

    visits: {
      guestSignIn: (payload) => request('POST', '/visits/guest/signin', { body: payload, auth: false }),
      onsite: () => request('GET', '/visits/onsite', { auth: false }),
      signOut: (visitId) => request('POST', `/visits/${encodeURIComponent(visitId)}/signout`, { body: {}, auth: false }),
      live: (params = {}) => request('GET', '/visits/live' + qs(params)),
      search: (params = {}) => request('GET', '/visits' + qs(params)),
    },

    // PUBLIC branding: colours, logo, wording, ticker and terms. Needed by
    // every page before anyone logs in — the kiosk never logs in at all.
    branding: () => request('GET', '/branding', { auth: false }),

    kiosk: {
      register: (deviceId, name) => request('POST', '/kiosk/register', { body: { deviceId, name }, auth: false }),
      status: (deviceId) => request('GET', '/kiosk/status' + qs({ deviceId }), { auth: false }),
      // Passing the device id tailors the reply to THIS kiosk's printer and
      // label size, so several kiosks can drive several printers.
      config: (deviceId) => request('GET', '/kiosk/config' + qs({ deviceId }), { auth: false }),
      // admin
      list: () => request('GET', '/kiosk'),
      accept: (code) => request('POST', `/kiosk/${encodeURIComponent(code)}/accept`, { body: {} }),
      reject: (code) => request('POST', `/kiosk/${encodeURIComponent(code)}/reject`, { body: {} }),
      revoke: (code) => request('POST', `/kiosk/${encodeURIComponent(code)}/revoke`, { body: {} }),
      update: (code, patch) => request('PATCH', `/kiosk/${encodeURIComponent(code)}`, { body: patch }),
      remove: (code) => request('DELETE', `/kiosk/${encodeURIComponent(code)}`),
    },

    print: {
      printers: () => request('GET', '/print/printers'),                 // admin
      info: (name) => request('GET', '/print/printer-info' + qs({ name })), // admin
      test: (printer) => request('POST', '/print/test', { body: { printer } }), // admin
      badge: (visitId, kioskId) =>
        request('POST', `/print/badge/${encodeURIComponent(visitId)}`, { body: { kioskId }, auth: false }),
      transport: () => request('GET', '/print/transport'),                 // admin
      jobs: (params = {}) => request('GET', '/print/jobs' + qs(params)),   // admin
    },

    reservations: {
      slots: (date) => request('GET', '/reservations/slots' + qs({ date }), { auth: false }),
      create: (payload) => request('POST', '/reservations', { body: payload, auth: false }),
      current: (date) => request('GET', '/reservations/current' + qs({ date }), { auth: false }),
      checkIn: (id) => request('POST', `/reservations/${encodeURIComponent(id)}/checkin`, { body: {}, auth: false }),
      // admin
      adminList: (date) => request('GET', '/reservations/admin' + qs({ date })),
      cancel: (id) => request('POST', `/reservations/${encodeURIComponent(id)}/cancel`, { body: {} }),
    },

    admin: {
      overview: () => request('GET', '/admin/overview'),
      alerts: () => request('GET', '/admin/alerts'),
      resolveAlert: (id) => request('POST', `/admin/alerts/${id}/resolve`, { body: {} }),
      users: (params = {}) => request('GET', '/admin/users' + qs(params)),
      createUser: (payload) => request('POST', '/admin/users', { body: payload }),
      updateUser: (id, patch) => request('PATCH', `/admin/users/${encodeURIComponent(id)}`, { body: patch }),
      deleteUser: (id) => request('DELETE', `/admin/users/${encodeURIComponent(id)}`),
      settings: () => request('GET', '/admin/settings'),
      // The full schema (groups, types, ranges, help) plus current values. This
      // is what builds the Settings panel, so new settings need no UI work.
      settingsSchema: () => request('GET', '/admin/settings/schema'),
      updateSettings: (patch) => request('PUT', '/admin/settings', { body: patch }),

      // Appearance templates
      templates: () => request('GET', '/admin/templates'),
      applyTemplate: (key) => request('POST', `/admin/templates/${encodeURIComponent(key)}/apply`, { body: {} }),

      // .vsf customisation files
      exportCustomisation: async (name) => {
        const res = await request('GET', '/admin/customisation/export' + qs({ name }), { raw: true });
        if (!res.ok) throw new ApiClientError(res.status, 'export', 'Could not export the customisation file');
        return res.text();
      },
      importCustomisation: (bundle, dryRun) =>
        request('POST', '/admin/customisation/import', { body: { bundle, dryRun: !!dryRun } }),

      // Signed terms
      signatures: (params = {}) => request('GET', '/admin/signatures' + qs(params)),
      signature: (visitId) => request('GET', `/admin/signatures/${encodeURIComponent(visitId)}`),
      sites: () => request('GET', '/admin/sites'),
      rooms: (siteId) => request('GET', '/admin/rooms' + qs({ siteId })),
      logs: (params = {}) => request('GET', '/admin/logs' + qs(params)),
      exportUrl: () => BASE + '/admin/export/visits.csv',
      exportCsv: async (params = {}) => {
        const res = await request('GET', '/admin/export/visits.csv' + qs(params), { raw: true });
        if (!res.ok) throw new ApiClientError(res.status, 'export', 'Export failed');
        return res.text();
      },
    },
  };

  function qs(params) {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (!entries.length) return '';
    return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  window.api = api;
  window.ApiClientError = ApiClientError;
})();
