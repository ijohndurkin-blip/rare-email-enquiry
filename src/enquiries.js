const { EventEmitter } = require('node:events');
const { db, tx } = require('./db');
const { loadSettings } = require('./settings');
const { scoreEnquiry, ageAdjustment, temperatureFor } = require('./scoring');

const OPEN = ['new', 'contacted', 'quoted'];
// 'inbound' / 'outbound' events drive the automations (see automations.js).
const events = new EventEmitter();
const THREAD_WINDOW_DAYS = 60;
const now = () => new Date().toISOString();

function getBusiness(where, value) {
  const b = db.prepare(`SELECT * FROM businesses WHERE ${where} = ?`).get(value);
  if (!b) return null;
  return { ...b, settings: loadSettings(b.settings), sync_state: JSON.parse(b.sync_state || '{}') };
}

const normEmail = (e) => String(e || '').trim().toLowerCase();

function ownAddresses(business) {
  return [business.settings.inbox.user, business.settings.inbox.email, business.settings.contactEmail].map(normEmail).filter(Boolean);
}

function rescore(business, enquiryId) {
  const e = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(enquiryId);
  const inbound = db.prepare(`SELECT body, subject FROM messages WHERE enquiry_id = ? AND direction = 'in' ORDER BY sent_at`).all(enquiryId);
  const result = scoreEnquiry({
    subject: e.subject,
    body: inbound.map((m) => m.body).join('\n\n'),
    fromEmail: e.from_email,
    inboundCount: inbound.length,
  }, business.settings.scoring);
  const status = result.spam && e.status === 'new' ? 'spam' : e.status;
  db.prepare(`UPDATE enquiries SET score = ?, signals = ?, budget = ?, phone = COALESCE(phone, ?), status = ?, updated_at = ? WHERE id = ?`)
    .run(result.score, JSON.stringify(result.signals), result.budget, result.phone, status, now(), enquiryId);
}

/**
 * Add an inbound email to the right enquiry (new, or appended to an open thread
 * from the same sender). Returns { action: 'created'|'appended'|'skipped', id?, reason? }.
 */
