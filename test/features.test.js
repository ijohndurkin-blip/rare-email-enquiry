// Phone-number chase, always-hot words, trash, contacts and client settings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'enq-feat-'));
process.env.DISABLE_SCHEDULER = '1';
process.env.ADMIN_PASSWORD = 'admin-pass';

const { db } = require('../src/db');
const sec = require('../src/security');
const enq = require('../src/enquiries');
const mailer = require('../src/mailer');
const automations = require('../src/automations');
const contacts = require('../src/contacts');
const { extractPhone } = require('../src/scoring');
const app = require('../src/server');

const sent = [];
mailer._setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); return {}; }, close() {} }));

let n = 0;
function makeBusiness(settings) {
  n += 1;
  const slug = `biz-${n}`;
  db.prepare('INSERT INTO businesses (slug, name, inbound_token, access_hash, settings) VALUES (?, ?, ?, ?, ?)').run(slug, `Biz ${n}`, sec.randomToken(), sec.hashCode('code'), JSON.stringify({
    inbox: { email: 'hello@biz.test', user: 'hello@biz.test', password: sec.encrypt('pw'), smtpHost: 'smtp.biz.test' },
    info: { phone: '0113 000 0000', signature: 'Sam', timezone: 'Europe/London' },
    ...settings,
  }));
  return enq.getBusiness('slug', slug);
}

async function inbound(b, msg) {
  const r = enq.ingest(b, { fromEmail: 'kim@example.com', fromName: 'Kim Lee', subject: 'Banners', messageId: `<${Math.random()}@x>`, ...msg });
  await automations.idle();
  return r;
}

