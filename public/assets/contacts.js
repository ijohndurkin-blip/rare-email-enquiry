/* Contacts tab: previous customers. Uses `call` and `base` from app.js. */
const Contacts = (() => {
  let list = [];
  let editing = null; // contact being edited, or null for a new one
  let afterSave = null;
  let pending = []; // rows ready to import

  async function render() {
    list = await call(`${base}/contacts`);
    draw();
  }

  function draw() {
    const q = $('#cq').value.trim().toLowerCase();
    const shown = list.filter((c) => !q || [c.name, c.company, c.email, c.phone, c.notes].some((v) => String(v || '').toLowerCase().includes(q)));
    $('#contactCount').textContent = `${list.length} contact${list.length === 1 ? '' : 's'}`;
    $('#contactList').innerHTML = shown.length ? `<div class="table-wrap"><table class="list">
      <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th>Notes</th></tr></thead>
      <tbody>${shown.map((c) => `<tr tabindex="0" data-cid="${c.id}">
        <td style="font-weight:600">${esc(c.name) || '<span class="muted">—</span>'}</td>
        <td>${esc(c.company)}</td>
        <td>${c.email ? `<a href="mailto:${esc(c.email)}" data-stop>${esc(c.email)}</a>` : ''}</td>
        <td style="white-space:nowrap">${c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}" data-stop>${esc(c.phone)}</a>` : ''}</td>
        <td class="subj muted">${esc(c.notes)}</td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">${list.length ? 'No contacts match your search.' : 'No contacts yet. Add your previous customers by hand, import them from a spreadsheet, or use "+ Add to contacts" on any enquiry.'}</div>`;
    $$('[data-cid]').forEach((tr) => {
      const open = () => openDialog(list.find((c) => c.id === Number(tr.dataset.cid)));
      tr.addEventListener('click', (ev) => { if (!ev.target.closest('[data-stop]')) open(); });
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    });
  }

  // Add or edit one contact. `contact` with an id edits; without, it's a new one (pre-filled).
  function openDialog(contact = {}, onSaved = null) {
    editing = contact.id ? contact : null;
    afterSave = onSaved;
    $('#cTitle').textContent = editing ? 'Edit contact' : 'Add a contact';
    ['name', 'company', 'email', 'phone', 'notes'].forEach((k) => { $(`#c${k[0].toUpperCase()}${k.slice(1)}`).value = contact[k] || ''; });
    $('#cErr').textContent = '';
    $('#cDelete').classList.toggle('hidden', !editing);
    $('#contactDialog').showModal();
  }

  $('#contactForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    try {
      if (editing) await call(`${base}/contacts/${editing.id}`, { method: 'PATCH', body });
      else await call(`${base}/contacts`, { method: 'POST', body });
      $('#contactDialog').close();
      if (afterSave) await afterSave();
      else toast('Saved');
      if (state.tab === 'contacts') render();
      load();
    } catch (err) { $('#cErr').textContent = err.message; }
  });
  $('#cCancel').addEventListener('click', () => $('#contactDialog').close());
  $('#cDelete').addEventListener('click', async () => {
    if (!editing || !confirm(`Delete ${editing.name || editing.email || 'this contact'}?`)) return;
    await call(`${base}/contacts/${editing.id}`, { method: 'DELETE' });
    $('#contactDialog').close();
    toast('Contact deleted');
    render();
    load();
  });
  $('#newContactBtn').addEventListener('click', () => openDialog());
  $('#cq').addEventListener('input', draw);

  // --- Import from a spreadsheet (CSV file or pasted rows) -------------------------

  // Minimal CSV/TSV parser that copes with quoted cells.
  function parseTable(text) {
    const delim = text.includes('\t') ? '\t' : (text.split('\n')[0].split(';').length > text.split('\n')[0].split(',').length ? ';' : ',');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === delim) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
  }

  // Work out which column is which, from a header row if there is one.
  function toContacts(rows) {
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.toLowerCase());
    const find = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
    const map = {
      name: find('name', 'customer', 'contact'),
      company: find('company', 'business', 'organisation', 'organization'),
      email: find('email', 'e-mail'),
      phone: find('phone', 'mobile', 'tel', 'number'),
      notes: find('note', 'comment'),
    };
    // Name column often also matches "company name"; prefer an exact-ish name column.
    const exactName = header.findIndex((h) => h === 'name' || h === 'full name' || h === 'customer name' || h === 'contact name');
    if (exactName >= 0) map.name = exactName;
    const hasHeader = map.email >= 0 || (map.name >= 0 && map.phone >= 0);
    const usable = (c) => c.name || c.email || c.phone;
    if (hasHeader) {
      return rows.slice(1).map((r) => {
        const get = (k) => (map[k] >= 0 ? r[map[k]] || '' : '');
        return { name: get('name'), company: get('company'), email: get('email'), phone: get('phone'), notes: get('notes') };
      }).filter(usable);
    }
    // No header: spot the email and phone wherever they are; then name, company, notes.
    return rows.map((r) => {
      const cells = [...r];
      const take = (test) => { const i = cells.findIndex(test); return i >= 0 ? cells.splice(i, 1)[0] : ''; };
      const email = take((x) => /@/.test(x));
      const phone = take((x) => x.replace(/\D/g, '').length >= 9 && !/[a-z]/i.test(x));
      const [name = '', company = '', ...rest] = cells;
      return { name, company, email, phone, notes: rest.filter(Boolean).join(', ') };
    }).filter(usable);
  }

  function preview(text) {
    pending = toContacts(parseTable(text));
    $('#iGo').disabled = !pending.length;
    $('#iPreview').innerHTML = pending.length
      ? `<b>${pending.length} contact${pending.length === 1 ? '' : 's'} found.</b> First: ${esc([pending[0].name, pending[0].company, pending[0].email, pending[0].phone].filter(Boolean).join(' · '))}`
      : '';
  }

  $('#importBtn').addEventListener('click', () => {
    $('#importForm').reset(); pending = []; $('#iPreview').innerHTML = ''; $('#iErr').textContent = ''; $('#iGo').disabled = true;
    $('#importDialog').showModal();
  });
  $('#iCancel').addEventListener('click', () => $('#importDialog').close());
  $('#iPaste').addEventListener('input', (ev) => preview(ev.target.value));
  $('#iFile').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    if (/\.xlsx?$/i.test(f.name)) { $('#iErr').textContent = 'That\'s an Excel file. In Excel choose File → Save As → CSV, or copy the rows and paste them below.'; return; }
    $('#iErr').textContent = '';
    preview(await f.text());
  });
  $('#importForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await call(`${base}/contacts/import`, { method: 'POST', body: { rows: pending } });
      $('#importDialog').close();
      toast(`Imported: ${r.added} added, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ''}`);
      render();
      load();
    } catch (err) { $('#iErr').textContent = err.message; }
  });

  return { render, openDialog, parseTable, toContacts };
})();
