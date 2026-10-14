// Default per-business configuration. Every business gets a deep copy of this,
// and anything saved from the admin screen is merged on top.
const DEFAULT_SETTINGS = {
  contactEmail: '',
  responseTargetHours: 4,
  // Details used when writing replies.
  info: {
    phone: '',
    website: '',
    hours: '',
    signature: '',
    tone: 'friendly', // friendly | professional | casual
    timezone: 'Europe/London',
    extraInstructions: '',
  },
  // What the business does, learned from its website and edited by you.
  knowledge: {
    crawlMode: 'site', // home | site | pages
    pages: [],
    maxPages: 20,
    profile: '',
    faqs: '',
    prices: [], // [{ item, price, notes }]
    builtAt: '',
  },
  automations: {
    ai: { enabled: true }, // summaries, junk filtering and temperature by AI (when a key is set)
    reply: {
      mode: 'draft', // off | draft | auto
      who: 'all', // all | no-phone
      writer: 'ai', // ai | template
      askPhone: true,
      phoneAsk: "If you can reply with the best number to reach you on, or give us a call on {business_phone}, we can get this moving for you quickly.",
      template: "Hi {first_name},\n\nThanks for getting in touch with {business_name} — we've got your enquiry and will come back to you shortly.\n\n{phone_ask}\n\n{signature}",
      delayMinutes: 2,
    },
    followUp: {
      mode: 'off', // off | draft | auto
      days: [3, 7],
      writer: 'ai',
      sendAt: '09:30',
      templates: [
        "Hi {first_name},\n\nJust checking you got our last email about your enquiry. Is there anything else you need from us to get started?\n\n{phone_ask}\n\n{signature}",
        "Hi {first_name},\n\nI didn't want your enquiry to slip through the cracks. If you're still interested, just reply to this email and we'll pick it up from there.\n\n{signature}",
      ],
    },
    alerts: {
      enabled: false,
      email: '',
      onlyHot: true,
    },
  },
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
    email: '',
    provider: '',
    host: '', // IMAP (receiving)
    port: 993,
    secure: true,
    user: '',
    password: '', // stored encrypted — see security.js
    smtpHost: '', // SMTP (sending)
    smtpPort: 465,
    smtpSecure: true,
    folder: 'INBOX',
    sentFolder: '',
    saveToSent: false, // copy sent mail into the Sent folder (providers that don't do it themselves)
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
      if (!Array.isArray(v)) continue;
      out[k] = v.map((x) => {
        if (x && typeof x === 'object') return x;
        if (typeof x === 'number') return x;
        return String(x).trim();
      }).filter((x) => x !== '' && x !== null);
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