const followUps = (id) => db.prepare("SELECT * FROM outbox WHERE enquiry_id = ? AND kind = 'followup' ORDER BY id").all(id);
const runDue = async (o) => { db.prepare("UPDATE outbox SET due_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(o.id); await automations.processDue(); };

test('"only people without a phone number": no reply for those who left one, reply for those who did not', async () => {
  const b = makeBusiness({ automations: { reply: { mode: 'auto', who: 'no-phone', writer: 'template', delayMinutes: 0 } } });
  sent.length = 0;
  await inbound(b, { fromEmail: 'a@example.com', body: 'Quote for banners please. Mobile 07700 900123' });
  await inbound(b, { fromEmail: 'b@example.com', body: 'Quote for banners please. Call me on +44 (0)113 496 0000' });
  await inbound(b, { fromEmail: 'c@example.com', body: 'Quote for banners please, order ref 123456789, needed 2026-11-02' });
  assert.equal(sent.length, 1, 'only the enquiry without a phone number gets the automatic reply');
  assert.match(String(sent[0].to.address || sent[0].to), /c@example\.com/);
});

test('phone detection ignores dates and reference numbers', () => {
  assert.ok(extractPhone('ring me 07700 900123'));
  assert.ok(extractPhone('tel: 0113 496 0000'));
  assert.ok(extractPhone('+1 415 555 0100'));
  assert.equal(extractPhone('ref 123456789'), null);
  assert.equal(extractPhone('on 2026-10-15 10:30'), null);
  assert.equal(extractPhone('by 15/10/2026'), null);
});

test('phone chase: next day, day after, a week later — then stops once they give a number', async () => {
  const b = makeBusiness({
    automations: {
      reply: { mode: 'auto', writer: 'template', delayMinutes: 0 },
      followUp: { mode: 'auto', writer: 'template', days: [3] },
      phoneChase: { mode: 'auto', writer: 'template', days: [1, 1], weekLater: true },
    },
  });
  sent.length = 0;
  const r = await inbound(b, { body: 'How much for a 3m banner?' });
  assert.equal(sent.length, 1, 'first reply sent');

  let fu = followUps(r.id);
  assert.equal(fu.length, 1);
  assert.equal(fu[0].sequence, 'phone', 'no phone number, so the phone chase is used instead of the normal follow-up');
  const days = (Date.parse(fu[0].due_at) - Date.now()) / 86400000;
  assert.ok(days > 0 && days < 2, `first chase due the next day, got ${days}`);

  // Pretend the enquiry came in yesterday when the first chase goes out.
  db.prepare('UPDATE enquiries SET received_at = ? WHERE id = ?').run(new Date(Date.now() - 86400000).toISOString(), r.id);
  await runDue(fu[0]);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /yesterday/, 'mentions when they got in touch');
  assert.match(sent[1].text, /best number/);

  fu = followUps(r.id);
  assert.equal(fu.length, 2, 'second chase scheduled');
  assert.equal(fu[1].step, 2);
  assert.equal(fu[1].sequence, 'phone');

  // They reply with a number before the second chase: it is cancelled and nothing more is scheduled.
  await inbound(b, { body: 'Sure, it is 07700 900555', subject: 'Re: Banners' });
  fu = followUps(r.id);
  assert.equal(fu.filter((o) => o.status === 'scheduled').length, 0);
});

test('phone chase schedules three steps when "a week later" is on', async () => {
  const b = makeBusiness({
    automations: {
      reply: { mode: 'auto', writer: 'template', delayMinutes: 0 },
      phoneChase: { mode: 'auto', writer: 'template', days: [1, 1], weekLater: true },
    },
  });
  sent.length = 0;
  const r = await inbound(b, { body: 'Price for flyers?' });
  for (let step = 1; step <= 3; step += 1) {
    const due = followUps(r.id).find((o) => o.status === 'scheduled');
    assert.ok(due, `step ${step} scheduled`);
    assert.equal(due.step, step);
    await runDue(due);
  }
  assert.equal(followUps(r.id).filter((o) => o.status === 'scheduled').length, 0, 'no fourth chase');
  assert.equal(sent.length, 4, 'reply + three chases');
});

test('the enquiry day reads naturally', () => {
  const mon = '2026-10-12T10:00:00Z'; // a Monday
  assert.equal(automations.enquiryDay(mon, Date.parse('2026-10-12T15:00:00Z')), 'earlier today');
  assert.equal(automations.enquiryDay(mon, Date.parse('2026-10-13T09:30:00Z')), 'yesterday');
  assert.equal(automations.enquiryDay(mon, Date.parse('2026-10-14T09:30:00Z')), 'on Monday');
  assert.equal(automations.enquiryDay(mon, Date.parse('2026-10-21T09:30:00Z')), 'on Monday 12 October');
});

test('"always hot" words: two matches make the lead hot', async () => {
  const b = makeBusiness({ scoring: { hotTerms: ['price', 'deposit', 'book in'], hotMinMatches: 2 } });
  const one = await inbound(b, { fromEmail: 'one@x.com', body: 'Just a quick question about price' });
  const two = await inbound(b, { fromEmail: 'two@x.com', body: 'What price, and can I pay a deposit? Just wondering, no rush, maybe next year' });
  assert.notEqual(enq.getEnquiry(b, one.id).temperature, 'hot');
  const e = enq.getEnquiry(b, two.id);
  assert.equal(e.temperature, 'hot');
  assert.equal(e.tempSource, 'words');
});

test('trash: delete, restore, and purge after 7 days', async () => {
  const b = makeBusiness({});
  const r = await inbound(b, { fromEmail: 'trash@x.com', body: 'hello there' });
  assert.ok(enq.trashEnquiry(b, r.id));
  assert.equal(enq.listEnquiries(b).some((e) => e.id === r.id), false);
  assert.equal(enq.listEnquiries(b, { trash: true }).length, 1);
  assert.ok(enq.restoreEnquiry(b, r.id));
  assert.equal(enq.listEnquiries(b).some((e) => e.id === r.id), true);

  enq.trashEnquiry(b, r.id);
  assert.equal(enq.purgeTrash(), 0, 'not purged before 7 days');
  db.prepare('UPDATE enquiries SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 8 * 86400000).toISOString(), r.id);
  assert.equal(enq.purgeTrash(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE enquiry_id = ?').get(r.id).n, 0, 'messages removed too');
});

test('contacts: import and recognise previous customers', async () => {
  const b = makeBusiness({});
  const res = contacts.importRows(b.id, [
    { name: 'Pat Jones', company: 'Jones Ltd', email: 'Pat@Jones.co.uk', phone: '07700 900777' },
    { name: 'Sam Smith', email: 'sam@smith.com' },
    { name: '' },
  ]);
  assert.deepEqual(res, { added: 2, updated: 0, skipped: 1 });
  assert.equal(contacts.importRows(b.id, [{ email: 'sam@smith.com', phone: '0113 1112222' }]).updated, 1);

  const byEmail = await inbound(b, { fromEmail: 'pat@jones.co.uk', body: 'Need more banners' });
  const byPhone = await inbound(b, { fromEmail: 'other@gmail.com', body: 'New enquiry, call me +44 7700 900777' });
  const stranger = await inbound(b, { fromEmail: 'new@gmail.com', body: 'Hi' });
  assert.equal(enq.getEnquiry(b, byEmail.id).contact.name, 'Pat Jones');
  assert.equal(enq.getEnquiry(b, byPhone.id).contact.company, 'Jones Ltd');
  assert.equal(enq.getEnquiry(b, stranger.id).contact, null);
});

test('business owners can manage their own settings, but not other businesses or admin features', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body, cookie) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const mine = makeBusiness({});
    const other = makeBusiness({});
    const cookie = (await call('POST', '/api/login', { slug: mine.slug, password: 'code' })).headers.get('set-cookie').split(';')[0];

    const view = await (await call('GET', `/api/b/${mine.slug}/settings`, null, cookie)).json();
    assert.equal(view.name, mine.name);
    assert.equal(view.settings.inbox.password, '********');
    assert.equal(view.canEditAddress, false);

    const put = await call('PUT', `/api/b/${mine.slug}/settings`, {
      name: 'Renamed', slug: 'stolen-address',
      settings: { scoring: { hotTerms: ['price', 'deposit'] }, automations: { phoneChase: { mode: 'draft', days: [1, 2] } } },
    }, cookie);
    assert.equal(put.status, 200);
    const saved = enq.getBusiness('id', mine.id);
    assert.equal(saved.name, 'Renamed');
    assert.equal(saved.slug, mine.slug, 'owners cannot change the dashboard address');
    assert.deepEqual(saved.settings.scoring.hotTerms, ['price', 'deposit']);
    assert.deepEqual(saved.settings.automations.phoneChase.days, [1, 2]);

    assert.equal((await call('GET', `/api/b/${other.slug}/settings`, null, cookie)).status, 401);
    assert.equal((await call('GET', `/api/admin/businesses/${mine.id}`, null, cookie)).status, 401);
    assert.equal((await call('GET', '/api/admin/ai', null, cookie)).status, 401);

    // Contacts and trash over HTTP.
    const c = await (await call('POST', `/api/b/${mine.slug}/contacts`, { name: 'Lee', email: 'lee@x.com' }, cookie)).json();
    assert.equal(c.email, 'lee@x.com');
    const e = enq.ingest(saved, { fromEmail: 'lee@x.com', subject: 'Hi', body: 'More flyers please' }, { silent: true });
    const list = await (await call('GET', `/api/b/${mine.slug}/enquiries`, null, cookie)).json();
    assert.equal(list.find((x) => x.id === e.id).contact.name, 'Lee');
    assert.equal((await call('DELETE', `/api/b/${mine.slug}/enquiries/${e.id}`, null, cookie)).status, 200);
    const trash = await (await call('GET', `/api/b/${mine.slug}/enquiries?trash=1`, null, cookie)).json();
    assert.equal(trash.length, 1);
    assert.equal((await call('DELETE', `/api/b/${other.slug}/trash/${e.id}`, null, cookie)).status, 401);
  } finally {
    server.close();
  }
});

test('"Start fresh" ignores emails already in the mailbox; re-import brings them back', async () => {
  const inbox = require('../src/inbox');
  const raw = (subject, date) => Buffer.from(`From: Old Customer <old@example.com>\r\nTo: hello@biz.test\r\nSubject: ${subject}\r\nDate: ${date.toUTCString()}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@x>\r\n\r\nHello\r\n`);
  const before = new Date(Date.now() - 2 * 3600000);
  const after = new Date(Date.now() + 60000);
  const fakeImap = () => ({
    mailbox: { uidValidity: 7, uidNext: 3 },
    getMailboxLock: async () => ({ release() {} }),
    search: async () => [1, 2],
    async* fetch() {
      yield { uid: 1, internalDate: before, source: raw('Old enquiry', before) };
      yield { uid: 2, internalDate: after, source: raw('New enquiry', after) };
    },
  });

  // Fresh start an hour ago: only the email that arrived afterwards is imported.
  const fresh = { startFrom: new Date(Date.now() - 3600000).toISOString() };
  const seen = [];
  await inbox._syncFolder(fakeImap(), 'INBOX', fresh, 'inbox', async (m) => { seen.push(m.subject); });
  assert.deepEqual(seen, ['New enquiry']);
  assert.equal(fresh.inbox.lastUid, 2, 'skipped emails are marked as dealt with');

  // Re-import (no start point): both come back.
  const reimport = {};
  const all = [];
  await inbox._syncFolder(fakeImap(), 'INBOX', reimport, 'inbox', async (m) => { all.push(m.subject); });
  assert.deepEqual(all, ['Old enquiry', 'New enquiry']);
});

test('admin "Clear all enquiries" can start fresh and optionally remove contacts', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body, cookie) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const admin = (await call('POST', '/api/login', { password: 'admin-pass' })).headers.get('set-cookie').split(';')[0];
    const b = makeBusiness({});
    enq.ingest(b, { fromEmail: 'x@y.com', subject: 'Hi', body: 'Hello' }, { silent: true });
    contacts.create(b.id, { name: 'Keep Me', email: 'keep@me.com' });
    db.prepare('UPDATE businesses SET sync_state = ? WHERE id = ?').run(JSON.stringify({ inbox: { uidValidity: '1', lastUid: 50 } }), b.id);

    const r = await (await call('POST', `/api/admin/businesses/${b.id}/clear`, { fresh: true }, admin)).json();
    assert.equal(r.deleted, 1);
    assert.equal(r.contactsDeleted, 0);
    const state = enq.getBusiness('id', b.id).sync_state;
    assert.ok(state.startFrom, 'remembers when the fresh start happened');
    assert.equal(state.inbox, undefined);
    assert.equal(contacts.list(b.id).length, 1, 'contacts kept unless asked');

    const r2 = await (await call('POST', `/api/admin/businesses/${b.id}/clear`, { fresh: false, contacts: true }, admin)).json();
    assert.equal(r2.contactsDeleted, 1);
    assert.deepEqual(enq.getBusiness('id', b.id).sync_state, {});
  } finally {
    server.close();
  }
});
