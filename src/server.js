const path = require('node:path');
const express = require('express');
const { db, getAppSetting, setAppSetting } = require('./db');
const { DEFAULT_SETTINGS, merge } = require('./settings');
const sec = require('./security');
const enq = require('./enquiries');
const inbox = require('./inbox');
const { loadDemo } = require('./demo');
const ai = require('./ai');
const automations = require('./automations');
const knowledge = require('./knowledge');
const autoconfig = require('./autoconfig');
const mailer = require('./mailer');

automations.start();

const app = express();
const PUBLIC = path.join(__dirname, '..', 'public');
const ADMIN_PASSWORD = sec.loadAdminPassword();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use('/assets', express.static(path.join(PUBLIC, 'assets'), { maxAge: '1h' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'business';

// --- Auth ------------------------------------------------------------------

function session(req) { return sec.readSession(req) || {}; }
const isAdmin = (req) => session(req).admin === true;
const canSee = (req, slug) => isAdmin(req) || session(req).business === slug;

function requireAdmin(req, res, next) {
  if (isAdmin(req)) {
    const origin = `${req.protocol}://${req.get('host')}`;
    if (!process.env.APP_URL && getAppSetting('public_url') !== origin) setAppSetting('public_url', origin);
    return next();
  }
  return res.status(401).json({ error: 'Admin login required' });
}

function loadBusiness(req, res, next) {
  const b = enq.getBusiness('slug', req.params.slug);
  if (!b) return res.status(404).json({ error: 'Business not found' });
  if (!canSee(req, b.slug)) return res.status(401).json({ error: 'Login required' });
  req.business = b;
  return next();
}

// Light brute-force protection on logins.
const attempts = new Map();
function throttled(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(key, a);
  return a.length >= 10;
}
const recordFail = (key) => attempts.get(key).push(Date.now());

app.post('/api/login', (req, res) => {
  const { slug, password } = req.body || {};
  const key = `${req.ip}:${slug || 'admin'}`;
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!slug) {
    if (sec.safeEqual(password || '', ADMIN_PASSWORD)) {
      sec.writeSession(req, res, { admin: true });
      return res.json({ ok: true, redirect: '/admin' });
    }
  } else {
    const b = enq.getBusiness('slug', slug);
    if (b && sec.verifyCode(password, b.access_hash)) {
      sec.writeSession(req, res, { ...session(req), business: b.slug });
      return res.json({ ok: true, redirect: `/b/${b.slug}` });
    }
  }
  recordFail(key);
  return res.status(401).json({ error: 'That password is not right.' });
});

app.post('/api/logout', (req, res) => { sec.clearSession(res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ admin: isAdmin(req), business: session(req).business || null }));

// --- Admin API ---------------------------------------------------------------

function adminView(b) {
  const s = structuredClone(b.settings);
  s.inbox.password = s.inbox.password ? '********' : '';
  return {
    id: b.id, slug: b.slug, name: b.name, brandColor: b.brand_color,
    hasAccessCode: Boolean(b.access_hash), inboundToken: b.inbound_token,
    settings: s, syncState: b.sync_state, createdAt: b.created_at,
  };
}

app.get('/api/admin/businesses', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id FROM businesses ORDER BY name').all();
  res.json(rows.map(({ id }) => {
    const b = enq.getBusiness('id', id);
    const s = enq.summary(b, 7);
    return {
      ...adminView(b),
      stats: { week: s.totals.enquiries, hot: s.byTemp.hot, warm: s.byTemp.warm, cold: s.byTemp.cold, overdue: s.totals.overdue },
    };
  }));
});

app.get('/api/admin/defaults', requireAdmin, (req, res) => res.json(DEFAULT_SETTINGS));

app.post('/api/admin/businesses', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the business a name' });
  let slug = slugify(req.body.slug || name);
  for (let i = 2; db.prepare('SELECT 1 FROM businesses WHERE slug = ?').get(slug); i += 1) slug = `${slugify(name)}-${i}`;
  const accessCode = sec.randomToken(6);
  const r = db.prepare('INSERT INTO businesses (slug, name, brand_color, access_hash, inbound_token, settings) VALUES (?, ?, ?, ?, ?, ?)')
    .run(slug, name, req.body.brandColor || '#2a78d6', sec.hashCode(accessCode), sec.randomToken(), '{}');
  const b = enq.getBusiness('id', Number(r.lastInsertRowid));
  if (req.body.demo) loadDemo(b);
  res.status(201).json({ ...adminView(b), accessCode });
});

