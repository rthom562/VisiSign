/* store.js — tiny client-side state: theme + current user session.
   No framework; just a small observable object. */

(function () {
  'use strict';

  const THEME_KEY = 'visisign.theme';

  const store = {
    user: null, // {id, email, fullName, role, accessLevel}

    // ── Theme ────────────────────────────────────────────────────────────────
    getTheme() {
      return localStorage.getItem(THEME_KEY) || 'system';
    },
    setTheme(theme) {
      localStorage.setItem(THEME_KEY, theme);
      document.documentElement.setAttribute('data-theme', theme);
    },
    cycleTheme() {
      const order = ['system', 'light', 'dark'];
      const next = order[(order.indexOf(this.getTheme()) + 1) % order.length];
      this.setTheme(next);
      return next;
    },
    applyTheme() {
      document.documentElement.setAttribute('data-theme', this.getTheme());
    },

    // ── Session ──────────────────────────────────────────────────────────────
    async refreshSession() {
      if (!window.api.isLoggedIn()) { this.user = null; return null; }
      try {
        const { user } = await window.api.auth.me();
        this.user = user;
      } catch (_) {
        this.user = null;
      }
      return this.user;
    },
    isRole(...roles) {
      return this.user && roles.includes(this.user.role);
    },
    clear() { this.user = null; },
  };

  window.store = store;
})();
