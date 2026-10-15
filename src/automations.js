// The "autopilot": reacts to new emails and sent replies.
//
//  New enquiry arrives  → AI reads it (summary, junk filter, hot/warm/cold)
//                       → optional alert to the owner for hot leads
//                       → reply prepared: a draft to approve, or sent automatically
//  We email them        → any older draft is retired; a follow-up is scheduled
//  They go quiet        → follow-up goes out (or waits as a draft), then the next one
//  They reply / deal closes → follow-ups stop
//
// Everything that may be sent lives in the `outbox` table, so the dashboard can
// show what's waiting for approval and what's scheduled.
const { db, getAppSetting } = require('./db');
const enq = require('./enquiries');
const ai = require('./ai');
const mailer = require('./mailer');

const OPEN = enq.OPEN;
const nowIso = () => new Date().toISOString();
const inflight = new Set();
const sending = new Set();

function track(promise) {
  inflight.add(promise);
  promise.finally(() => inflight.delete(promise));
  return promise;
}

// --- Helpers -----------------------------------------------------------------

function fill(template, vars) {
  return String(template || '')
    .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstName(e) {
  const n = String(e.from_name || '').trim().split(/\s+/)[0];
  return n && !n.includes('@') ? n : 'there';
}

function reSubject(subject) {
  const s = String(subject || '').trim() || 'Your enquiry';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

function threadText(business, e) {
  const msgs = db.prepare('SELECT direction, subject, body, sent_at FROM messages WHERE enquiry_id = ? ORDER BY sent_at').all(e.id);
  const who = (m) => (m.direction === 'in' ? `${e.from_name || 'Customer'} <${e.from_email}>` : business.name);
  return [
    `Customer: ${e.from_name || '(name not given)'} <${e.from_email}>${e.phone ? `, phone ${e.phone}` : ', no phone number given'}`,
    ...msgs.map((m) => `--- ${m.direction === 'in' ? 'Message from customer' : 'Our reply'} (${who(m)}, ${new Date(m.sent_at).toUTCString()})\nSubject: ${m.subject || e.subject || ''}\n\n${m.body}`),
  ].join('\n\n');
}

function getRow(id) {
  return db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
}

function tzOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

/** `days` after `fromIso`, at local time "HH:MM" in the business's time zone. */
function atLocalTime(fromIso, days, hhmm, timeZone) {
  let tz = timeZone || 'Europe/London';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'Europe/London'; }
  const target = new Date(Date.parse(fromIso) + days * 86400000);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(target);
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = String(hhmm || '09:30').split(':').map((n) => Number(n) || 0);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(guess - tzOffsetMs(new Date(guess), tz)).toISOString();
}

function localYmd(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).split('-').map(Number);
}

/** How to refer to the day of the enquiry from `at`: "earlier today", "yesterday", "on Monday", "on Monday 6 October". */
function enquiryDay(receivedIso, at = Date.now(), timeZone = 'Europe/London') {
  let tz = timeZone;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { tz = 'Europe/London'; }
  const then = new Date(receivedIso);
  const [y1, m1, d1] = localYmd(then, tz);
  const [y2, m2, d2] = localYmd(new Date(at), tz);
  const diff = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(then);
  if (diff <= 0) return 'earlier today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return `on ${weekday}`;
  return `on ${weekday} ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'long' }).format(then)}`;
}

// Follow-up sequences: "phone" chases customers who left no number; "quiet" is the normal check-in.
function sequenceFor(business, e) {
  const a = business.settings.automations;
  if (!e.phone && a.phoneChase.mode !== 'off') return 'phone';
  return 'quiet';
}

function sequenceConfig(business, sequence) {
  const a = business.settings.automations;
  if (sequence === 'phone') {
    const days = (a.phoneChase.days || []).map(Number).filter((n) => n > 0);
    if (a.phoneChase.weekLater) days.push(7);
    return { ...a.phoneChase, days };
  }
  return { ...a.followUp, days: (a.followUp.days || []).map(Number).filter((n) => n > 0) };
}