app.get('/api/admin/businesses/:id', requireAdmin, (req, res) => {
  const b = enq.getBusiness('id', Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(adminView(b));
});

app.put('/api/admin/businesses/:id', requireAdmin, (req, res) => {
  const b = enq.getBusiness('id', Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  const name = String(body.name ?? b.name).trim() || b.name;
  const slug = body.slug ? slugify(body.slug) : b.slug;
  if (slug !== b.slug && db.prepare('SELECT 1 FROM businesses WHERE slug = ? AND id != ?').get(slug, b.id)) {
    return res.status(409).json({ error: `The address "${slug}" is already used by another business` });
  }
  const color = /^#[0-9a-f]{6}$/i.test(body.brandColor || '') ? body.brandColor : b.brand_color;
  const incoming = body.settings || {};
  const settings = merge(b.settings, incoming);
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  settings.knowledge.prices = settings.knowledge.prices
    .filter((p) => p && typeof p === 'object' && (p.item || p.price))
    .slice(0, 500)
    .map((p) => ({ item: str(p.item, 200), price: str(p.price, 80), notes: str(p.notes, 300) }));
  settings.automations.followUp.days = settings.automations.followUp.days.map(Number).filter((n) => n > 0 && n <= 90).slice(0, 5);
  // Keep the stored password unless a new one was typed.
  const pw = incoming.inbox?.password;
  settings.inbox.password = pw && pw !== '********' ? sec.encrypt(pw) : b.settings.inbox.password;
  const accessHash = body.accessCode ? sec.hashCode(body.accessCode) : b.access_hash;
  db.prepare('UPDATE businesses SET name = ?, slug = ?, brand_color = ?, settings = ?, access_hash = ? WHERE id = ?')
    .run(name, slug, color, JSON.stringify(settings), accessHash, b.id);
  const updated = enq.getBusiness('id', b.id);
  if (body.rescore !== false) enq.rescoreAll(updated);
  res.json(adminView(updated));
});

app.delete('/api/admin/businesses/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM businesses WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/businesses/:id/demo', requireAdmin, (req, res) => {
  const b = enq.getBusiness('id', Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json({ created: loadDemo(b) });
});

app.post('/api/admin/businesses/:id/clear', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM enquiries WHERE business_id = ?').run(Number(req.params.id));
  db.prepare("UPDATE businesses SET sync_state = '{}' WHERE id = ?").run(Number(req.params.id));
  res.json({ deleted: Number(r.changes) });
});

app.post('/api/admin/businesses/:id/rotate-token', requireAdmin, (req, res) => {
  db.prepare('UPDATE businesses SET inbound_token = ? WHERE id = ?').run(sec.randomToken(), Number(req.params.id));
  res.json(adminView(enq.getBusiness('id', Number(req.params.id))));
});

app.post('/api/admin/businesses/:id/test-inbox', requireAdmin, wrap(async (req, res) => {
  const b = enq.getBusiness('id', Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  const settings = merge(b.settings, { inbox: req.body?.inbox || {} });
  const pw = req.body?.inbox?.password;
  settings.inbox.password = pw && pw !== '********' ? sec.encrypt(pw) : b.settings.inbox.password;
  try {
    res.json(await inbox.testConnection(settings.inbox));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.responseText || err.message });
  }
}));

app.post('/api/admin/businesses/:id/sync', requireAdmin, wrap(async (req, res) => {
  try {
    res.json(await inbox.syncBusiness(Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.responseText || err.message });
  }
}));

// --- AI settings (install-wide) ---------------------------------------------------

function aiView() {
  const stored = getAppSetting('anthropic_key');
  const key = ai.apiKey();
  return {
    configured: ai.isConfigured(),
    source: stored ? 'saved' : key ? 'environment' : null,
    keyHint: key ? `…${key.slice(-4)}` : '',
    model: ai.model(),
    models: ai.MODELS,
  };
}

app.get('/api/admin/ai', requireAdmin, (req, res) => res.json(aiView()));

app.put('/api/admin/ai', requireAdmin, wrap(async (req, res) => {
  const { key, model, removeKey } = req.body || {};
  const chosen = ai.MODELS.some((m) => m.id === model) ? model : ai.model();
  if (removeKey) setAppSetting('anthropic_key', null);
  if (key) {
    try {
      await ai.testKey(key.trim(), chosen);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    setAppSetting('anthropic_key', sec.encrypt(key.trim()));
  }
  setAppSetting('ai_model', chosen);
  res.json(aiView());
}));

app.post('/api/admin/ai/test', requireAdmin, wrap(async (req, res) => {
  try {
    await ai.testKey(undefined, ai.model());
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// --- Connect a mailbox from just address + password ---------------------------------

app.post('/api/admin/businesses/:id/connect-email', requireAdmin, wrap(async (req, res) => {
  const b = enq.getBusiness('id', Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  const { email, password } = req.body || {};
  const pw = password === '********' ? sec.decrypt(b.settings.inbox.password) : password;
  const result = await autoconfig.discover(email, pw);
  if (!result.ok) return res.status(400).json(result);
  const ib = {
    ...b.settings.inbox,
    enabled: true,
    email: String(email).trim().toLowerCase(),
    provider: result.provider,
    host: result.imap.host, port: result.imap.port, secure: result.imap.secure, user: result.imap.user,
    password: sec.encrypt(pw),
    smtpHost: result.smtp?.host || '', smtpPort: result.smtp?.port || 465, smtpSecure: result.smtp ? result.smtp.secure : true,
    folder: 'INBOX',
    sentFolder: result.sentFolder || '',
    saveToSent: result.saveToSent,
  };
  const settings = { ...b.settings, inbox: ib };
  if (!settings.contactEmail) settings.contactEmail = ib.email;
  db.prepare("UPDATE businesses SET settings = ?, sync_state = '{}' WHERE id = ?").run(JSON.stringify(settings), b.id);
  // Pull in recent mail straight away (quietly: no auto-replies to history).
  inbox.syncBusiness(b.id).catch((err) => console.warn(`[sync] first sync for ${b.slug}: ${err.message}`));
  res.json({ ...result, inbox: { ...ib, password: '********' } });
}));

// --- Learn about the business from its website ------------------------------------------

const jobs = new Map(); // in-memory progress for long-running website reads
app.post('/api/admin/businesses/:id/website/read', requireAdmin, (req, res) => {
  const b = enq.getBusiness('id', Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  const { mode = 'site', website = '', pages = [], maxPages = 20 } = req.body || {};
  const job = { id: sec.randomToken(8), status: 'running', log: [], result: null, error: null };
  jobs.set(job.id, job);
  setTimeout(() => jobs.delete(job.id), 3600000).unref();
  (async () => {
    try {
      const read = await knowledge.readWebsite({ mode, website, pages, maxPages }, (m) => { job.log.push(m); });
      knowledge.savePages(b.id, read.pages);
      job.log.push(`Read ${read.pages.length} page${read.pages.length === 1 ? '' : 's'}`);
      const fresh = enq.getBusiness('id', b.id);
      const k = { ...fresh.settings.knowledge, crawlMode: mode, pages: Array.isArray(pages) ? pages : [], maxPages: Number(maxPages) || 20 };
      const info = { ...fresh.settings.info, website: website || fresh.settings.info.website };
      let suggestedPrices = [];
      if (ai.isConfigured()) {
        job.log.push('AI is writing the business profile…');
        const p = await ai.buildProfile(fresh.name, read.pages);
        k.profile = p.profile;
        if (!k.faqs && p.faqs.length) k.faqs = p.faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
        if (!k.prices.length) k.prices = p.prices;
        else suggestedPrices = p.prices;
      }
      k.builtAt = new Date().toISOString();
      const settings = { ...fresh.settings, knowledge: k, info };
      db.prepare('UPDATE businesses SET settings = ? WHERE id = ?').run(JSON.stringify(settings), b.id);
      job.result = {
        knowledge: { profile: k.profile, faqs: k.faqs, prices: k.prices },
        pages: read.pages.map((p) => ({ url: p.url, title: p.title, chars: p.text.length })),
        errors: read.errors.slice(0, 10),
        aiUsed: ai.isConfigured(),
        suggestedPrices,
      };
      job.status = 'done';
    } catch (err) {
      job.error = err.message;
      job.status = 'error';
    }
  })();
  res.status(202).json({ jobId: job.id });
});

app.get('/api/admin/jobs/:id', requireAdmin, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/admin/businesses/:id/website/pages', requireAdmin, (req, res) => {
  res.json(knowledge.listPages(Number(req.params.id)).map((p) => ({ url: p.url, title: p.title, chars: p.text.length, fetchedAt: p.fetchedAt })));
});

// Try the AI on a made-up enquiry, to check the knowledge and tone before going live.
app.post('/api/admin/businesses/:id/test-reply', requireAdmin, wrap(async (req, res) => {
  const b = enq.getBusiness('id', Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (!ai.isConfigured()) return res.status(400).json({ error: 'Add an AI key under AI settings first.' });
  const { message = '', name = 'Alex', hasPhone = false } = req.body || {};
  const thread = `Customer: ${name} <customer@example.com>${hasPhone ? ', phone 07700 900123' : ', no phone number given'}\n\n--- Message from customer\nSubject: Enquiry\n\n${message}`;
  try {
    const d = await ai.draftReply(b, thread, 'reply', { askPhone: b.settings.automations.reply.askPhone && !hasPhone });
    res.json(d);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// --- Business dashboard API ------------------------------------------------------

app.get('/api/b/:slug/summary', loadBusiness, (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  res.json({
    ...enq.summary(req.business, days),
    canSend: mailer.canSend(req.business),
    aiEnabled: ai.isConfigured(),
    replyMode: req.business.settings.automations.reply.mode,
    followUpMode: req.business.settings.automations.followUp.mode,
  });
});

app.get('/api/b/:slug/queue', loadBusiness, (req, res) => res.json(automations.queue(req.business)));

const replyError = (res, err) => res.status(400).json({ error: err.message });

app.post('/api/b/:slug/enquiries/:id/draft', loadBusiness, wrap(async (req, res) => {
  try {
    await automations.draftNow(req.business, Number(req.params.id), { instruction: String(req.body?.instruction || '').slice(0, 1000) });
    res.json(enq.getEnquiry(req.business, Number(req.params.id)));
  } catch (err) { replyError(res, err); }
}));

app.post('/api/b/:slug/enquiries/:id/send', loadBusiness, wrap(async (req, res) => {
  try {
    await automations.sendNew(req.business, Number(req.params.id), { subject: req.body?.subject, body: req.body?.body });
    res.json(enq.getEnquiry(req.business, Number(req.params.id)));
  } catch (err) { replyError(res, err); }
}));

function outboxOwner(req) {
  return db.prepare('SELECT enquiry_id FROM outbox WHERE id = ? AND business_id = ?').get(Number(req.params.oid), req.business.id);
}

app.patch('/api/b/:slug/outbox/:oid', loadBusiness, (req, res) => {
  const o = outboxOwner(req);
  if (!o) return res.status(404).json({ error: 'Not found' });
  automations.updateDraft(req.business, Number(req.params.oid), { subject: req.body?.subject, body: req.body?.body });
  res.json(enq.getEnquiry(req.business, o.enquiry_id));
});

app.post('/api/b/:slug/outbox/:oid/send', loadBusiness, wrap(async (req, res) => {
  const o = outboxOwner(req);
  if (!o) return res.status(404).json({ error: 'Not found' });
  try {
    await automations.sendDraft(req.business, Number(req.params.oid), { subject: req.body?.subject, body: req.body?.body });
    res.json(enq.getEnquiry(req.business, o.enquiry_id));
  } catch (err) { replyError(res, err); }
}));

app.delete('/api/b/:slug/outbox/:oid', loadBusiness, (req, res) => {
  const o = outboxOwner(req);
  if (!o) return res.status(404).json({ error: 'Not found' });
  automations.discard(req.business, Number(req.params.oid));
  res.json(enq.getEnquiry(req.business, o.enquiry_id));
});

app.get('/api/b/:slug/enquiries', loadBusiness, (req, res) => {
  res.json(enq.listEnquiries(req.business, { includeSpam: req.query.spam === '1' }));
});

app.get('/api/b/:slug/enquiries/:id', loadBusiness, (req, res) => {
  const e = enq.getEnquiry(req.business, Number(req.params.id));
  if (!e) return res.status(404).json({ error: 'Not found' });
  res.json(e);
});

app.patch('/api/b/:slug/enquiries/:id', loadBusiness, (req, res) => {
  try {
    const e = enq.updateEnquiry(req.business, Number(req.params.id), req.body || {});
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(e);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Manually log an enquiry (e.g. one that came in by phone).
app.post('/api/b/:slug/enquiries', loadBusiness, (req, res) => {
  const { fromName, fromEmail, phone, subject, body } = req.body || {};
  if (!fromEmail && !phone) return res.status(400).json({ error: 'Add an email or phone number' });
  const email = fromEmail || `phone-${String(phone).replace(/\D/g, '')}@manual.local`;
  const r = enq.ingest(req.business, { fromEmail: email, fromName, phone, subject: subject || 'Manual enquiry', body, source: 'manual' });
  if (r.action === 'skipped') return res.status(400).json({ error: `Not added: ${r.reason}` });
  res.status(201).json(enq.getEnquiry(req.business, r.id));
});

app.post('/api/b/:slug/sync', loadBusiness, wrap(async (req, res) => {
  if (!req.business.settings.inbox.host) return res.status(400).json({ error: 'No inbox is connected yet' });
  try {
    res.json(await inbox.syncBusiness(req.business.id));
  } catch (err) {
    res.status(400).json({ error: err.responseText || err.message });
  }
}));

// --- Inbound webhook ---------------------------------------------------------------
// Accepts forwarded mail from Postmark, Mailgun, Zapier/Make, a website form, or
// any JSON with from / subject / text fields.

function addressParts(raw) {
  const s = String(raw || '');
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: s.trim() };
}

function normaliseInbound(p) {
  // Postmark
  if (p.FromFull || p.TextBody !== undefined) {
    return {
      fromEmail: p.FromFull?.Email || addressParts(p.From).email, fromName: p.FromFull?.Name || p.FromName,
      subject: p.Subject, body: p.StrippedTextReply || p.TextBody || '', messageId: p.MessageID, date: p.Date,
    };
  }
  // Mailgun routes (form-encoded)
  if (p['body-plain'] !== undefined || p.sender) {
    const from = addressParts(p.from || p.From || p.sender);
    return {
      fromEmail: from.email || p.sender, fromName: from.name, subject: p.subject || p.Subject,
      body: p['stripped-text'] || p['body-plain'] || '', messageId: p['Message-Id'] || p['message-id'],
      date: p.Date || (p.timestamp ? Number(p.timestamp) * 1000 : undefined),
    };
  }
  // Generic JSON / website form
  const from = addressParts(p.from || p.email || p.fromEmail);
  return {
    fromEmail: from.email, fromName: p.name || p.fromName || from.name, phone: p.phone,
    subject: p.subject || (p.name ? `Website enquiry from ${p.name}` : 'Website enquiry'),
    body: p.text || p.body || p.message || '', messageId: p.messageId || p['message-id'], date: p.date,
  };
}

// Website forms post here from other domains, so allow cross-origin requests.
app.use('/api/inbound', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.post('/api/inbound/:token', (req, res) => {
  const row = db.prepare('SELECT id FROM businesses WHERE inbound_token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Unknown inbox' });
  const b = enq.getBusiness('id', row.id);
  const msg = normaliseInbound(req.body || {});
  const source = req.body?.message !== undefined && !req.body?.subject ? 'form' : 'webhook';
  const r = enq.ingest(b, { ...msg, body: inbox.stripQuoted(msg.body), source });
  // A plain HTML form on the business's website: send the visitor somewhere friendly.
  if (source === 'form' && req.is('urlencoded') && req.accepts(['json', 'html']) === 'html') {
    const next = String(req.body._redirect || '');
    if (/^https?:\/\//.test(next)) return res.redirect(303, next);
    return res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title>
      <body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;text-align:center">
      <div><h1>Thanks — we've got your message</h1><p>${escapeHtml(b.name)} will be in touch soon.</p></div></body>`);
  }
  res.status(r.action === 'skipped' ? 200 : 201).json(r);
});

// --- Pages -------------------------------------------------------------------

const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC, file));

app.get('/', (req, res) => {
  const s = session(req);
  if (s.admin) return res.redirect('/admin');
  if (s.business) return res.redirect(`/b/${s.business}`);
  return res.redirect('/login');
});
app.get('/login', page('login.html'));
app.get('/admin', (req, res, next) => (isAdmin(req) ? next() : res.redirect('/login')), page('admin.html'));
app.get('/b/:slug/login', page('login.html'));
app.get('/b/:slug', (req, res, next) => {
  if (!enq.getBusiness('slug', req.params.slug)) return res.status(404).send('Business not found');
  return canSee(req, req.params.slug) ? next() : res.redirect(`/b/${req.params.slug}/login`);
}, page('app.html'));
app.get('/api/b/:slug/public', (req, res) => {
  const b = enq.getBusiness('slug', req.params.slug);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json({ name: b.name, brandColor: b.brand_color });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Enquiry dashboard running on http://localhost:${port}`);
    if (!process.env.ADMIN_PASSWORD) console.log(`Admin password: ${ADMIN_PASSWORD}  (set ADMIN_PASSWORD to choose your own)`);
  });
  if (process.env.DISABLE_POLLER !== '1') inbox.startPoller();
}

module.exports = app;
