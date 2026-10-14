// Default per-business configuration. Every business gets a deep copy of this,
// and anything saved from the admin screen is merged on top.
const DEFAULT_SETTINGS = {
  contactEmail: '',
  replySignature: '',
  responseTargetHours: 4,
  scoring: {
    hotThreshold: 60,
    warmThreshold: 30,
    // Words that suggest the sender wants to buy / book now.
    intentTerms: [
      'quote', 'quotation', 'price', 'pricing', 'cost', 'how much', 'book', 'booking',
      'availability', 'available', 'hire', 'order', 'purchase', 'buy', 'ready to',
      'deposit', 'invoice', 'proceed', 'go ahead', 'sign up', 'estimate',
    ],
    urgencyTerms: [
      'asap', 'urgent', 'urgently', 'today', 'tomorrow', 'this week', 'immediately',
      'as soon as possible', 'right away', 'emergency', 'deadline', 'by friday', 'by monday',
    ],
    // Words that suggest early research or low commitment.
    lowIntentTerms: [
      'just browsing', 'just curious', 'just wondering', 'maybe', 'at some point',
      'in the future', 'next year', 'not sure', 'no rush', 'brochure', 'general information',
      'student project', 'researching',
    ],
    // Products or services this business sells — mentions show a relevant enquiry.
    serviceTerms: [],
    // Anything matching these is treated as spam / not a real enquiry.
    spamTerms: [
      'seo services', 'guest post', 'backlinks', 'link building', 'crypto', 'bitcoin',
      'loan offer', 'web design services', 'rank your website', 'first page of google',
      'lead generation services', 'unsubscribe',
    ],
    // Senders to skip entirely (substring match on the email address).
    ignoreSenders: [
      'no-reply', 'noreply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster',
      'notifications@', 'newsletter',
    ],
    minBudget: 0,
    currency: '£',
  },
  inbox: {
    enabled: false,
    host: '',
    port: 993,
    secure: true,
    user: '',
    password: '', // stored encrypted — see crypto.js
    folder: 'INBOX',
    sentFolder: '',
    pollMinutes: 5,
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  const out = structuredClone(base);
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue; // ignore unknown keys
    if (isObj(base[k])) out[k] = merge(base[k], v);
    else if (Array.isArray(base[k])) {
      out[k] = Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : base[k];
    } else if (typeof base[k] === 'number') {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : base[k];
    } else if (typeof base[k] === 'boolean') out[k] = Boolean(v);
    else out[k] = v == null ? '' : String(v);
  }
  return out;
}

function loadSettings(json) {
  let parsed = {};
  try { parsed = JSON.parse(json || '{}'); } catch { /* fall back to defaults */ }
  return merge(DEFAULT_SETTINGS, parsed);
}

module.exports = { DEFAULT_SETTINGS, merge, loadSettings };
