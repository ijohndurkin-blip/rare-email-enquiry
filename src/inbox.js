// IMAP inbox sync. Pulls new mail from the business inbox into enquiries, and
// (optionally) reads the Sent folder so response times are tracked automatically.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db } = require('./db');
const { decrypt } = require('./security');
const { getBusiness, ingest, recordResponse } = require('./enquiries');

const FIRST_SYNC_DAYS = 30;
const running = new Set();

function client(inbox) {
  const c = new ImapFlow({
    host: inbox.host,
    port: Number(inbox.port) || 993,
    secure: inbox.secure !== false,
    auth: { user: inbox.user || inbox.email, pass: decrypt(inbox.password) },
    logger: false,
    socketTimeout: 60000,
  });
  c.on('error', (err) => console.warn(`[imap] ${inbox.host}: ${err.message}`)); // don't crash on dropped connections
  return c;
}

// Strip quoted reply history so scoring only sees what the customer just wrote.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || (/^From:\s.+/i.test(line) && out.length > 3)) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

async function syncFolder(imap, folder, state, key, onMessage) {
  const lock = await imap.getMailboxLock(folder);
  try {
    const box = imap.mailbox;
    const prev = state[key] || {};
    // The first sync imports recent history quietly — no auto-replies to old mail.
    const initial = !prev.lastUid;
    let range;
    if (prev.uidValidity && String(prev.uidValidity) === String(box.uidValidity) && prev.lastUid) {
      range = { uid: `${prev.lastUid + 1}:*` };
    } else {
      const since = new Date(Date.now() - FIRST_SYNC_DAYS * 86400000);
      const uids = await imap.search({ since }, { uid: true });
      if (!uids || !uids.length) {
        state[key] = { uidValidity: String(box.uidValidity), lastUid: Math.max(0, (box.uidNext || 1) - 1) };
        return 0;
      }
      range = { uid: uids.join(',') };
    }
    let lastUid = prev.lastUid || 0;
    let count = 0;
    for await (const msg of imap.fetch(range.uid, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= (prev.lastUid || 0) && prev.uidValidity === String(box.uidValidity)) continue;
      const parsed = await simpleParser(msg.source);
      await onMessage(parsed, initial);
      lastUid = Math.max(lastUid, msg.uid);
      count += 1;
    }
    state[key] = { uidValidity: String(box.uidValidity), lastUid };
    return count;
  } finally {
    lock.release();
  }
}

async function syncBusiness(businessId) {
  if (running.has(businessId)) return { skipped: true };
  running.add(businessId);
  const business = getBusiness('id', businessId);
  const state = { ...business.sync_state };
  const result = { created: 0, appended: 0, replies: 0 };
  try {
    const { inbox } = business.settings;
    if (!inbox.host || !(inbox.user || inbox.email)) throw new Error('Inbox is not configured');
    const imap = client(inbox);
    await imap.connect();
    try {
      await syncFolder(imap, inbox.folder || 'INBOX', state, 'inbox', async (m, initial) => {
        const from = m.from?.value?.[0];
        const r = ingest(business, {
          fromEmail: from?.address,
          fromName: from?.name,
          subject: m.subject,
          body: stripQuoted(m.text || ''),
          messageId: m.messageId,
          date: m.date,
          source: 'email',
        }, { silent: initial });
        if (r.action === 'created') result.created += 1;
        if (r.action === 'appended') result.appended += 1;
      });
      if (inbox.sentFolder) {
        await syncFolder(imap, inbox.sentFolder, state, 'sent', async (m, initial) => {
          for (const to of m.to?.value || []) {
            const id = recordResponse(business, {
              toEmail: to.address, date: m.date, subject: m.subject,
              body: stripQuoted(m.text || ''), messageId: m.messageId,
            }, { silent: initial });
            if (id) result.replies += 1;
          }
        });
      }
    } finally {
      await imap.logout().catch(() => {});
    }
    state.lastSync = new Date().toISOString();
    state.lastError = null;
    return result;
  } catch (err) {
    state.lastError = err.responseText || err.message;
    state.lastErrorAt = new Date().toISOString();
    throw err;
  } finally {
    db.prepare('UPDATE businesses SET sync_state = ? WHERE id = ?').run(JSON.stringify(state), businessId);
    running.delete(businessId);
  }
}

async function testConnection(inbox) {
  const imap = client(inbox);
  await imap.connect();
  try {
    const folders = (await imap.list()).map((f) => f.path);
    return { ok: true, folders };
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Background poller: checks each enabled inbox on its own interval.
function startPoller() {
  const tick = () => {
    const rows = db.prepare('SELECT id FROM businesses').all();
    for (const { id } of rows) {
      const b = getBusiness('id', id);
      const { inbox } = b.settings;
      if (!inbox.enabled || !inbox.host) continue;
      const last = Date.parse(b.sync_state.lastSync || b.sync_state.lastErrorAt || 0) || 0;
      if (Date.now() - last < Math.max(1, inbox.pollMinutes) * 60000) continue;
      syncBusiness(id).then((r) => {
        if (r.created || r.appended || r.replies) console.log(`[sync] ${b.slug}:`, r);
      }).catch((err) => console.warn(`[sync] ${b.slug} failed: ${err.message}`));
    }
  };
  setTimeout(tick, 5000);
  return setInterval(tick, 60000);
}

module.exports = { syncBusiness, testConnection, startPoller, stripQuoted };