function cancel(enquiryId, kinds, statuses = ['draft', 'scheduled'], exceptId = null) {
  db.prepare(`UPDATE outbox SET status = 'cancelled' WHERE enquiry_id = ? AND kind IN (${kinds.map(() => '?').join(',')})
    AND status IN (${statuses.map(() => '?').join(',')}) AND id IS NOT ?`).run(enquiryId, ...kinds, ...statuses, exceptId);
}

function publicUrl() {
  return (process.env.APP_URL || getAppSetting('public_url') || 'http://localhost:3000').replace(/\/$/, '');
}

// --- AI reading --------------------------------------------------------------

async function analyse(business, enquiryId) {
  if (!business.settings.automations.ai.enabled || !ai.isConfigured()) return null;
  const e = getRow(enquiryId);
  try {
    const r = await ai.analyseEnquiry(business, threadText(business, e));
    db.prepare(`UPDATE enquiries SET ai_summary = ?, ai_details = ?, ai_temperature = ?, ai_reason = ?,
        phone = COALESCE(phone, NULLIF(?, '')), from_name = COALESCE(NULLIF(from_name, ''), NULLIF(?, '')),
        status = CASE WHEN ? = 0 AND status = 'new' THEN 'spam' ELSE status END, updated_at = ? WHERE id = ?`)
      .run(r.summary, JSON.stringify({ wants: r.wants, deadline: r.deadline, budget: r.budget, questions: r.questions }),
        r.temperature, r.temperature_reason, r.phone || '', r.customer_name || '', r.is_enquiry ? 1 : 0, nowIso(), enquiryId);
    return r;
  } catch (err) {
    console.warn(`[ai] analysis failed for enquiry ${enquiryId}: ${err.message}`);
    return null;
  }
}

// --- Writing replies -----------------------------------------------------------

/**
 * Write a reply or follow-up. Uses AI when chosen and available, otherwise the template.
 * @returns {Promise<{subject:string, body:string, writtenBy:'ai'|'template', note?:string}>}
 */
async function write(business, e, purpose, { step = 1, instruction = '', previousDraft = '', forceAI = false, sequence = 'quiet' } = {}) {
  const a = business.settings.automations;
  const info = business.settings.info;
  const phoneChase = purpose === 'followup' && sequence === 'phone';
  const cfg = phoneChase ? a.phoneChase : purpose === 'followup' ? a.followUp : a.reply;
  const askPhone = (a.reply.askPhone || phoneChase) && !e.phone;
  const when = enquiryDay(e.received_at, Date.now(), info.timezone);
  let note;
  if ((cfg.writer === 'ai' || forceAI || instruction) && ai.isConfigured()) {
    try {
      const d = await ai.draftReply(business, threadText(business, e), phoneChase ? 'phonechase' : purpose, {
        askPhone, followUpNumber: step, instruction, previousDraft, enquiryWhen: when,
      });
      return { subject: d.subject || reSubject(e.subject), body: d.body, writtenBy: 'ai' };
    } catch (err) {
      note = `AI couldn't write this one (${err.message}), so the template was used.`;
      console.warn(`[ai] draft failed for enquiry ${e.id}: ${err.message}`);
    }
  }
  const vars = {
    first_name: firstName(e),
    business_name: business.name,
    business_phone: info.phone || 'us',
    signature: info.signature || `The ${business.name} team`,
    subject: e.subject || '',
    enquiry_day: when,
  };
  vars.phone_ask = askPhone ? fill(a.reply.phoneAsk, vars) : '';
  const source = phoneChase ? a.phoneChase.templates : a.followUp.templates;
  const templates = source.length ? source : [''];
  const tpl = purpose === 'followup' ? templates[Math.min(step, templates.length) - 1] : a.reply.template;
  return { subject: reSubject(e.subject), body: fill(tpl, vars), writtenBy: 'template', note };
}

