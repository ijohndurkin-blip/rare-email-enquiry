const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'enq-test-'));
process.env.ADMIN_PASSWORD = 'admin-pass';

const { scoreEnquiry, temperatureFor, parseBudget } = require('../src/scoring');
const { DEFAULT_SETTINGS } = require('../src/settings');
const app = require('../src/server');
const mailer = require('../src/mailer');
const automations = require('../src/automations');
const { db } = require('../src/db');

const sent = [];
mailer._setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); return {}; }, close() {} }));

const rules = DEFAULT_SETTINGS.scoring;

test('urgent quote with budget and phone scores hot', () => {
  const r = scoreEnquiry({
    subject: 'Quote needed ASAP',
    body: 'Hi, we need a quote as soon as possible. Budget is £5,000 and we can start next week. Call 07700 900123.',
    fromEmail: 'jane@acme.co.uk',
  }, rules);
  assert.equal(temperatureFor(r.score, rules), 'hot');
  assert.equal(r.budget, 5000);
  assert.ok(r.phone);
});

test('vague browsing enquiry scores cold', () => {
  const r = scoreEnquiry({ subject: 'Hello', body: 'Just browsing, maybe next year.', fromEmail: 'x@gmail.com' }, rules);
  assert.equal(temperatureFor(r.score, rules), 'cold');
});

test('spam is detected', () => {
  const r = scoreEnquiry({ subject: 'Rank higher', body: 'We offer SEO services and backlinks', fromEmail: 'a@b.biz' }, rules);
  assert.equal(r.spam, true);
  assert.equal(r.score, 0);
});

test('budget parsing handles k and words', () => {
  assert.equal(parseBudget('around £12k'), 12000);
  assert.equal(parseBudget('budget of 3,500 pounds'), 3500);
  assert.equal(parseBudget('no money mentioned'), null);
});

test('end to end: admin creates business, webhook ingests, client sees it', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (method, url, body, cookie) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  try {
    // Wrong admin password is rejected.
    assert.equal((await json('POST', '/api/login', { password: 'nope' })).status, 401);

    const login = await json('POST', '/api/login', { password: 'admin-pass' });
    const admin = login.headers.get('set-cookie').split(';')[0];

    const created = await (await json('POST', '/api/admin/businesses', { name: 'Test Plumbing' }, admin)).json();
    assert.equal(created.slug, 'test-plumbing');
    assert.ok(created.accessCode);

    // Not logged in as the business -> 401.
    assert.equal((await json('GET', '/api/b/test-plumbing/summary')).status, 401);

    const hook = `/api/inbound/${created.inboundToken}`;
    const first = await (await json('POST', hook, {
      from: 'Jane Doe <jane@example.com>', subject: 'Urgent leak', text: 'Need a plumber today, urgent! Can you give me a price? 07700 900555', messageId: '<m1@x>',
    })).json();
    assert.equal(first.action, 'created');

    // Same message again is de-duplicated; a follow-up joins the same thread.
    assert.equal((await (await json('POST', hook, { from: 'jane@example.com', subject: 'Urgent leak', text: 'dupe', messageId: '<m1@x>' })).json()).action, 'skipped');
    const follow = await (await json('POST', hook, { from: 'jane@example.com', subject: 'Re: Urgent leak', text: 'Following up!', messageId: '<m2@x>' })).json();
    assert.equal(follow.action, 'appended');
    assert.equal(follow.id, first.id);

    // Ignored senders are skipped.
    assert.equal((await (await json('POST', hook, { from: 'noreply@shop.com', subject: 'Receipt', text: 'x' })).json()).action, 'skipped');

    const biz = await json('POST', '/api/login', { slug: 'test-plumbing', password: created.accessCode });
    const client = biz.headers.get('set-cookie').split(';')[0];
    const list = await (await json('GET', '/api/b/test-plumbing/enquiries', null, client)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].temperature, 'hot');
    assert.equal(list[0].awaitingReply, true);

    // A business login cannot reach admin endpoints or other businesses.
    assert.equal((await json('GET', '/api/admin/businesses', null, client)).status, 401);

    const replied = await (await json('PATCH', `/api/b/test-plumbing/enquiries/${first.id}`, { markReplied: true, status: 'quoted' }, client)).json();
    assert.equal(replied.awaitingReply, false);
    assert.equal(replied.status, 'quoted');

    const summary = await (await json('GET', '/api/b/test-plumbing/summary?days=7', null, client)).json();
    assert.equal(summary.byTemp.hot, 1);
    assert.equal(summary.totals.enquiries, 1);
    assert.equal(summary.series.length, 7);
  } finally {
    server.close();
  }
});

test('approval flow: webhook enquiry → draft → edit & send from the dashboard', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (method, url, body, cookie) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const admin = (await json('POST', '/api/login', { password: 'admin-pass' })).headers.get('set-cookie').split(';')[0];
    const created = await (await json('POST', '/api/admin/businesses', { name: 'Print Shop' }, admin)).json();
    // Give it a sending mailbox and a template autopilot in draft mode.
    const put = await json('PUT', `/api/admin/businesses/${created.id}`, {
      settings: {
        inbox: { email: 'hello@print.test', user: 'hello@print.test', password: 'pw', smtpHost: 'smtp.print.test', smtpPort: 465 },
        info: { phone: '0113 000 0000' },
        knowledge: { prices: [{ item: 'Business cards x500', price: '£45', notes: '' }] },
        automations: { reply: { mode: 'draft', writer: 'template' } },
      },
    }, admin);
    const saved = await put.json();
    assert.equal(saved.settings.inbox.password, '********', 'password never sent back');
    assert.equal(saved.settings.knowledge.prices[0].price, '£45');
    assert.ok(db.prepare('SELECT settings FROM businesses WHERE id = ?').get(created.id).settings.includes('enc:'), 'stored encrypted');

    await json('POST', `/api/inbound/${created.inboundToken}`, { from: 'Ann <ann@example.com>', subject: 'Cards', text: 'How much for 500 business cards?', messageId: '<a1@x>' });
    await automations.idle();

    const client = (await json('POST', '/api/login', { slug: created.slug, password: created.accessCode })).headers.get('set-cookie').split(';')[0];
    const summary = await (await json('GET', `/api/b/${created.slug}/summary`, null, client)).json();
    assert.equal(summary.totals.drafts, 1);
    assert.equal(summary.canSend, true);

    const [draft] = await (await json('GET', `/api/b/${created.slug}/queue`, null, client)).json();
    assert.match(draft.body, /0113 000 0000/);

    sent.length = 0;
    const res = await json('POST', `/api/b/${created.slug}/outbox/${draft.id}/send`, { subject: draft.subject, body: 'Hi Ann, 500 cards are £45. Shall I go ahead?' }, client);
    assert.equal(res.status, 200);
    const e = await res.json();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].inReplyTo, '<a1@x>', 'threads with their email');
    assert.equal(sent[0].from.address, 'hello@print.test');
    assert.equal(e.awaitingReply, false);
    assert.equal(e.status, 'contacted');
    assert.equal(e.outbox.length, 0);
    assert.equal(e.messages.at(-1).body, 'Hi Ann, 500 cards are £45. Shall I go ahead?');

    // Another business can't touch this draft.
    assert.equal((await json('POST', `/api/b/test-plumbing/outbox/${draft.id}/send`, {}, client)).status, 401);
  } finally {
    server.close();
  }
});
