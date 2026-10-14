const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'enq-auto-'));
process.env.DISABLE_SCHEDULER = '1';

const { db } = require('../src/db');
const sec = require('../src/security');
const enq = require('../src/enquiries');
const ai = require('../src/ai');
const mailer = require('../src/mailer');
const automations = require('../src/automations');
const { parseAutoconfigXml } = require('../src/autoconfig');
const { extract, isPrivateIp } = require('../src/knowledge');

automations.start();

// Capture outgoing mail instead of sending it.
const sent = [];
mailer._setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); return {}; }, close() {} }));

function makeBusiness(slug, settings) {
  const base = {
    inbox: { email: 'enquiries@acme.test', user: 'enquiries@acme.test', password: sec.encrypt('pw'), smtpHost: 'smtp.acme.test', smtpPort: 465 },
    info: { phone: '01234 567890', signature: 'Sam at Acme' },
    ...settings,
  };
  db.prepare('INSERT INTO businesses (slug, name, inbound_token, settings) VALUES (?, ?, ?, ?)').run(slug, `Acme ${slug}`, sec.randomToken(), JSON.stringify(base));
  return enq.getBusiness('slug', slug);
}

async function inbound(b, msg) {
  const r = enq.ingest(b, { fromEmail: 'kim@example.com', fromName: 'Kim Lee', subject: 'Business cards', messageId: `<${Math.random()}@x>`, ...msg });
  await automations.idle();
  return r;
}

const outbox = (enquiryId) => db.prepare('SELECT * FROM outbox WHERE enquiry_id = ? ORDER BY id').all(enquiryId);

test('auto-reply asks for a phone number when none was given, then schedules a follow-up', async () => {
  const b = makeBusiness('auto', {
    automations: {
      reply: { mode: 'auto', writer: 'template', delayMinutes: 0, askPhone: true },
      followUp: { mode: 'auto', writer: 'template', days: [3] },
    },
  });
  sent.length = 0;
  const r = await inbound(b, { body: 'How much are 500 business cards?' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Hi Kim/);
  assert.match(sent[0].text, /01234 567890/, 'asks them to call or send their number');
  assert.equal(sent[0].subject, 'Re: Business cards');

  const items = outbox(r.id);
  const fu = items.find((o) => o.kind === 'followup');
  assert.ok(fu, 'follow-up scheduled');
  assert.equal(fu.status, 'scheduled');
  const days = (Date.parse(fu.due_at) - Date.now()) / 86400000;
  assert.ok(days > 2 && days < 4, `follow-up due in ~3 days, got ${days}`);

  // Pretend 3 days pass: the follow-up goes out.
  db.prepare("UPDATE outbox SET due_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(fu.id);
  await automations.processDue();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /checking you got our last email/);
  assert.equal(enq.getEnquiry(b, r.id).messages.filter((m) => m.direction === 'out' && m.auto).length, 2);
});

test('no auto-reply when they left a phone and the rule is "only without a phone"', async () => {
  const b = makeBusiness('nophone', { automations: { reply: { mode: 'auto', who: 'no-phone', writer: 'template', delayMinutes: 0 } } });
  sent.length = 0;
  const r = await inbound(b, { body: 'Please call me on 07700 900123 about 500 business cards.' });
  assert.equal(sent.length, 0);
  assert.equal(outbox(r.id).length, 0);
});

test('draft mode waits for approval; a customer reply cancels follow-ups', async () => {
  const b = makeBusiness('draft', {
    automations: { reply: { mode: 'draft', writer: 'template' }, followUp: { mode: 'auto', writer: 'template', days: [2, 5] } },
  });
  sent.length = 0;
  const r = await inbound(b, { body: 'Do you print flyers?' });
  assert.equal(sent.length, 0);
  const [draft] = automations.queue(b);
  assert.equal(draft.enquiryId, r.id);

  await automations.sendDraft(b, draft.id, { body: `${draft.body}\n\nP.S. Flyers start at £30.` });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Flyers start at £30/);
  assert.equal(automations.queue(b).length, 0);
  assert.equal(outbox(r.id).filter((o) => o.kind === 'followup' && o.status === 'scheduled').length, 1);

  await inbound(b, { body: 'Great, thanks! Can I order 1000?', subject: 'Re: Do you print flyers?' });
  assert.equal(outbox(r.id).filter((o) => o.kind === 'followup' && o.status === 'scheduled').length, 0, 'follow-up cancelled');
});