function insertOutbox(business, e, { kind, step = 0, status, auto, draft, dueAt = null, sequence = 'quiet' }) {
  const r = db.prepare(`INSERT INTO outbox (business_id, enquiry_id, kind, step, status, auto, subject, body, written_by, due_at, error, sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(business.id, e.id, kind, step, status, auto ? 1 : 0, draft?.subject ?? null, draft?.body ?? null, draft?.writtenBy ?? null, dueAt, draft?.note ?? null, sequence);
  return Number(r.lastInsertRowid);
}

// --- Sending -----------------------------------------------------------------------

async function sendOutbox(business, outboxId, edits = {}) {
  if (sending.has(outboxId)) throw new Error('Already sending');
  sending.add(outboxId);
  try {
    const o = db.prepare('SELECT * FROM outbox WHERE id = ? AND business_id = ?').get(outboxId, business.id);
    if (!o) throw new Error('Draft not found');
    if (!['draft', 'scheduled', 'failed'].includes(o.status)) throw new Error('This email has already been dealt with');
    const e = getRow(o.enquiry_id);
    const subject = (edits.subject ?? o.subject ?? reSubject(e.subject)).trim();
    const body = String(edits.body ?? o.body ?? '').trim();
    if (!body) throw new Error('The email is empty');
    if (e.from_email.endsWith('@manual.local')) throw new Error('This enquiry has no email address — call them instead');
    const ids = db.prepare(`SELECT message_id FROM messages WHERE enquiry_id = ? AND message_id IS NOT NULL ORDER BY sent_at`).all(e.id).map((m) => m.message_id);
    const lastIn = db.prepare(`SELECT message_id FROM messages WHERE enquiry_id = ? AND direction = 'in' AND message_id IS NOT NULL ORDER BY sent_at DESC LIMIT 1`).get(e.id);
    try {
      const { messageId } = await mailer.send(business, {
        to: e.from_name ? { name: e.from_name, address: e.from_email } : e.from_email,
        subject, text: body, inReplyTo: lastIn?.message_id, references: ids.slice(-10),
      });
      const sentAt = nowIso();
      db.prepare(`UPDATE outbox SET status = 'sent', subject = ?, body = ?, sent_at = ?, error = NULL WHERE id = ?`).run(subject, body, sentAt, o.id);
      enq.recordResponse(business, { enquiryId: e.id, date: sentAt, subject, body, messageId, auto: Boolean(o.auto) && edits.manual !== true, outboxId: o.id });
      return { ok: true };
    } catch (err) {
      db.prepare(`UPDATE outbox SET status = 'failed', subject = ?, body = ?, error = ? WHERE id = ?`).run(subject, body, err.message, o.id);
      throw err;
    }
  } finally {
    sending.delete(outboxId);
  }
}

// --- Event handlers -------------------------------------------------------------------

async function maybeAlert(business, enquiryId) {
  const al = business.settings.automations.alerts;
  if (!al.enabled || !al.email || !mailer.canSend(business)) return;
  const row = getRow(enquiryId);
  const e = enq.listEnquiries(business, { includeSpam: true }).find((x) => x.id === enquiryId);
  if (!e || e.status === 'spam' || (al.onlyHot && e.temperature !== 'hot')) return;
  const label = { hot: '🔥 Hot', warm: 'Warm', cold: 'Cold' }[e.temperature];
  const text = [
    `${label} enquiry from ${row.from_name || row.from_email}`,
    '',
    row.ai_summary || row.subject,
    e.aiDetails?.wants ? `Wants: ${e.aiDetails.wants}` : null,
    e.aiDetails?.deadline ? `When: ${e.aiDetails.deadline}` : null,
    e.aiDetails?.budget ? `Budget: ${e.aiDetails.budget}` : null,
    row.phone ? `Phone: ${row.phone}` : 'No phone number given',
    `Email: ${row.from_email}`,
    '',
    `Open it: ${publicUrl()}/b/${business.slug}#enquiry-${enquiryId}`,
  ].filter((x) => x !== null).join('\n');
  try {
    await mailer.send(business, { to: al.email, subject: `${label} enquiry: ${row.from_name || row.from_email} — ${row.ai_summary || row.subject}`.slice(0, 180), text });
  } catch (err) {
    console.warn(`[alert] ${business.slug}: ${err.message}`);
  }
}

