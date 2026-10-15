// Realistic sample enquiries so a new business dashboard can be shown off
// before its real inbox is connected.
const { db, tx } = require('./db');
const { ingest, recordResponse } = require('./enquiries');
const { fill: fillTemplate } = require('./automations');

const PEOPLE = [
  ['Sarah Mitchell', 'sarah.mitchell@gmail.com'], ['James Patel', 'james@pateldental.co.uk'],
  ['Emma Thompson', 'emma.t@outlook.com'], ['Oliver Grant', 'oliver.grant@grantlogistics.com'],
  ['Chloe Davies', 'chloedavies88@yahoo.co.uk'], ['Mohammed Khan', 'm.khan@khanproperties.co.uk'],
  ['Lucy Evans', 'lucy.evans@icloud.com'], ['Daniel Wright', 'dan@wrightarchitects.co.uk'],
  ['Hannah Clarke', 'hannahclarke@hotmail.com'], ['Tom Robinson', 'tom.robinson@gmail.com'],
  ['Priya Shah', 'priya@shahandco.com'], ['George Hughes', 'g.hughes@btinternet.com'],
  ['Amelia Scott', 'amelia.scott@scottevents.co.uk'], ['Ryan O\'Connor', 'ryan.oc@gmail.com'],
  ['Grace Turner', 'grace.turner@outlook.com'], ['Ben Walker', 'ben@walkerbuild.co.uk'],
  ['Isla Morgan', 'isla.morgan@gmail.com'], ['Jack Lewis', 'jack.lewis@lewisgroup.com'],
  ['Sophie Hall', 'sophiehall@yahoo.com'], ['Harry Young', 'harry@youngandpartners.co.uk'],
  ['Megan King', 'megan.king@gmail.com'], ['Liam Baker', 'liam.baker@bakerhomes.co.uk'],
  ['Zara Ahmed', 'zara.ahmed@outlook.com'], ['Charlie Green', 'charlie.green@gmail.com'],
  ['Freya Adams', 'freya@adamsstudio.com'], ['Noah Hill', 'noah.hill@hotmail.co.uk'],
];

const HOT = [
  ['Quote needed ASAP', 'Hi there,\n\nWe need a quote as soon as possible please. Our budget is around £{budget} and we would like to get started next week if you have availability. I am ready to go ahead once I have a price.\n\nYou can call me on 07700 900{n} any time.\n\nThanks,\n{first}', 'Wants a quote ASAP, budget about £{budget}, hoping to start next week'],
  ['Booking for {date}', 'Hello,\n\nI would like to book you for {date}. Can you confirm availability and the cost? Happy to pay a deposit today to secure the date. Budget is £{budget}.\n\nBest number is 07700 900{n}.\n\n{first}', 'Wants to book for {date} and pay a deposit today'],
  ['Urgent – can you help this week?', 'Hi,\n\nThis is urgent – our previous supplier let us down and we need someone this week. Could you send pricing over today? We have a budget of £{budget} approved and can proceed immediately.\n\nRegards,\n{first}\n{company}\nTel: 020 7946 0{n}', 'Urgently needs help this week after a supplier let them down'],
  ['Ready to proceed', 'Hi,\n\nThanks for the info on your website. We have compared a few options and would like to proceed with you. Could you send an invoice for the deposit so we can lock in a start date? Ideally {date}.\n\nCheers,\n{first}', 'Ready to go ahead — asking for a deposit invoice'],
];

const WARM = [
  ['Enquiry about your services', 'Hi,\n\nI came across your website and wondered what your pricing looks like for a project like ours. We are thinking of starting in the next couple of months. Could you send some details?\n\nThanks,\n{first}', 'Asking about pricing for a project in the next few months'],
  ['Question about availability', 'Hello,\n\nDo you have any availability in the spring? We are planning ahead and would like a rough estimate if possible.\n\nKind regards,\n{first}', 'Asking about spring availability and a rough estimate'],
  ['Price list?', 'Hi, could you send over a price list and let me know how much a typical job costs? Thanks, {first}', 'Wants a price list and typical job cost'],
  ['Recommendation from a friend', 'Hi,\n\nA friend recommended you. We are looking for someone for a project at our office and would love to understand your process and costs. Is there a good time for a quick call?\n\n{first}\n{company}', 'Referred by a friend — wants to discuss an office project'],
];

