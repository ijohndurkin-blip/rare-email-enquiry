// Claude-powered helpers: learn about a business from its website, read and
// summarise enquiries, and write reply drafts in the business's voice.
const Anthropic = require('@anthropic-ai/sdk');
const { getAppSetting } = require('./db');
const { decrypt } = require('./security');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best quality (recommended)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — fast, lower cost' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, lowest cost' },
];
// Models that accept the server-side refusal fallback.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

let testClient = null; // tests can inject a fake client

function apiKey() {
  const stored = getAppSetting('anthropic_key');
  return stored ? decrypt(stored) : (process.env.ANTHROPIC_API_KEY || '');
}

function model() {
  return getAppSetting('ai_model') || process.env.AI_MODEL || DEFAULT_MODEL;
}

function isConfigured() {
  return Boolean(testClient || apiKey());
}

function client(key) {
  if (testClient) return testClient;
  const k = key || apiKey();
  if (!k) throw new Error('No AI key set. Add one under Admin → AI settings.');
  return new Anthropic({ apiKey: k, timeout: 120000, maxRetries: 2 });
}

class AIError extends Error {}

function friendlyError(err) {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AIError('The AI key was rejected. Check it under Admin → AI settings.');
  if (err instanceof Anthropic.PermissionDeniedError) return new AIError('This AI key does not have access to the selected model.');
  if (err instanceof Anthropic.NotFoundError) return new AIError('The selected AI model was not found. Pick another under Admin → AI settings.');
  if (err instanceof Anthropic.RateLimitError) return new AIError('The AI service is busy (rate limited). Try again in a minute.');
  if (err instanceof Anthropic.BadRequestError) return new AIError(`The AI request was rejected: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new AIError('Could not reach the AI service. Check the server has internet access.');
  if (err instanceof Anthropic.APIError) return new AIError(`AI service error (${err.status}). Try again shortly.`);
  return err;
}

/**
 * One structured call: returns the parsed JSON object matching `schema`.
 * The stable part of the prompt (`system`) is cached so repeated calls for the
 * same business are cheaper.
 */
async function callJSON({ system, user, schema, effort = 'medium', maxTokens = 16000, key, modelId }) {
  const m = modelId || model();
  const params = {
    model: m,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
  let response;
  try {
    if (FALLBACK_MODELS.has(m) && !testClient) {
      response = await client(key).beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } else {
      response = await client(key).messages.create(params);
    }
  } catch (err) {
    throw friendlyError(err);
  }
  if (response.stop_reason === 'refusal') throw new AIError('The AI declined to handle this one — please write this reply yourself.');
  if (response.stop_reason === 'max_tokens') throw new AIError('The AI response was cut short. Try again.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new AIError('The AI returned something unexpected. Try again.');
  }
}

const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

// --- Business knowledge ------------------------------------------------------

const PROFILE_SCHEMA = obj({
  profile: { type: 'string', description: 'Plain-text business profile, using short headed sections.' },
  prices: {
    type: 'array',
    items: obj({ item: { type: 'string' }, price: { type: 'string' }, notes: { type: 'string' } }),
  },
  faqs: { type: 'array', items: obj({ question: { type: 'string' }, answer: { type: 'string' } }) },
});

async function buildProfile(businessName, pages) {
  const corpus = pages.map((p, i) => `<page index="${i + 1}" url="${p.url}" title="${(p.title || '').replace(/"/g, "'")}">\n${p.text}\n</page>`).join('\n\n');
  return callJSON({
    system: `You help a small business answer email enquiries. You will be given the text of pages from the business's website. Write a reference profile that someone answering enquiries on the business's behalf would need. Only include facts stated on the pages - never guess.

The profile should cover, where the pages say so: what the business does and who for; every product and service (with options, sizes, materials, turnaround and delivery details); areas served; opening hours; how to order or book; contact details; policies (deposits, payment, cancellations, guarantees); and anything distinctive about how they work. Also note the tone of voice the website uses. Write it in plain text with short headings, no markdown symbols.

Separately, list every price you can find exactly as written (item, price, and notes such as quantity or conditions), and the questions and answers from any FAQ section.`,
    user: `Business name: ${businessName}\n\n${corpus}`,
    schema: PROFILE_SCHEMA,
    effort: 'medium',
    maxTokens: 32000,
  });
}

// --- Enquiry understanding ---------------------------------------------------------

const ANALYSIS_SCHEMA = obj({
  is_enquiry: { type: 'boolean', description: 'False for spam, sales pitches, newsletters, receipts, notifications and other mail that is not a potential customer.' },
  summary: { type: 'string', description: 'One short sentence (under 20 words) saying what the person wants.' },
  wants: { type: 'string', description: 'Products/services and quantities requested, or empty.' },
  deadline: { type: 'string', description: 'When they need it, as stated, or empty.' },
  budget: { type: 'string', description: 'Budget as stated, or empty.' },
  phone: { type: 'string', description: 'Phone number given in the email, or empty.' },
  customer_name: { type: 'string', description: 'Their name if stated, or empty.' },
  questions: { type: 'array', items: { type: 'string' }, description: 'Questions they asked that need an answer.' },
  temperature: { type: 'string', enum: ['hot', 'warm', 'cold'] },
  temperature_reason: { type: 'string', description: 'One sentence explaining the temperature.' },
});

