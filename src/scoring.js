// Lead scoring: turns an enquiry into a 0–100 score plus human-readable reasons.
// Rules are configured per business (see settings.js) so each client can tune
// what "hot" means for them.

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk',
  'outlook.com', 'live.com', 'live.co.uk', 'icloud.com', 'me.com', 'aol.com', 'msn.com',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'protonmail.com', 'proton.me', 'gmx.com',
]);

// Something that looks like a phone number; checked further in extractPhone().
const PHONE_CANDIDATE_RE = /(?:\+|\b00)?\(?\d[\d\s().-]{7,}\d/g;
const PHONE_LABEL_RE = /(?:tel|telephone|phone|mobile|mob|cell|call|ring|whatsapp|number|contact)\b[^\n\d+]{0,20}$/i;
const MONEY_RE = /(?:[£$€]\s?(\d[\d,]*(?:\.\d+)?)\s?(k|K)?)|(?:(\d[\d,]*(?:\.\d+)?)\s?(k|K)?\s?(?:pounds|gbp|usd|dollars|euros?|eur)\b)|(?:budget[^.\n]{0,25}?(\d[\d,]*(?:\.\d+)?)\s?(k|K)?)/gi;
const DATE_RE = /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\bnext (?:week|month)\b/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findTerms(text, terms) {
  const hits = [];
  for (const term of terms || []) {
    const t = String(term).trim().toLowerCase();
    if (!t) continue;
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(t)}(?:$|[^a-z0-9])`, 'i');
    if (re.test(text)) hits.push(t);
  }
  return hits;
}

function parseBudget(text) {
  let best = null;
  for (const m of text.matchAll(MONEY_RE)) {
    const raw = m[1] || m[3] || m[5];
    const k = m[2] || m[4] || m[6];
    if (!raw) continue;
    let n = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (k) n *= 1000;
    if (n < 10) continue; // "£5" in a sentence is rarely a project budget
    if (best == null || n > best) best = n;
  }
  return best;
}

// Find a phone number, while ignoring dates, order numbers and similar digit runs.
function extractPhone(text) {
  for (const m of String(text || '').matchAll(PHONE_CANDIDATE_RE)) {
    const raw = m[0].trim();
    if (/\d{4}-\d{1,2}-\d{1,2}/.test(raw) || /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(raw)) continue; // dates
    const digits = raw.replace(/\D/g, '');
    const international = raw.startsWith('+') || raw.startsWith('00');
    const labelled = PHONE_LABEL_RE.test(text.slice(Math.max(0, m.index - 30), m.index));
    if (international && digits.length >= 10 && digits.length <= 15) return raw;
    if (/^0\d{9,10}$/.test(digits)) return raw; // UK-style: 01…, 02…, 03…, 07…
    if (labelled && digits.length >= 9 && digits.length <= 15) return raw;
  }
  return null;
}

// "Always hot" words: count distinct matches, ignoring a word inside a longer matched phrase.
function hotMatches(text, terms) {
  const hits = findTerms(text, terms);
  return hits.filter((h) => !hits.some((o) => o !== h && o.includes(h)));
}

/**
 * Score an enquiry.
 * @param {object} input  { subject, body, fromEmail, inboundCount }
 * @param {object} rules  settings.scoring
 * @returns {{score:number, spam:boolean, signals:{label:string, points:number}[], budget:number|null, phone:string|null}}
 */
function scoreEnquiry(input, rules) {
  const subject = input.subject || '';
  const body = input.body || '';
  const text = `${subject}\n${body}`.toLowerCase();
  const signals = [];
  const add = (label, points) => signals.push({ label, points });

  const spamHits = findTerms(text, rules.spamTerms);
  if (spamHits.length) {
    return { score: 0, spam: true, forceHot: false, signals: [{ label: `Looks like spam ("${spamHits[0]}")`, points: 0 }], budget: null, phone: null };
  }

  add('Starting score', 20); // every genuine enquiry starts with a little warmth

  const intent = findTerms(text, rules.intentTerms);
  if (intent.length) add(`Buying intent: ${intent.slice(0, 3).join(', ')}`, Math.min(30, 12 + (intent.length - 1) * 6));

  const urgency = findTerms(text, rules.urgencyTerms);
  if (urgency.length) add(`Urgent: ${urgency.slice(0, 2).join(', ')}`, 18);

  const services = findTerms(text, rules.serviceTerms);
  if (services.length) add(`Mentions your services: ${services.slice(0, 3).join(', ')}`, Math.min(15, 8 + (services.length - 1) * 3));

  const budget = parseBudget(`${subject}\n${body}`);
  if (budget != null) {
    const cur = rules.currency || '';
    if (rules.minBudget > 0 && budget < rules.minBudget) {
      add(`Budget ${cur}${budget.toLocaleString('en-GB')} is below your minimum`, -10);
    } else {
      add(`Budget mentioned: ${cur}${budget.toLocaleString('en-GB')}`, 15);
    }
  }

  const phone = extractPhone(body);
  if (phone) add('Left a phone number', 10);

  if (DATE_RE.test(text)) add('Mentions a specific date or timeframe', 8);

  const words = body.split(/\s+/).filter(Boolean).length;
  if (words >= 80) add('Detailed message', 6);
  else if (words < 12) add('Very short message', -8);

  const domain = String(input.fromEmail || '').split('@')[1]?.toLowerCase();
  if (domain && !FREE_MAIL.has(domain)) add(`Business email (${domain})`, 5);

  const followUps = Math.max(0, (input.inboundCount || 1) - 1);
  if (followUps) add(followUps === 1 ? 'Sent a follow-up' : `Sent ${followUps} follow-ups`, Math.min(20, followUps * 10));

  const low = findTerms(text, rules.lowIntentTerms);
  if (low.length) add(`Early stage: ${low.slice(0, 2).join(', ')}`, -15);

  const hot = hotMatches(text, rules.hotTerms);
  const forceHot = hot.length > 0 && hot.length >= Math.max(1, Number(rules.hotMinMatches) || 2);
  if (forceHot) add(`Always-hot words: ${hot.slice(0, 4).join(', ')}`, 0);

  const total = signals.reduce((n, s) => n + s.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(total)));
  return { score, spam: false, forceHot, signals, budget, phone };
}

/** Leads cool off as they age without new contact from the customer. */
function ageAdjustment(lastInboundAt, now = Date.now()) {
  const days = (now - new Date(lastInboundAt).getTime()) / 86400000;
  if (days > 30) return { points: -30, label: 'No contact for over 30 days' };
  if (days > 14) return { points: -20, label: 'No contact for over 2 weeks' };
  if (days > 7) return { points: -10, label: 'No contact for over a week' };
  return null;
}

function temperatureFor(score, rules) {
  if (score >= rules.hotThreshold) return 'hot';
  if (score >= rules.warmThreshold) return 'warm';
  return 'cold';
}

module.exports = { scoreEnquiry, ageAdjustment, temperatureFor, parseBudget, extractPhone, findTerms, hotMatches };