async function onInbound({ businessId, enquiryId, action }) {
  const business = enq.getBusiness('id', businessId);
  if (!business) return;
  const a = business.settings.automations;
  // The customer wrote back: no more chasing.
  cancel(enquiryId, ['followup']);
  await analyse(business, enquiryId);
  const e = getRow(enquiryId);
  if (!e || !OPEN.includes(e.status)) return;
  if (action === 'created') await maybeAlert(business, enquiryId);

  if (a.reply.mode === 'off') return;
  if (action === 'created') {
    if (a.reply.who === 'no-phone' && e.phone) return;
    // Never auto-answer old mail (e.g. a backlog arriving late).
    if (Date.now() - Date.parse(e.received_at) > 2 * 86400000) return;
    const draft = await write(business, e, 'reply');
    const auto = a.reply.mode === 'auto';
    const delay = Math.max(0, Number(a.reply.delayMinutes) || 0);
    insertOutbox(business, e, {
      kind: 'reply', status: auto ? 'scheduled' : 'draft', auto, draft,
      dueAt: auto ? new Date(Date.now() + delay * 60000).toISOString() : null,
    });
    if (auto && delay === 0) await processDue();
  } else if (ai.isConfigured()) {
    // An ongoing conversation: prepare a fresh draft, but never auto-send mid-conversation.
    cancel(enquiryId, ['reply']);
    const draft = await write(business, e, 'reply', { forceAI: true });
    insertOutbox(business, e, { kind: 'reply', status: 'draft', auto: false, draft });
  }
}

function onOutbound({ businessId, enquiryId, sentAt, outboxId }) {
  const business = enq.getBusiness('id', businessId);
  if (!business) return;
  const sent = outboxId ? db.prepare('SELECT kind, step, sequence FROM outbox WHERE id = ?').get(outboxId) : null;
  // Whatever was waiting to answer them is now out of date.
  cancel(enquiryId, ['reply'], ['draft', 'scheduled'], outboxId);
  const e = getRow(enquiryId);
  if (!e || e.deleted_at || !OPEN.includes(e.status)) return;
  // A follow-up just went out: carry on with the same sequence. Otherwise start afresh.
  const continuing = sent?.kind === 'followup';
  const nextStep = continuing ? sent.step + 1 : 1;
  if (!continuing) cancel(enquiryId, ['followup']);
  const sequence = continuing ? sent.sequence : sequenceFor(business, e);
  if (sequence === 'phone' && e.phone) return; // they've given a number: chasing is done
  const cfg = sequenceConfig(business, sequence);
  if (cfg.mode === 'off' || nextStep > cfg.days.length) return;
  insertOutbox(business, e, {
    kind: 'followup', step: nextStep, status: 'scheduled', auto: cfg.mode === 'auto', sequence,
    dueAt: atLocalTime(sentAt, cfg.days[nextStep - 1], cfg.sendAt, business.settings.info.timezone),
  });
}

// --- Scheduler ------------------------------------------------------------------------

let processing = false;
async function processDue() {
  if (processing) return;
  processing = true;
  try {
    const due = db.prepare(`SELECT * FROM outbox WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at LIMIT 25`).all(nowIso());
    for (const o of due) {
      const business = enq.getBusiness('id', o.business_id);
      const e = getRow(o.enquiry_id);
      const stop = (reason) => db.prepare(`UPDATE outbox SET status = 'cancelled', error = ? WHERE id = ?`).run(reason, o.id);
      if (!e || e.deleted_at || !OPEN.includes(e.status)) { stop('Enquiry closed'); continue; }
      if (o.sequence === 'phone' && e.phone) { stop('They gave a phone number'); continue; }
      if (o.kind === 'followup' && e.last_response_at && e.last_inbound_at > e.last_response_at) { stop('Customer replied'); continue; }
      if (o.kind === 'reply' && e.last_response_at && e.last_response_at > o.created_at) { stop('Already answered'); continue; }
      if (!o.body) {
        const draft = await write(business, e, o.kind, { step: o.step, sequence: o.sequence });
        db.prepare('UPDATE outbox SET subject = ?, body = ?, written_by = ?, error = ? WHERE id = ?').run(draft.subject, draft.body, draft.writtenBy, draft.note || null, o.id);
      }
      if (!o.auto || !mailer.canSend(business)) {
        db.prepare(`UPDATE outbox SET status = 'draft', error = COALESCE(error, ?) WHERE id = ?`)
          .run(o.auto ? 'Couldn\'t send automatically because the mailbox isn\'t connected for sending.' : null, o.id);
        continue;
      }
      try {
        await sendOutbox(business, o.id);
      } catch (err) {
        console.warn(`[outbox] ${business.slug} #${o.id} failed: ${err.message}`);
      }
    }
  } finally {
    processing = false;
  }
}