test('AI reads the enquiry, filters junk and writes drafts', async () => {
  const calls = [];
  ai._setTestClient({
    messages: {
      create: async (params) => {
        calls.push(params);
        const props = params.output_config.format.schema.properties;
        const out = props.is_enquiry
          ? (/seo/i.test(params.messages[0].content)
            ? { is_enquiry: false, summary: 'SEO pitch', wants: '', deadline: '', budget: '', phone: '', customer_name: '', questions: [], temperature: 'cold', temperature_reason: 'Spam' }
            : { is_enquiry: true, summary: 'Wants 500 business cards by Friday', wants: '500 business cards', deadline: 'Friday', budget: '', phone: '', customer_name: 'Kim', questions: ['Price?'], temperature: 'hot', temperature_reason: 'Specific order with a deadline' })
          : { subject: 'Re: Business cards', body: 'Hi Kim, 500 business cards are £45.' };
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] };
      },
    },
  });
  try {
    const b = makeBusiness('ai', {
      knowledge: { profile: 'We print things.', prices: [{ item: 'Business cards x500', price: '£45', notes: '' }] },
      automations: { reply: { mode: 'draft', writer: 'ai' } },
    });
    const r = await inbound(b, { body: 'Need 500 business cards by Friday, how much?' });
    const e = enq.getEnquiry(b, r.id);
    assert.equal(e.aiSummary, 'Wants 500 business cards by Friday');
    assert.equal(e.temperature, 'hot');
    assert.equal(e.tempSource, 'ai');
    assert.equal(e.outbox[0].body, 'Hi Kim, 500 business cards are £45.');
    assert.equal(e.outbox[0].writtenBy, 'ai');
    const draftCall = calls.find((c) => c.output_config.format.schema.properties.body);
    assert.match(draftCall.system[0].text, /Business cards x500: £45/, 'price list is given to the AI');

    const junk = await inbound(b, { fromEmail: 'sales@seo.biz', body: 'We offer great seo for you' });
    assert.equal(enq.getEnquiry(b, junk.id).status, 'spam');
    assert.equal(outbox(junk.id).length, 0, 'no reply to junk');
  } finally {
    ai._setTestClient(null);
  }
});

test('follow-ups land at the configured local time', () => {
  const due = automations.atLocalTime('2026-06-01T15:00:00Z', 3, '09:30', 'Europe/London');
  assert.equal(due, '2026-06-04T08:30:00.000Z'); // 09:30 BST
  const winter = automations.atLocalTime('2026-12-01T15:00:00Z', 3, '09:30', 'Europe/London');
  assert.equal(winter, '2026-12-04T09:30:00.000Z');
});

test('reads Thunderbird-style autoconfig files', () => {
  const xml = `<clientConfig version="1.1"><emailProvider id="example.com"><displayName>Example Mail</displayName>
    <incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></outgoingServer>
  </emailProvider></clientConfig>`;
  const cfg = parseAutoconfigXml(xml, 'jo@example.com');
  assert.deepEqual(cfg.imap, { host: 'imap.example.com', port: 993, secure: true, user: 'jo@example.com' });
  assert.deepEqual(cfg.smtp, { host: 'smtp.example.com', port: 587, secure: false, user: 'jo' });
  assert.equal(cfg.name, 'Example Mail');
});

test('extracts readable text and links from a web page', () => {
  const html = `<html><head><title>Prices | PrintCo</title><script>var x=1</script></head><body>
    <nav><a href="/about">About</a></nav><h1>Our prices</h1><table><tr><td>500 business cards</td><td>£45</td></tr></table>
    <p>Free delivery over £50.</p></body></html>`;
  const page = extract(html, 'https://printco.test/prices');
  assert.equal(page.title, 'Prices | PrintCo');
  assert.match(page.text, /## Our prices/);
  assert.match(page.text, /500 business cards/);
  assert.match(page.text, /£45/);
  assert.doesNotMatch(page.text, /var x/);
  assert.ok(page.links.includes('https://printco.test/about'));
});

test('website reader refuses private addresses', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('192.168.1.10'), true);
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});