function knowledgeBlock(business) {
  const s = business.settings;
  const k = s.knowledge;
  const info = s.info;
  const prices = (k.prices || []).filter((p) => p && p.item);
  return [
    `Business name: ${business.name}`,
    info.website && `Website: ${info.website}`,
    info.phone && `Phone: ${info.phone}`,
    info.hours && `Opening hours: ${info.hours}`,
    k.profile && `\nBusiness profile:\n${k.profile}`,
    prices.length && `\nPrice list (authoritative - use these exact prices):\n${prices.map((p) => `- ${p.item}: ${p.price}${p.notes ? ` (${p.notes})` : ''}`).join('\n')}`,
    k.faqs && `\nFrequently asked questions:\n${k.faqs}`,
  ].filter(Boolean).join('\n');
}

async function analyseEnquiry(business, thread) {
  return callJSON({
    system: `You sort incoming email for a business's dedicated enquiries inbox. Read the email thread and extract what the sender wants.

Temperature guide: hot = ready to buy or book soon (asks for a price/quote/booking with specifics, urgency, budget, or a deadline); warm = genuinely interested but still gathering information; cold = vague, early research, or unlikely to buy. Mail that is not from a potential customer (marketing pitches, SEO offers, newsletters, receipts, automated notifications) is not an enquiry.

About the business:
${knowledgeBlock(business)}`,
    user: thread,
    schema: ANALYSIS_SCHEMA,
    effort: 'low',
    maxTokens: 4000,
  });
}

// --- Drafting replies --------------------------------------------------------------

const DRAFT_SCHEMA = obj({
  subject: { type: 'string' },
  body: { type: 'string', description: 'Plain-text email body including greeting and sign-off.' },
});

const TONES = {
  friendly: 'warm, friendly and helpful, like a small local business owner',
  professional: 'polite, professional and concise',
  casual: 'relaxed and conversational, but still clear',
};

function draftSystem(business) {
  const s = business.settings;
  return `You write email replies to customer enquiries on behalf of ${business.name}. Your drafts are sent as-is or after a quick check, so they must be ready to send.

How to write:
- Tone: ${TONES[s.info.tone] || TONES.friendly}. Write in the same language as the customer. Use British English spelling unless the customer writes otherwise.
- Answer their actual questions directly using the business information below. When a price is in the price list, quote it exactly. If the exact item or quantity isn't listed, give the nearest listed prices as a guide and say you'll confirm an exact quote - never invent a price, product, policy or availability that isn't in the information.
- Keep it short: a few short paragraphs at most, no headings or bullet lists unless listing several prices.
- End with one clear next step (e.g. confirm details, book, call).
- Plain text only. No placeholders like [Name] - if you don't know their name, use a natural greeting.
- Sign off with: ${s.info.signature ? `\n${s.info.signature}` : `the ${business.name} team`}
${s.info.extraInstructions ? `\nAdditional instructions from the business:\n${s.info.extraInstructions}\n` : ''}
Business information:
${knowledgeBlock(business)}`;
}

/**
 * @param purpose 'reply' | 'followup'
 * @param opts { askPhone, followUpNumber, instruction, previousDraft }
 */
async function draftReply(business, thread, purpose, opts = {}) {
  const tasks = [];
  if (purpose === 'phonechase') {
    tasks.push(`Write follow-up email number ${opts.followUpNumber || 1}. The customer sent their enquiry ${opts.enquiryWhen || 'recently'} but hasn't replied to our last email or given us a phone number. Refer to when they got in touch naturally, using these words: "${opts.enquiryWhen || 'recently'}". The main aim is to get their phone number so we can talk it through: ask for the best number to reach them on${business.settings.info.phone ? `, or invite them to call us on ${business.settings.info.phone}` : ''}. Keep it short, friendly and not pushy, and don't repeat earlier emails.`);
    opts = { ...opts, askPhone: false };
  } else if (purpose === 'followup') {
    tasks.push(`Write follow-up email number ${opts.followUpNumber || 1}. The customer hasn't replied to our last email. Gently check in, briefly restate how we can help with what they asked about, and make it easy to reply. Don't be pushy and don't repeat the whole previous email.`);
  } else {
    tasks.push('Write a reply to the customer\'s latest message.');
  }
  if (opts.askPhone) {
    tasks.push(`The customer hasn't given a phone number. Ask them to reply with the best number to reach them on${business.settings.info.phone ? `, or to call us on ${business.settings.info.phone}` : ''}.`);
  }
  if (opts.instruction) tasks.push(`Instruction from the person reviewing the draft: ${opts.instruction}`);
  if (opts.previousDraft) tasks.push(`Their previous draft, to revise:\n<draft>\n${opts.previousDraft}\n</draft>`);
  return callJSON({
    system: draftSystem(business),
    user: `<thread>\n${thread}\n</thread>\n\n${tasks.join('\n\n')}\n\nUse "Re: <original subject>" as the subject.`,
    schema: DRAFT_SCHEMA,
    effort: 'medium',
    maxTokens: 8000,
  });
}

async function testKey(key, modelId) {
  const r = await callJSON({
    system: 'Reply with the requested JSON.',
    user: 'Return ok = true.',
    schema: obj({ ok: { type: 'boolean' } }),
    effort: 'low',
    maxTokens: 2000,
    key,
    modelId,
  });
  return r.ok === true;
}

module.exports = {
  MODELS, DEFAULT_MODEL, AIError, isConfigured, model, apiKey,
  buildProfile, analyseEnquiry, draftReply, testKey, knowledgeBlock,
  _setTestClient: (c) => { testClient = c; },
};