// --- Actions from the dashboard ----------------------------------------------------------

/** (Re)write the reply draft for an enquiry, optionally following an instruction. */
async function draftNow(business, enquiryId, { instruction = '' } = {}) {
  const e = getRow(enquiryId);
  if (!e || e.business_id !== business.id) throw new Error('Not found');
  const existing = db.prepare(`SELECT * FROM outbox WHERE enquiry_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1`).get(enquiryId);
  const purpose = existing?.kind === 'followup' ? 'followup' : 'reply';
  const draft = await write(business, e, purpose, {
    step: existing?.step || 1, instruction, previousDraft: instruction ? existing?.body : '', forceAI: true, sequence: existing?.sequence,
  });
  if (existing) {
    db.prepare('UPDATE outbox SET subject = ?, body = ?, written_by = ?, error = ? WHERE id = ?').run(draft.subject, draft.body, draft.writtenBy, draft.note || null, existing.id);
    return existing.id;
  }
  return insertOutbox(business, e, { kind: 'reply', status: 'draft', auto: false, draft });
}

function updateDraft(business, outboxId, { subject, body }) {
  db.prepare(`UPDATE outbox SET subject = COALESCE(?, subject), body = COALESCE(?, body) WHERE id = ? AND business_id = ? AND status IN ('draft','scheduled','failed')`)
    .run(subject ?? null, body ?? null, outboxId, business.id);
}

function discard(business, outboxId) {
  db.prepare(`UPDATE outbox SET status = 'cancelled' WHERE id = ? AND business_id = ? AND status IN ('draft','scheduled','failed')`).run(outboxId, business.id);
}

async function sendDraft(business, outboxId, edits) {
  return sendOutbox(business, outboxId, { ...edits, manual: true });
}

/** Send a reply written from scratch in the dashboard. */
async function sendNew(business, enquiryId, { subject, body }) {
  const e = getRow(enquiryId);
  if (!e || e.business_id !== business.id) throw new Error('Not found');
  const id = insertOutbox(business, e, { kind: 'reply', status: 'draft', auto: false, draft: { subject: subject || reSubject(e.subject), body, writtenBy: 'manual' } });
  return sendOutbox(business, id, { manual: true });
}

function queue(business) {
  return db.prepare(`SELECT o.id, o.enquiry_id AS enquiryId, o.kind, o.step, o.subject, o.body, o.written_by AS writtenBy, o.error, o.created_at AS createdAt,
      e.from_name AS fromName, e.from_email AS fromEmail, e.ai_summary AS aiSummary
    FROM outbox o JOIN enquiries e ON e.id = o.enquiry_id
    WHERE o.business_id = ? AND o.status IN ('draft','failed') AND e.status != 'spam' ORDER BY o.created_at`).all(business.id);
}

function start() {
  enq.events.on('inbound', (ev) => track(onInbound(ev).catch((err) => console.error('[automations] inbound', err))));
  enq.events.on('outbound', (ev) => { try { onOutbound(ev); } catch (err) { console.error('[automations] outbound', err); } });
  if (process.env.DISABLE_SCHEDULER !== '1') {
    setInterval(() => processDue().catch((err) => console.error('[automations] scheduler', err)), 30000).unref();
    // Empty trash older than 7 days, now and hourly.
    const purge = () => { try { enq.purgeTrash(); } catch (err) { console.error('[trash] purge', err); } };
    setTimeout(purge, 10000).unref();
    setInterval(purge, 3600000).unref();
  }
}

module.exports = {
  start, processDue, draftNow, updateDraft, discard, sendDraft, sendNew, queue,
  idle: () => Promise.all([...inflight]), atLocalTime, enquiryDay, fill, write,
};
