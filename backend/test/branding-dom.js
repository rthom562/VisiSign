'use strict';

// Runs frontend/scripts/branding.js against a minimal DOM stub.
//
// Branding turns operator-supplied settings into CSS and into DOM text, which is
// the one place in VisiSign where a bad value could become a style injection.
// There is no browser in CI, so rather than leave that path untested this
// builds just enough of a DOM to execute the real file and assert on what it
// did — colours applied, bad values rejected, logo swapped, ticker built.
//
//   node test/branding-dom.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let pass = 0;
const failures = [];

function test(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL ${name} -- ${err.message}`); }
}

// ── A DOM, cut down to exactly what branding.js touches ─────────────────────
function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    _classes: new Set(),
    _text: '',
    _html: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this._html = ''; this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; },
    // branding.js assigns `className` directly, so keep it in step with the
    // class set that classList reads.
    get className() { return [...this._classes].join(' '); },
    set className(v) {
      this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
    },
    classList: {
      add(...c) { c.forEach((x) => el._classes.add(x)); },
      remove(...c) { c.forEach((x) => el._classes.delete(x)); },
      contains(c) { return el._classes.has(c); },
      toggle(c, on) { if (on) el._classes.add(c); else el._classes.delete(c); },
    },
    appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
    setAttribute(k, v) { el.attributes[k] = String(v); },
    getAttribute(k) { return el.attributes[k]; },
    remove() {
      if (!el.parentNode) return;
      const i = el.parentNode.children.indexOf(el);
      if (i >= 0) el.parentNode.children.splice(i, 1);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

function buildDom() {
  const html = makeElement('html');
  html.style.setProperty = (k, v) => { html.style[k] = v; };

  const body = makeElement('body');
  const brandMarks = [makeElement('span'), makeElement('span')];
  brandMarks.forEach((m) => m.classList.add('brand-mark'));
  const brandNames = [makeElement('span')];

  const byId = {};

  const document = {
    documentElement: html,
    body,
    title: 'VisiSign — Kiosk',
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => {
      if (sel === '.brand-mark') return brandMarks;
      if (sel === '.brand-name') return brandNames;
      return [];
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
  };

  // The ticker is found again by id on re-apply, so register it on append.
  const origAppend = body.appendChild.bind(body);
  body.appendChild = (child) => { if (child.id) byId[child.id] = child; return origAppend(child); };
  const origRemove = makeElement('x').remove;
  void origRemove;

  return { document, html, body, brandMarks, brandNames, byId };
}

function loadBranding(dom, store) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'scripts', 'branding.js'), 'utf8'
  );
  const sandbox = {
    document: dom.document,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = opts && opts.detail; },
    window: {},
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'branding.js' });
  return sandbox;
}

const GOOD = {
  orgName: 'Acme Industries',
  welcome: { title: 'Welcome', text: 'Sign in please' },
  logo: null,
  markText: 'AC',
  theme: 'light',
  radius: 20,
  colors: {
    brand: '#7c3aed', brand600: '#6d28d9', brandContrast: '#ffffff',
    bg: '#f8f6fd', surface: '#ffffff', text: '#1b1430', textMuted: '#5f5577',
    border: '#e7e0f5', ok: '#16a34a', warn: '#d97706', danger: '#dc2626',
  },
  ticker: { enabled: true, text: 'Hard hats required', speed: 45, bg: '#111111', color: '#ffffff' },
  terms: { enabled: false },
};

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(function run() {
  console.log('\nVisiSign branding (DOM) tests\n');

  // ── Colours ──────────────────────────────────────────────────────────────
  {
    const dom = buildDom();
    const sb = loadBranding(dom, {});
    sb.window.visiBranding.apply(GOOD);

    test('brand colour becomes a CSS custom property', () =>
      assert.strictEqual(dom.html.style['--brand'], '#7c3aed'));
    test('every mapped colour is applied', () => {
      for (const v of ['--brand-600', '--brand-contrast', '--bg', '--surface', '--text',
        '--text-muted', '--border', '--ok', '--warn', '--danger']) {
        assert.ok(dom.html.style[v], `${v} was not set`);
      }
    });
    test('corner radius is applied with a derived small radius', () => {
      assert.strictEqual(dom.html.style['--radius'], '20px');
      assert.strictEqual(dom.html.style['--radius-sm'], '13px');
    });
  }

  // ── Bad values are refused, not written ──────────────────────────────────
  {
    const dom = buildDom();
    const sb = loadBranding(dom, {});
    sb.window.visiBranding.apply({
      ...GOOD,
      radius: 9999,
      colors: {
        ...GOOD.colors,
        brand: 'red; background:url(javascript:alert(1))',
        bg: 'not-a-colour',
        text: '#GGGGGG',
      },
    });

    test('a non-hex colour is not written to CSS', () =>
      assert.ok(dom.html.style['--brand'] === undefined, `got ${dom.html.style['--brand']}`));
    test('a bare keyword colour is not written to CSS', () =>
      assert.ok(dom.html.style['--bg'] === undefined, `got ${dom.html.style['--bg']}`));
    test('an invalid hex colour is not written to CSS', () =>
      assert.ok(dom.html.style['--text'] === undefined, `got ${dom.html.style['--text']}`));
    test('an out-of-range radius is ignored', () =>
      assert.ok(dom.html.style['--radius'] === undefined, `got ${dom.html.style['--radius']}`));
    test('valid colours in the same payload still apply', () =>
      assert.strictEqual(dom.html.style['--ok'], '#16a34a'));
  }

  // ── Logo and text mark ───────────────────────────────────────────────────
  {
    const dom = buildDom();
    const sb = loadBranding(dom, {});

    sb.window.visiBranding.apply(GOOD); // no logo -> text mark
    test('without a logo the text mark is used', () =>
      assert.strictEqual(dom.brandMarks[0].textContent, 'AC'));
    test('the text mark is set as TEXT, never markup', () =>
      assert.strictEqual(dom.brandMarks[0].innerHTML, ''));

    sb.window.visiBranding.apply({ ...GOOD, markText: '<img src=x onerror=alert(1)>' });
    test('a markup-looking text mark is still treated as text', () => {
      assert.strictEqual(dom.brandMarks[0].innerHTML, '');
      assert.ok(dom.brandMarks[0].textContent.startsWith('<img'));
    });
    test('the text mark is truncated to 4 characters', () =>
      assert.strictEqual(dom.brandMarks[0].textContent.length, 4));

    sb.window.visiBranding.apply({ ...GOOD, logo: TINY_PNG });
    test('a logo replaces the text mark with an image', () => {
      assert.ok(dom.brandMarks[0].classList.contains('has-logo'));
      assert.strictEqual(dom.brandMarks[0].children.length, 1);
      assert.strictEqual(dom.brandMarks[0].children[0].src, TINY_PNG);
    });
    test('the logo gets alt text from the org name', () =>
      assert.strictEqual(dom.brandMarks[0].children[0].alt, 'Acme Industries'));

    sb.window.visiBranding.apply({ ...GOOD, logo: 'javascript:alert(1)' });
    test('a non-image logo value is refused', () => {
      assert.ok(!dom.brandMarks[0].classList.contains('has-logo'));
      assert.strictEqual(dom.brandMarks[0].textContent, 'AC');
    });

    sb.window.visiBranding.apply({ ...GOOD, logo: 'https://evil.example.com/logo.png' });
    test('a remote logo URL is refused', () =>
      assert.ok(!dom.brandMarks[0].classList.contains('has-logo')));

    test('the wordmark follows the organisation name', () =>
      assert.strictEqual(dom.brandNames[0].textContent, 'Acme Industries'));
  }

  // ── Ticker ───────────────────────────────────────────────────────────────
  {
    const dom = buildDom();
    const sb = loadBranding(dom, {});
    sb.window.visiBranding.apply(GOOD);

    const ticker = dom.body.children.find((c) => c.id === 'vsTicker');
    test('an enabled ticker is added to the page', () => assert.ok(ticker));
    test('the ticker takes its colours', () => {
      assert.strictEqual(ticker.style.background, '#111111');
      assert.strictEqual(ticker.style.color, '#ffffff');
    });
    test('the body is padded so the ticker covers nothing', () =>
      assert.ok(dom.body.classList.contains('has-ticker')));

    const track = ticker.children.find((c) => c._classes.has('ticker-track'));
    test('the ticker speed becomes the animation duration', () =>
      assert.strictEqual(track.style.animationDuration, '45s'));
    test('the text is duplicated so the loop has no gap', () =>
      assert.strictEqual(track.children.length, 2));
    test('ticker text is set as TEXT, never markup', () => {
      assert.strictEqual(track.children[0].textContent, 'Hard hats required');
      assert.strictEqual(track.children[0].innerHTML, '');
    });
    test('the scrolling copy is hidden from screen readers', () =>
      assert.strictEqual(track.getAttribute('aria-hidden'), 'true'));
    test('a single non-repeating copy is exposed to screen readers', () => {
      const sr = ticker.children.find((c) => c._classes.has('sr-only'));
      assert.ok(sr && sr.textContent === 'Hard hats required');
    });

    // Turning it off removes it again.
    sb.window.visiBranding.apply({ ...GOOD, ticker: { ...GOOD.ticker, enabled: false } });
    test('disabling the ticker removes it', () =>
      assert.ok(!dom.body.children.some((c) => c.id === 'vsTicker')));
    test('disabling the ticker removes the body padding', () =>
      assert.ok(!dom.body.classList.contains('has-ticker')));

    sb.window.visiBranding.apply({ ...GOOD, ticker: { ...GOOD.ticker, enabled: true, text: '   ' } });
    test('an enabled but empty ticker is not shown', () =>
      assert.ok(!dom.body.children.some((c) => c.id === 'vsTicker')));
  }

  // ── Caching, so a kiosk does not flash default colours ───────────────────
  {
    const store = {};
    const dom1 = buildDom();
    const sb1 = loadBranding(dom1, store);
    sb1.window.visiBranding.apply(GOOD);
    // apply() alone does not cache; load() does. Simulate what load() stores.
    store['visisign.branding'] = JSON.stringify(GOOD);

    const dom2 = buildDom();
    loadBranding(dom2, store); // applyCached() runs on load
    test('cached branding is applied immediately on the next page load', () =>
      assert.strictEqual(dom2.html.style['--brand'], '#7c3aed'));

    const dom3 = buildDom();
    loadBranding(dom3, { 'visisign.branding': '{not json' });
    test('a corrupt cache does not break the page', () =>
      assert.ok(dom3.html.style['--brand'] === undefined));
  }

  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} -- ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})();
