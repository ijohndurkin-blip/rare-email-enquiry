// Previous customers. New enquiries from them are flagged on the dashboard.
const { db, tx } = require('./db');

const FIELDS = ['name', 'company', 'email', 'phone', 'notes'];
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const normEmail = (e) => clean(e, 200).toLowerCase();

// Compare phone numbers by their last 10 digits, so +44 7700 900123 matches 07700 900123.
function phoneKey(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-10) : '';
}

function sanitize(data) {
  return {
    name: clean(data.name, 200),
    company: clean(data.company, 200),
    email: normEmail(data.email),
    phone: clean(data.phone, 50),
    notes: clean(data.notes, 5000),
  };
}

function list(businessId) {
  return db.prepare('SELECT id, name, company, email, phone, notes, created_at AS createdAt FROM contacts WHERE business_id = ? ORDER BY lower(name), lower(email)').all(businessId);
}

function get(businessId, id) {
  return db.prepare('SELECT id, name, company, email, phone, notes, created_at AS createdAt FROM contacts WHERE id = ? AND business_id = ?').get(id, businessId);
}

function create(businessId, data) {
  const c = sanitize(data);
  if (!c.name && !c.email && !c.phone) throw new Error('Add at least a name, email or phone number');
  if (c.email) {
    const existing = db.prepare('SELECT id FROM contacts WHERE business_id = ? AND email = ?').get(businessId, c.email);
    if (existing) return update(businessId, existing.id, Object.fromEntries(Object.entries(c).filter(([, v]) => v)));
  }
  const r = db.prepare('INSERT INTO contacts (business_id, name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(businessId, c.name, c.company, c.email, c.phone, c.notes);
  return get(businessId, Number(r.lastInsertRowid));
}

function update(businessId, id, data) {
  const current = get(businessId, id);
  if (!current) return null;
  const c = sanitize({ ...current, ...data });
  db.prepare('UPDATE contacts SET name = ?, company = ?, email = ?, phone = ?, notes = ? WHERE id = ? AND business_id = ?')
    .run(c.name, c.company, c.email, c.phone, c.notes, id, businessId);
  return get(businessId, id);
}

function remove(businessId, id) {
  return Number(db.prepare('DELETE FROM contacts WHERE id = ? AND business_id = ?').run(id, businessId).changes) > 0;
}

/** Add many at once (from a spreadsheet). Existing emails are updated, not duplicated. */
function importRows(businessId, rows) {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  tx(() => {
    for (const row of rows.slice(0, 10000)) {
      const c = sanitize(row);
      if (!c.name && !c.email && !c.phone) { skipped += 1; continue; }
      const existing = c.email && db.prepare('SELECT id FROM contacts WHERE business_id = ? AND email = ?').get(businessId, c.email);
      if (existing) {
        update(businessId, existing.id, Object.fromEntries(Object.entries(c).filter(([, v]) => v)));
        updated += 1;
      } else {
        db.prepare('INSERT INTO contacts (business_id, name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?, ?)')
          .run(businessId, c.name, c.company, c.email, c.phone, c.notes);
        added += 1;
      }
    }
  });
  return { added, updated, skipped };
}

/** Returns (email, phone) => contact | null for one business. */
function matcher(businessId) {
  const byEmail = new Map();
  const byPhone = new Map();
  for (const c of db.prepare('SELECT id, name, company, email, phone FROM contacts WHERE business_id = ?').all(businessId)) {
    const info = { id: c.id, name: c.name, company: c.company };
    if (c.email) byEmail.set(c.email, info);
    const k = phoneKey(c.phone);
    if (k) byPhone.set(k, info);
  }
  return (email, phone) => byEmail.get(normEmail(email)) || byPhone.get(phoneKey(phone)) || null;
}

module.exports = { FIELDS, list, get, create, update, remove, importRows, matcher, phoneKey };