function ingest(business, msg, { silent = false } = {}) {
  const fromEmail = normEmail(msg.fromEmail);
  if (!fromEmail || !fromEmail.includes('@')) return { action: 'skipped', reason: 'no sender' };
  if (ownAddresses(business).includes(fromEmail)) return { action: 'skipped', reason: 'sent by the business' };
  if (business.settings.scoring.ignoreSenders.some((s) => fromEmail.includes(String(s).toLowerCase()))) {
    return { action: 'skipped', reason: 'ignored sender' };
  }

  const sentAt = msg.date ? new Date(msg.date).toISOString() : now();
  const body = String(msg.body || '').trim();
  const messageId = msg.messageId ? String(msg.messageId) : null;

  const result = tx(() => {
    if (messageId) {
      const dupe = db.prepare(`SELECT e.id FROM messages m JOIN enquiries e ON e.id = m.enquiry_id
        WHERE e.business_id = ? AND m.message_id = ?`).get(business.id, messageId);
      if (dupe) return { action: 'skipped', reason: 'duplicate', id: dupe.id };
    }

    const since = new Date(Date.parse(sentAt) - THREAD_WINDOW_DAYS * 86400000).toISOString();
    const open = db.prepare(`SELECT id FROM enquiries WHERE business_id = ? AND from_email = ?
      AND status IN ('new','contacted','quoted') AND last_inbound_at >= ? ORDER BY last_inbound_at DESC LIMIT 1`)
      .get(business.id, fromEmail, since);

    let id;
    let action;
    if (open) {
      id = open.id;
      action = 'appended';
      db.prepare(`UPDATE enquiries SET last_inbound_at = MAX(last_inbound_at, ?),
        from_name = COALESCE(NULLIF(from_name, ''), ?), updated_at = ? WHERE id = ?`)
        .run(sentAt, msg.fromName || null, now(), id);
    } else {
      action = 'created';
      const r = db.prepare(`INSERT INTO enquiries (business_id, from_name, from_email, phone, subject, received_at, last_inbound_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(business.id, msg.fromName || null, fromEmail, msg.phone || null, msg.subject || '(no subject)', sentAt, sentAt, msg.source || 'email');
      id = Number(r.lastInsertRowid);
    }
    db.prepare(`INSERT INTO messages (enquiry_id, direction, message_id, subject, body, sent_at) VALUES (?, 'in', ?, ?, ?, ?)`)
      .run(id, messageId, msg.subject || null, body, sentAt);
    rescore(business, id);
    return { action, id };
  });
  if (!silent && result.action !== 'skipped') events.emit('inbound', { businessId: business.id, enquiryId: result.id, action: result.action });
  return result;
}

/** Record a reply sent by the business (from the Sent folder, or "mark replied"). */
function recordResponse(business, { toEmail, enquiryId, date, body, subject, messageId, auto = false, outboxId = null }, { silent = false } = {}) {
  const sentAt = date ? new Date(date).toISOString() : now();
  const e = enquiryId
    ? db.prepare('SELECT * FROM enquiries WHERE id = ? AND business_id = ?').get(enquiryId, business.id)
    : db.prepare(`SELECT * FROM enquiries WHERE business_id = ? AND from_email = ? AND received_at <= ?
        ORDER BY last_inbound_at DESC LIMIT 1`).get(business.id, normEmail(toEmail), sentAt);
  if (!e) return null;
  if (messageId && db.prepare('SELECT 1 FROM messages WHERE enquiry_id = ? AND message_id = ?').get(e.id, messageId)) return e.id;
  tx(() => {
    db.prepare(`INSERT INTO messages (enquiry_id, direction, message_id, subject, body, sent_at, auto) VALUES (?, 'out', ?, ?, ?, ?, ?)`)
      .run(e.id, messageId || null, subject || null, body || '', sentAt, auto ? 1 : 0);
    db.prepare(`UPDATE enquiries SET
        first_response_at = CASE WHEN first_response_at IS NULL OR first_response_at > ? THEN ? ELSE first_response_at END,
        last_response_at = CASE WHEN last_response_at IS NULL OR last_response_at < ? THEN ? ELSE last_response_at END,
        status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
        updated_at = ? WHERE id = ?`)
      .run(sentAt, sentAt, sentAt, sentAt, now(), e.id);
  });
  if (!silent) events.emit('outbound', { businessId: business.id, enquiryId: e.id, sentAt, outboxId });
  return e.id;
}

// --- Read models -----------------------------------------------------------

function present(business, e, at = Date.now()) {
  const rules = business.settings.scoring;
  const signals = JSON.parse(e.signals || '[]');
  let score = e.score;
  const closed = !OPEN.includes(e.status);
  if (!closed) {
    const age = ageAdjustment(e.last_inbound_at, at);
    if (age) {
      signals.push({ label: age.label, points: age.points });
      score = Math.max(0, score + age.points);
    }
  }
  const aiOn = business.settings.automations.ai.enabled;
  const aiTemp = aiOn && e.ai_temperature && !closed ? e.ai_temperature : null;
  const temperature = e.temp_override || aiTemp || temperatureFor(score, rules);
  let aiDetails = {};
  try { aiDetails = JSON.parse(e.ai_details || '{}'); } catch { /* ignore */ }
  const awaitingReply = !closed && (!e.last_response_at || e.last_response_at < e.last_inbound_at);
  const waitingHours = awaitingReply ? (at - Date.parse(e.last_inbound_at)) / 3600000 : 0;
  return {
    id: e.id,
    fromName: e.from_name,
    fromEmail: e.from_email,
    phone: e.phone,
    subject: e.subject,
    receivedAt: e.received_at,
    lastInboundAt: e.last_inbound_at,
    firstResponseAt: e.first_response_at,
    lastResponseAt: e.last_response_at,
    score,
    temperature,
    tempOverridden: Boolean(e.temp_override),
    tempSource: e.temp_override ? 'manual' : aiTemp ? 'ai' : 'rules',
    aiSummary: e.ai_summary || null,
    aiReason: e.ai_reason || null,
    aiDetails,
    draftCount: e.draft_count ?? undefined,
    nextScheduledAt: e.next_scheduled ?? undefined,
    signals,
    budget: e.budget,
    value: e.value,
    status: e.status,
    notes: e.notes,
    source: e.source,
    awaitingReply,
    waitingHours,
    overdue: awaitingReply && waitingHours > business.settings.responseTargetHours,
    preview: e.preview ?? undefined,
    messageCount: e.message_count ?? undefined,
  };
}

function listEnquiries(business, { includeSpam = false } = {}) {
  const rows = db.prepare(`SELECT e.*,
      (SELECT substr(body, 1, 220) FROM messages m WHERE m.enquiry_id = e.id AND m.direction = 'in' ORDER BY sent_at DESC LIMIT 1) AS preview,
      (SELECT COUNT(*) FROM messages m WHERE m.enquiry_id = e.id) AS message_count,
      (SELECT COUNT(*) FROM outbox o WHERE o.enquiry_id = e.id AND o.status = 'draft') AS draft_count,
      (SELECT MIN(due_at) FROM outbox o WHERE o.enquiry_id = e.id AND o.status = 'scheduled') AS next_scheduled
    FROM enquiries e WHERE e.business_id = ? ${includeSpam ? '' : "AND e.status != 'spam'"}
    ORDER BY e.last_inbound_at DESC`).all(business.id);
  const at = Date.now();
  return rows.map((r) => present(business, r, at));
}

function getEnquiry(business, id) {
  const e = db.prepare('SELECT * FROM enquiries WHERE id = ? AND business_id = ?').get(id, business.id);
  if (!e) return null;
  const messages = db.prepare('SELECT direction, subject, body, sent_at AS sentAt, auto FROM messages WHERE enquiry_id = ? ORDER BY sent_at').all(id)
    .map((m) => ({ ...m, auto: Boolean(m.auto) }));
  const outbox = db.prepare(`SELECT id, kind, step, status, auto, subject, body, written_by AS writtenBy, due_at AS dueAt, error, created_at AS createdAt
    FROM outbox WHERE enquiry_id = ? AND status IN ('draft','scheduled','failed') ORDER BY COALESCE(due_at, created_at)`).all(id)
    .map((o) => ({ ...o, auto: Boolean(o.auto) }));
  return { ...present(business, e), messages, outbox };
}

function updateEnquiry(business, id, patch) {
  const e = db.prepare('SELECT * FROM enquiries WHERE id = ? AND business_id = ?').get(id, business.id);
  if (!e) return null;
  const sets = [];
  const vals = [];
  if (patch.status !== undefined) {
    if (!['new', 'contacted', 'quoted', 'won', 'lost', 'spam'].includes(patch.status)) throw new Error('Invalid status');
    sets.push('status = ?'); vals.push(patch.status);
  }
  if (patch.tempOverride !== undefined) {
    const t = patch.tempOverride || null;
    if (t && !['hot', 'warm', 'cold'].includes(t)) throw new Error('Invalid temperature');
    sets.push('temp_override = ?'); vals.push(t);
  }
  if (patch.notes !== undefined) { sets.push('notes = ?'); vals.push(String(patch.notes).slice(0, 10000)); }
  if (patch.value !== undefined) {
    const v = patch.value === '' || patch.value === null ? null : Number(patch.value);
    if (v !== null && !Number.isFinite(v)) throw new Error('Invalid value');
    sets.push('value = ?'); vals.push(v);
  }
  if (patch.phone !== undefined) { sets.push('phone = ?'); vals.push(patch.phone || null); }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(now());
    db.prepare(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  if (patch.markReplied) recordResponse(business, { enquiryId: id, body: '(Marked as replied)' });
  return getEnquiry(business, id);
}

function rescoreAll(business) {
  const ids = db.prepare('SELECT id FROM enquiries WHERE business_id = ?').all(business.id);
  tx(() => ids.forEach(({ id }) => rescore(business, id)));
  return ids.length;
}

// --- Dashboard summary -----------------------------------------------------

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function summary(business, days = 30) {
  const all = listEnquiries(business, { includeSpam: true });
  const at = Date.now();
  const start = at - days * 86400000;
  const prevStart = start - days * 86400000;
  const genuine = all.filter((e) => e.status !== 'spam');
  const inPeriod = genuine.filter((e) => Date.parse(e.receivedAt) >= start);
  const inPrev = genuine.filter((e) => { const t = Date.parse(e.receivedAt); return t >= prevStart && t < start; });
  const open = genuine.filter((e) => OPEN.includes(e.status));

  const byTemp = { hot: 0, warm: 0, cold: 0 };
  open.forEach((e) => { byTemp[e.temperature] += 1; });

  const responseHours = (list) => list.filter((e) => e.firstResponseAt)
    .map((e) => (Date.parse(e.firstResponseAt) - Date.parse(e.receivedAt)) / 3600000)
    .filter((h) => h >= 0);
  const rt = responseHours(inPeriod);
  const rtPrev = responseHours(inPrev);

  const closedInPeriod = inPeriod.filter((e) => e.status === 'won' || e.status === 'lost');
  const won = closedInPeriod.filter((e) => e.status === 'won');

  // Daily counts by temperature (as currently assessed) for the trend chart.
  const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    series.push({ date: dayKey(at - i * 86400000), hot: 0, warm: 0, cold: 0 });
  }
  const idx = new Map(series.map((d, i) => [d.date, i]));
  inPeriod.forEach((e) => {
    const i = idx.get(dayKey(Date.parse(e.receivedAt)));
    if (i !== undefined) series[i][e.temperature] += 1;
  });

  const status = { new: 0, contacted: 0, quoted: 0, won: 0, lost: 0 };
  inPeriod.forEach((e) => { if (e.status in status) status[e.status] += 1; });

  const awaiting = open.filter((e) => e.awaitingReply);
  const tempRank = { hot: 0, warm: 1, cold: 2 };
  const needsAttention = awaiting
    // Cold leads only make the list while they're fresh (under 3 days old).
    .filter((e) => e.temperature !== 'cold' || e.waitingHours < 72)
    .sort((a, b) => tempRank[a.temperature] - tempRank[b.temperature] || b.waitingHours - a.waitingHours)
    .slice(0, 8);

  return {
    business: { name: business.name, slug: business.slug, brandColor: business.brand_color },
    responseTargetHours: business.settings.responseTargetHours,
    currency: business.settings.scoring.currency,
    days,
    lastSync: business.sync_state.lastSync || null,
    lastSyncError: business.sync_state.lastError || null,
    inboxEnabled: business.settings.inbox.enabled,
    totals: {
      enquiries: inPeriod.length,
      enquiriesPrev: inPrev.length,
      open: open.length,
      awaitingReply: awaiting.length,
      overdue: awaiting.filter((e) => e.overdue).length,
      hotAwaiting: awaiting.filter((e) => e.temperature === 'hot').length,
      medianResponseHours: median(rt),
      medianResponseHoursPrev: median(rtPrev),
      won: won.length,
      lost: closedInPeriod.length - won.length,
      winRate: closedInPeriod.length ? won.length / closedInPeriod.length : null,
      wonValue: won.reduce((s, e) => s + (e.value || 0), 0),
      pipelineValue: open.reduce((s, e) => s + (e.value || e.budget || 0), 0),
      spam: all.filter((e) => e.status === 'spam' && Date.parse(e.receivedAt) >= start).length,
      drafts: db.prepare(`SELECT COUNT(*) AS n FROM outbox o JOIN enquiries e ON e.id = o.enquiry_id
        WHERE o.business_id = ? AND o.status = 'draft' AND e.status != 'spam'`).get(business.id).n,
      autoSent: db.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN enquiries e ON e.id = m.enquiry_id
        WHERE e.business_id = ? AND m.direction = 'out' AND m.auto = 1 AND m.sent_at >= ?`).get(business.id, new Date(start).toISOString()).n,
    },
    byTemp,
    status,
    series,
    needsAttention,
  };
}

module.exports = {
  events, getBusiness, ingest, recordResponse, rescore, rescoreAll,
  listEnquiries, getEnquiry, updateEnquiry, summary, OPEN,
};