const COLD = [
  ['Just a question', 'Hi, just curious whether you cover our area? Not sure yet if we need anything, just browsing. {first}', 'Asking if you cover their area — just browsing'],
  ['Info', 'Hello, could you send a brochure? Maybe next year. Thanks', 'Wants a brochure, maybe next year'],
  ['General enquiry', 'Hi, I am researching options for a possible project in the future, no rush at all. What kind of things do you do? {first}', 'Early research for a possible future project'],
  ['Hello', 'Do you do weekends?', 'Asking whether you work weekends'],
];

const SPAM = [
  ['Grow your traffic 300%', 'Hi, we offer SEO services and link building to get you on the first page of Google. Reply for a free audit.', 'outreach@rankfast-seo.biz', 'Mark from RankFast'],
  ['Guest post opportunity', 'Hello, I would love to write a guest post for your blog with backlinks to our partners.', 'editor@contentpartners.net', 'Content Team'],
];

function rand(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function fill(tpl, ctx) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? '');
}

function loadDemo(business, { clear = true } = {}) {
  const r = rand(business.id * 7919 + 17);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  if (clear) db.prepare('DELETE FROM enquiries WHERE business_id = ?').run(business.id);

  const now = Date.now();
  const H = 3600000;
  const created = [];
  let n = 100;

  tx(() => {
    PEOPLE.forEach(([name, email], i) => {
      const roll = r();
      const hotCut = i < 8 ? 0.45 : 0.3; // keep the most recent few lively for demos
      const kind = roll < hotCut ? 'hot' : roll < hotCut + 0.35 ? 'warm' : 'cold';
      const [subject, body, summary] = pick(kind === 'hot' ? HOT : kind === 'warm' ? WARM : COLD);
      // Spread over the last ~60 days, with more recent ones weighted heavier.
      const ageH = i < 8 ? r() * 40 : Math.pow(r(), 1.2) * 60 * 24;
      const at = new Date(now - ageH * H);
      const target = new Date(at.getTime() + 14 * 86400000);
      const ctx = {
        first: name.split(' ')[0], budget: (Math.round((1 + r() * 14)) * 500).toLocaleString('en-GB'),
        n: String(n += 7).padStart(3, '0'), company: email.split('@')[1].split('.')[0].replace(/^\w/, (c) => c.toUpperCase()),
        date: target.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
      };
      const res = ingest(business, {
        fromEmail: email, fromName: name, subject: fill(subject, ctx), body: fill(body, ctx),
        messageId: `<demo-${business.id}-${i}@example.com>`, date: at, source: 'email',
      }, { silent: true });
      if (res.action !== 'created') return;
      db.prepare('UPDATE enquiries SET ai_summary = ? WHERE id = ?').run(fill(summary, ctx), res.id);
      created.push({ id: res.id, at, kind, ageH, email, ctx, name });
    });

    // A couple of follow-ups from keen customers.
    created.filter((c) => c.kind !== 'cold' && c.ageH > 30).slice(0, 2).forEach((c, j) => {
      ingest(business, {
        fromEmail: c.email, subject: 'Re: following up',
        body: `Hi, just following up on my email – are you able to send that quote? Keen to get this booked in. ${c.ctx.first}`,
        messageId: `<demo-${business.id}-fu-${j}@example.com>`, date: new Date(c.at.getTime() + 26 * H),
      }, { silent: true });
    });

    SPAM.forEach(([subject, body, email, name], i) => {
      ingest(business, { fromEmail: email, fromName: name, subject, body, messageId: `<demo-${business.id}-spam-${i}@example.com>`, date: new Date(now - (3 + i * 9) * 86400000) }, { silent: true });
    });

    // Responses and outcomes: older enquiries have mostly been handled.
    created.forEach((c) => {
      if (c.ageH < 5) return; // brand new — still waiting
      const answered = c.ageH > 48 ? r() < 0.92 : r() < 0.55;
      if (!answered) return;
      const delayH = c.kind === 'hot' ? 0.3 + r() * 3 : 1 + r() * 20;
      recordResponse(business, {
        enquiryId: c.id, date: new Date(c.at.getTime() + delayH * H),
        body: `Hi ${c.ctx.first},\n\nThanks for getting in touch! Happy to help – I've attached some details and will follow up with a quote shortly.\n\nBest wishes`,
      }, { silent: true });
      if (c.ageH > 96) {
        const o = r();
        const status = c.kind === 'hot' ? (o < 0.55 ? 'won' : o < 0.8 ? 'quoted' : 'lost')
          : c.kind === 'warm' ? (o < 0.25 ? 'won' : o < 0.6 ? 'quoted' : o < 0.8 ? 'lost' : 'contacted')
            : (o < 0.5 ? 'lost' : 'contacted');
        const value = ['won', 'quoted'].includes(status) ? Math.round((800 + r() * 7000) / 50) * 50 : null;
        db.prepare('UPDATE enquiries SET status = ?, value = ? WHERE id = ?').run(status, value, c.id);
      }
    });

    // Show what the autopilot has sent, and a couple of returning customers.
    const answered = created.filter((c) => db.prepare("SELECT 1 FROM messages WHERE enquiry_id = ? AND direction = 'out'").get(c.id)).slice(0, 4);
    answered.forEach((c, i) => {
      const m = db.prepare("SELECT id, subject, body, sent_at FROM messages WHERE enquiry_id = ? AND direction = 'out' ORDER BY sent_at LIMIT 1").get(c.id);
      db.prepare('UPDATE messages SET auto = 1 WHERE id = ?').run(m.id);
      const kind = i === 1 ? 'followup' : 'reply';
      db.prepare(`INSERT INTO outbox (business_id, enquiry_id, kind, step, status, auto, subject, body, written_by, sent_at, sequence)
        VALUES (?, ?, ?, ?, 'sent', 1, ?, ?, 'template', ?, ?)`)
        .run(business.id, c.id, kind, kind === 'followup' ? 1 : 0, m.subject || 'Re: your enquiry', m.body, m.sent_at, i === 1 ? 'phone' : 'quiet');
    });
    created.filter((c) => c.ageH > 24).slice(0, 2).forEach((c) => {
      if (db.prepare('SELECT 1 FROM contacts WHERE business_id = ? AND email = ?').get(business.id, c.email)) return;
      db.prepare('INSERT INTO contacts (business_id, name, company, email, notes) VALUES (?, ?, ?, ?, ?)')
        .run(business.id, c.name, c.ctx.company, c.email, 'Sample contact');
    });

    // A few replies waiting for approval, as the autopilot would prepare them.
    const a = business.settings.automations.reply;
    const info = business.settings.info;
    created.filter((c) => c.ageH < 30 && c.kind !== 'cold'
      && !db.prepare("SELECT 1 FROM messages WHERE enquiry_id = ? AND direction = 'out'").get(c.id)).slice(0, 3).forEach((c) => {
      const e = db.prepare('SELECT subject, phone FROM enquiries WHERE id = ?').get(c.id);
      const vars = { first_name: c.ctx.first, business_name: business.name, business_phone: info.phone || 'us', signature: info.signature || `The ${business.name} team` };
      vars.phone_ask = e.phone ? '' : fillTemplate(a.phoneAsk, vars);
      db.prepare(`INSERT INTO outbox (business_id, enquiry_id, kind, status, auto, subject, body, written_by) VALUES (?, ?, 'reply', 'draft', 0, ?, ?, 'template')`)
        .run(business.id, c.id, `Re: ${e.subject}`, fillTemplate(a.template, vars));
    });
  });
  return created.length;
}

module.exports = { loadDemo };
