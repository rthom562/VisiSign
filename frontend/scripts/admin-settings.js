/* admin-settings.js — the Settings and Kiosks panels of the admin console.

   The Settings panel is built entirely from the schema the server sends
   (/api/admin/settings/schema): groups, field types, ranges and help text all
   come from there. Adding a setting on the server therefore needs no change in
   here — a correctly typed field appears on its own.

   It also owns:
     * colour templates — one click writes a whole palette into the settings
     * the logo upload, which is stored inline as a data URL
     * .vsf customisation files — download the look, load it onto another install
     * the kiosk fleet, where each device gets its own printer and label size  */

(function () {
  'use strict';

  const { esc, showError, toastOk, loader, empty } = window.ui;

  // ───────────────────────────────────────────────────────── field rendering

  function fieldHtml(s, extra) {
    const id = `set_${s.key}`;
    const help = s.help ? `<span class="muted" style="font-size:.8rem">${esc(s.help)}</span>` : '';
    const label = `<label for="${id}">${esc(s.label)}</label>`;

    switch (s.type) {
      case 'bool':
        return `<div class="field">
          <label class="row" style="gap:10px;cursor:pointer;align-items:flex-start">
            <input type="checkbox" id="${id}" data-key="${esc(s.key)}" data-type="bool"
                   style="margin-top:3px" ${s.value === 'true' ? 'checked' : ''} />
            <span><strong>${esc(s.label)}</strong>${s.help ? `<br><span class="muted" style="font-size:.8rem">${esc(s.help)}</span>` : ''}</span>
          </label>
        </div>`;

      case 'select':
        return `<div class="field">${label}
          <select class="select" id="${id}" data-key="${esc(s.key)}">
            ${(s.options || []).map((o) =>
              `<option value="${esc(o.value)}" ${o.value === s.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>${help}</div>`;

      case 'color':
        return `<div class="field">${label}
          <div class="color-row">
            <input type="color" id="${id}" data-key="${esc(s.key)}" data-type="color"
                   value="${esc(/^#[0-9a-f]{6}$/i.test(s.value) ? s.value : '#000000')}" />
            <input class="input" data-hex-for="${esc(s.key)}" value="${esc(s.value)}"
                   spellcheck="false" maxlength="7" />
          </div>${help}</div>`;

      case 'number':
        return `<div class="field">${label}
          <input class="input" type="number" id="${id}" data-key="${esc(s.key)}"
                 value="${esc(s.value)}"
                 ${s.min !== undefined ? `min="${s.min}"` : ''} ${s.max !== undefined ? `max="${s.max}"` : ''} />
          ${help}</div>`;

      case 'textarea':
        return `<div class="field">${label}
          <textarea class="textarea" id="${id}" data-key="${esc(s.key)}" rows="6">${esc(s.value)}</textarea>
          ${help}</div>`;

      case 'image':
        return `<div class="field">${label}
          <div class="row" style="gap:12px;align-items:flex-start">
            <div class="logo-preview" id="logoPreview">
              ${s.value ? `<img src="${esc(s.value)}" alt="Current logo" />` : '<span class="muted" style="font-size:.7rem">none</span>'}
            </div>
            <div class="stack" style="flex:1;gap:8px">
              <input type="file" id="logoFile" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" />
              <input type="hidden" id="${id}" data-key="${esc(s.key)}" value="${esc(s.value)}" />
              <div class="row">
                <button type="button" class="btn btn-ghost" id="logoClear">Remove logo</button>
              </div>
              ${help}
            </div>
          </div></div>`;

      default:
        return `<div class="field">${label}
          <input class="input" id="${id}" data-key="${esc(s.key)}" value="${esc(s.value)}"
                 ${s.max ? `maxlength="${s.max}"` : ''} ${extra || ''} />
          ${help}</div>`;
    }
  }

  /** Collect every field in a container into a patch object. */
  function collect(scope) {
    const patch = {};
    scope.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      if (el.type === 'checkbox') patch[key] = el.checked ? 'true' : 'false';
      else patch[key] = el.value;
    });
    return patch;
  }

  // ───────────────────────────────────────────────────────── Settings panel

  async function renderSettings(body) {
    body.innerHTML = loader('Loading settings…');
    let data;
    try {
      data = await window.api.admin.settingsSchema();
    } catch (err) {
      showError(err);
      body.innerHTML = empty('Could not load settings.');
      return;
    }

    const groups = data.groups || [];
    const active = sessionStorage.getItem('visisign.setgroup') || groups[0]?.key;

    body.innerHTML = `
      <div class="set-nav" id="setNav">
        ${groups.map((g) => `<button data-group="${esc(g.key)}" class="${g.key === active ? 'active' : ''}">
          ${esc(g.icon || '')} ${esc(g.label)}</button>`).join('')}
      </div>
      <div id="setPanel"></div>`;

    const panel = body.querySelector('#setPanel');

    body.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
      sessionStorage.setItem('visisign.setgroup', b.dataset.group);
      body.querySelectorAll('[data-group]').forEach((x) => x.classList.toggle('active', x === b));
      drawGroup(b.dataset.group);
    }));

    function drawGroup(key) {
      const g = groups.find((x) => x.key === key) || groups[0];
      if (!g) return;

      panel.innerHTML = `
        <div class="card">
          <h2>${esc(g.icon || '')} ${esc(g.label)}</h2>
          ${g.help ? `<p class="card-lead">${esc(g.help)}</p>` : ''}
          <form id="groupForm" class="stack">
            ${g.key === 'appearance' ? '<div id="tplSlot"></div>' : ''}
            ${g.settings.map((s) => fieldHtml(s)).join('')}
            <div class="row" style="margin-top:6px">
              <button class="btn btn-primary" type="submit">Save ${esc(g.label.toLowerCase())}</button>
              ${g.key === 'printing' ? '<button class="btn" type="button" id="testPrint">Print test badge</button>' : ''}
            </div>
          </form>
        </div>
        ${g.key === 'appearance' ? customisationCardHtml() : ''}`;

      const form = panel.querySelector('#groupForm');

      // Keep each colour picker and its hex box in step.
      form.querySelectorAll('input[type="color"]').forEach((picker) => {
        const hex = form.querySelector(`[data-hex-for="${picker.dataset.key}"]`);
        if (!hex) return;
        picker.addEventListener('input', () => { hex.value = picker.value; });
        hex.addEventListener('change', () => {
          const v = hex.value.trim();
          if (/^#[0-9a-f]{6}$/i.test(v)) picker.value = v;
          else hex.value = picker.value; // reject anything that is not a colour
        });
      });

      wireLogo(form);
      if (g.key === 'appearance') {
        renderTemplates(panel.querySelector('#tplSlot'), body);
        wireCustomisation(panel, body);
      }
      if (g.key === 'printing') wirePrinting(form, panel);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await window.api.admin.updateSettings(collect(form));
          toastOk('Saved.');
          // Re-apply the live look so the admin sees the change immediately.
          await window.visiBranding.load();
        } catch (err) {
          showError(err);
        } finally {
          btn.disabled = false;
        }
      });
    }

    drawGroup(active);
  }

  // ── Logo upload ────────────────────────────────────────────────────────────
  // Stored inline as a data URL, so a .vsf file carries the whole look in one
  // file with no second asset to lose.
  function wireLogo(form) {
    const file = form.querySelector('#logoFile');
    if (!file) return;
    const hidden = form.querySelector('#set_brand_logo');
    const preview = form.querySelector('#logoPreview');
    const clear = form.querySelector('#logoClear');

    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 256 * 1024) {
        showError({ message: `That image is ${Math.round(f.size / 1024)} KB. The limit is 256 KB — try a smaller one.` });
        file.value = '';
        return;
      }
      const fr = new FileReader();
      fr.onload = () => {
        hidden.value = String(fr.result);
        preview.innerHTML = `<img src="${esc(hidden.value)}" alt="New logo" />`;
      };
      fr.onerror = () => showError({ message: 'Could not read that file.' });
      fr.readAsDataURL(f);
    });

    clear.addEventListener('click', () => {
      hidden.value = '';
      file.value = '';
      preview.innerHTML = '<span class="muted" style="font-size:.7rem">none</span>';
    });
  }

  // ── Colour templates ───────────────────────────────────────────────────────
  async function renderTemplates(slot, body) {
    if (!slot) return;
    slot.innerHTML = loader('Loading templates…');
    let templates = [];
    try {
      templates = (await window.api.admin.templates()).templates || [];
    } catch (_) {
      slot.innerHTML = '';
      return;
    }

    slot.innerHTML = `
      <div class="field">
        <label>Start from a palette</label>
        <span class="muted" style="font-size:.8rem">
          Applies a full set of colours. Every one stays editable afterwards.
        </span>
        <div class="tpl-grid" style="margin-top:10px">
          ${templates.map((t) => `
            <button type="button" class="tpl-card" data-tpl="${esc(t.key)}">
              <h4>${esc(t.name)}</h4>
              <p>${esc(t.description || '')}</p>
              <div class="tpl-swatches">
                ${(t.preview || []).map((c) => `<span class="tpl-swatch" style="background:${esc(c)}"></span>`).join('')}
              </div>
            </button>`).join('')}
        </div>
      </div>`;

    slot.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const out = await window.api.admin.applyTemplate(b.dataset.tpl);
        toastOk(`Applied “${out.name}”.`);
        await window.visiBranding.load();
        renderSettings(body); // redraw so the colour fields show the new values
      } catch (err) {
        showError(err);
        b.disabled = false;
      }
    }));
  }

  // ── .vsf customisation files ───────────────────────────────────────────────
  function customisationCardHtml() {
    return `
      <div class="card" style="margin-top:18px">
        <h2>💾 Customisation files (.vsf)</h2>
        <p class="card-lead">
          Save this install's whole look — colours, logo, wording, ticker and terms — as a single
          <strong>.vsf</strong> file, and load it onto another VisiSign.
          Printer names, opening hours and approval rules are deliberately <em>not</em> included:
          those belong to one building.
        </p>
        <div class="row">
          <button class="btn" id="vsfExport">⤓ Download .vsf</button>
          <button class="btn" id="vsfImportBtn">⤒ Load a .vsf…</button>
          <input type="file" id="vsfFile" accept=".vsf,application/json" style="display:none" />
        </div>
        <div id="vsfResult" class="muted" style="font-size:.85rem;margin-top:10px"></div>
      </div>`;
  }

  function wireCustomisation(panel, body) {
    const out = panel.querySelector('#vsfResult');

    panel.querySelector('#vsfExport').addEventListener('click', async () => {
      try {
        const text = await window.api.admin.exportCustomisation();
        let name = 'visisign';
        try { name = (JSON.parse(text).name || name).replace(/[^a-z0-9._-]+/gi, '-'); } catch (_) { /* keep default */ }

        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.vsf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Give the download a moment to start before the blob is reclaimed.
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        out.textContent = `Downloaded ${name}.vsf`;
      } catch (err) {
        showError(err);
      }
    });

    const fileInput = panel.querySelector('#vsfFile');
    panel.querySelector('#vsfImportBtn').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = async () => {
        let bundle;
        try {
          bundle = JSON.parse(String(fr.result));
        } catch (_) {
          showError({ message: 'That file is not a valid .vsf file.' });
          fileInput.value = '';
          return;
        }

        // Preview first, so the administrator sees what is about to change.
        try {
          const preview = await window.api.admin.importCustomisation(bundle, true);
          const label = preview.name ? `“${preview.name}”` : 'this file';
          const skipped = (preview.skipped || []).length;
          const message = `Load ${label}? It will change ${preview.appliedCount} setting`
            + `${preview.appliedCount === 1 ? '' : 's'}`
            + `${skipped ? `, and skip ${skipped} this version does not know` : ''}.`;
          if (!window.confirm(message)) { fileInput.value = ''; return; }
        } catch (err) {
          showError(err);
          fileInput.value = '';
          return;
        }

        try {
          const res = await window.api.admin.importCustomisation(bundle, false);
          toastOk(`Applied ${res.appliedCount} setting${res.appliedCount === 1 ? '' : 's'}.`);
          await window.visiBranding.load();
          renderSettings(body);
        } catch (err) {
          showError(err);
        } finally {
          fileInput.value = '';
        }
      };
      fr.readAsText(f);
    });
  }

  // ── Printing group extras ──────────────────────────────────────────────────
  // Turn the free-text printer field into a dropdown of printers that actually
  // exist, when the server can see any.
  async function wirePrinting(form, panel) {
    const testBtn = panel.querySelector('#testPrint');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        try {
          const r = await window.api.print.test(form.querySelector('[data-key="badge_printer"]').value);
          toastOk(r.printed === false ? `Queued for the print agent (job ${r.jobId}).` : 'Test badge sent.');
        } catch (err) {
          showError(err);
        } finally {
          testBtn.disabled = false;
        }
      });
    }

    const input = form.querySelector('[data-key="badge_printer"]');
    if (!input) return;
    try {
      const { printers } = await window.api.print.printers();
      if (!printers || !printers.length) return;
      const select = document.createElement('select');
      select.className = 'select';
      select.dataset.key = 'badge_printer';
      select.innerHTML = ['<option value="">— none —</option>']
        .concat(printers.map((p) => `<option value="${esc(p)}" ${p === input.value ? 'selected' : ''}>${esc(p)}</option>`))
        .join('');
      // If the saved printer is not installed, keep it so saving does not lose it.
      if (input.value && !printers.includes(input.value)) {
        select.insertAdjacentHTML('beforeend',
          `<option value="${esc(input.value)}" selected>${esc(input.value)} (not found)</option>`);
      }
      input.replaceWith(select);
    } catch (_) {
      /* no printer list available — the text field stands */
    }
  }

  // ───────────────────────────────────────────────────────── Kiosks panel

  async function renderKiosks(body) {
    body.innerHTML = loader('Loading kiosks…');
    let kiosks = [];
    let printers = [];
    try {
      kiosks = (await window.api.kiosk.list()).kiosks || [];
    } catch (err) {
      showError(err);
      body.innerHTML = empty('Could not load kiosks.');
      return;
    }
    try { printers = (await window.api.print.printers()).printers || []; } catch (_) { /* optional */ }

    const pending = kiosks.filter((k) => k.status === 'pending');
    const rest = kiosks.filter((k) => k.status !== 'pending');

    body.innerHTML = `
      <div class="card">
        <h2>🖥️ Kiosk devices</h2>
        <p class="card-lead">
          Every tablet or browser running the kiosk page. Each one can use its own printer and
          label size — leave a field blank and it follows the organisation default from
          <strong>Settings → Badge printing</strong>.
        </p>
        ${pending.length ? `<h3 style="margin-top:14px">Waiting for approval</h3>
          ${pending.map(cardHtml).join('')}` : ''}
        <h3 style="margin-top:14px">Devices</h3>
        ${rest.length ? rest.map(cardHtml).join('') : empty('No kiosks yet. Open /kiosk on a tablet to register one.')}
      </div>`;

    function cardHtml(k) {
      const p = k.printing || {};
      const ov = p.overrides || {};
      return `
        <div class="kiosk-card ${esc(k.status)}" data-kiosk="${esc(k.code)}">
          <div class="kiosk-head">
            <span class="kiosk-code">${esc(k.code)}</span>
            <strong>${esc(k.name || 'Unnamed device')}</strong>
            ${k.location ? `<span class="muted">· ${esc(k.location)}</span>` : ''}
            <span class="pill ${k.status === 'accepted' ? 'in' : ''}">${esc(k.status)}</span>
            <div class="spacer"></div>
            ${k.status === 'pending'
              ? `<button class="btn btn-primary" data-act="accept">Accept</button>
                 <button class="btn btn-ghost" data-act="reject">Reject</button>`
              : k.status === 'accepted'
                ? `<button class="btn btn-ghost" data-act="revoke">Revoke</button>`
                : `<button class="btn btn-primary" data-act="accept">Re-accept</button>`}
            <button class="btn btn-ghost" data-act="delete" title="Forget this device">✕</button>
          </div>

          <div class="muted" style="font-size:.78rem;margin-top:6px">
            Last seen ${esc(k.lastSeenAt || 'never')}${k.ip ? ` · ${esc(k.ip)}` : ''}
          </div>

          <div class="grid cols-2" style="margin-top:12px">
            <div class="field">
              <label>Name</label>
              <input class="input" data-f="name" value="${esc(k.name || '')}" placeholder="Front desk" />
            </div>
            <div class="field">
              <label>Location</label>
              <input class="input" data-f="location" value="${esc(k.location || '')}" placeholder="Main lobby" />
            </div>
            <div class="field">
              <label>Printer ${ov.printer ? '' : '<span class="inherited">(inherited)</span>'}</label>
              ${printers.length
                ? `<select class="select" data-f="printer">
                     <option value="">— use the default —</option>
                     ${printers.map((pr) => `<option value="${esc(pr)}" ${pr === (ov.printer ? p.printer : '') ? 'selected' : ''}>${esc(pr)}</option>`).join('')}
                     ${ov.printer && !printers.includes(p.printer) ? `<option value="${esc(p.printer)}" selected>${esc(p.printer)} (not found)</option>` : ''}
                   </select>`
                : `<input class="input" data-f="printer" value="${esc(ov.printer ? p.printer : '')}" placeholder="Leave blank to use the default" />`}
              <span class="muted" style="font-size:.76rem">Currently printing to: <strong>${esc(p.printer || 'nothing configured')}</strong></span>
            </div>
            <div class="field">
              <label>Print mode ${ov.printMode ? '' : '<span class="inherited">(inherited)</span>'}</label>
              <select class="select" data-f="printMode">
                <option value="">— use the default —</option>
                <option value="server" ${ov.printMode && p.printMode === 'server' ? 'selected' : ''}>A real printer</option>
                <option value="device" ${ov.printMode && p.printMode === 'device' ? 'selected' : ''}>From the tablet (AirPrint / Mopria)</option>
                <option value="off" ${ov.printMode && p.printMode === 'off' ? 'selected' : ''}>Don't print</option>
              </select>
            </div>
            <div class="field">
              <label>Label width (mm) ${ov.label ? '' : '<span class="inherited">(inherited)</span>'}</label>
              <input class="input" type="number" data-f="labelWidthMm"
                     value="${ov.label ? esc(p.label.widthMm) : ''}" placeholder="${esc(p.label ? p.label.widthMm : 62)}" />
            </div>
            <div class="field">
              <label>Label height (mm) ${ov.label ? '' : '<span class="inherited">(inherited)</span>'}</label>
              <input class="input" type="number" data-f="labelHeightMm"
                     value="${ov.label ? esc(p.label.heightMm) : ''}" placeholder="${esc(p.label ? p.label.heightMm : 90)}" />
            </div>
          </div>

          <div class="row" style="margin-top:4px">
            <button class="btn btn-primary" data-act="save">Save this kiosk</button>
          </div>
        </div>`;
    }

    body.querySelectorAll('[data-kiosk]').forEach((card) => {
      const code = card.dataset.kiosk;

      const act = async (fn, confirmMsg) => {
        if (confirmMsg && !window.confirm(confirmMsg)) return;
        try { await fn(); toastOk('Done.'); renderKiosks(body); }
        catch (err) { showError(err); }
      };

      card.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => {
        switch (btn.dataset.act) {
          case 'accept': return act(() => window.api.kiosk.accept(code));
          case 'reject': return act(() => window.api.kiosk.reject(code));
          case 'revoke': return act(() => window.api.kiosk.revoke(code),
            'Revoke this kiosk? The device will stop showing the kiosk until it is accepted again.');
          case 'delete': return act(() => window.api.kiosk.remove(code),
            'Forget this device entirely? It will have to register and be approved again.');
          case 'save': {
            const patch = {};
            card.querySelectorAll('[data-f]').forEach((el) => { patch[el.dataset.f] = el.value.trim(); });
            return act(() => window.api.kiosk.update(code, patch));
          }
          default: return undefined;
        }
      }));
    });
  }

  window.adminPanels = { renderSettings, renderKiosks };
})();
