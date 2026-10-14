// Reads a business's website so the AI understands what it sells.
// Modes: the homepage only, a crawl of the whole site, or a list of pages.
const dns = require('node:dns').promises;
const net = require('node:net');
const cheerio = require('cheerio');
const { db, tx } = require('./db');

const UA = 'Mozilla/5.0 (compatible; EnquiryDashboardBot/1.0; +reads this site to answer customer enquiries)';
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_PAGE_CHARS = 20000;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|mp4|mp3|mov|avi|docx?|xlsx?|pptx?|css|js|json|xml|woff2?|ttf)(\?|$)/i;
const SKIP_PATH = /\/(cart|basket|checkout|login|log-in|signin|sign-in|register|account|my-account|wp-admin|wp-login|feed|tag|author|privacy|cookie|terms)(\/|$|\?)/i;
// Pages most useful for answering enquiries are read first.
const USEFUL = /price|pricing|cost|rates|quote|service|product|shop|store|about|faq|question|contact|delivery|shipping|turnaround|area|book|how-it-works|menu|packages|catalog|range/i;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

// Only fetch public websites — never the server's own network.
async function assertPublic(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Not a web address: ${url}`);
  if (process.env.ALLOW_PRIVATE_FETCH === '1') return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error(`${u.hostname} is not a public website`);
}

function normalise(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'].forEach((p) => u.searchParams.delete(p));
    return u.toString();
  } catch { return null; }
}

async function fetchUrl(url, redirects = 0) {
  await assertPublic(url);
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    if (redirects >= 5) throw new Error('Too many redirects');
    return fetchUrl(new URL(res.headers.get('location'), url).toString(), redirects + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('Page is too large');
  const buf = Buffer.from(await res.arrayBuffer());
  return { url: res.url || url, type: res.headers.get('content-type') || '', body: buf.subarray(0, MAX_BYTES).toString('utf8') };
}

function extract(html, url) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const description = $('meta[name="description"]').attr('content') || '';
  const links = new Set();
  $('a[href]').each((_, a) => {
    try {
      const href = new URL($(a).attr('href'), url);
      href.hash = '';
      links.add(href.toString());
    } catch { /* ignore bad links */ }
  });
  $('script, style, noscript, svg, iframe, template, form select, [aria-hidden="true"]').remove();
  $('br').replaceWith('\n');
  const blocks = [];
  $('h1, h2, h3, h4, h5, h6, p, li, tr, td, th, dt, dd, address, blockquote, figcaption, label, summary, .price, [class*="price"]').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    if (tag === 'tr') { // keep table rows together so prices stay next to their item
      const cells = $el.children('td, th').map((__, c) => $(c).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
      if (cells.length) blocks.push(cells.join(' | '));
      return;
    }
    if ((tag === 'td' || tag === 'th') && $el.closest('tr').length) return;
    if ($el.find('p, li, h1, h2, h3, h4, td').length) return; // only leaf-ish blocks, avoids repeats
    const t = $el.text().replace(/[ \t ]+/g, ' ').replace(/\n\s*/g, '\n').trim();
    if (!t) return;
    blocks.push(/^h\d$/.test(tag) ? `\n## ${t}` : tag === 'li' ? `- ${t}` : t);
  });
  let text = blocks.join('\n');
  // Sites built from bare <div>s hide most text from the block pass: fall back to the whole body.
  $('div, section, article, tr, header, footer, main, aside, span.block').append('\n');
  const bodyText = $('body').text().split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  if (text.length < bodyText.length * 0.3) text = bodyText;
  const seen = new Set();
  text = text.split('\n').filter((l) => { const k = l.trim(); if (k.length > 3 && seen.has(k)) return false; seen.add(k); return true; }).join('\n');
  if (description) text = `${description}\n${text}`;
  return { title, text: text.trim().slice(0, MAX_PAGE_CHARS), links: [...links] };
}

async function robotsRules(origin) {
  try {
    const r = await fetchUrl(`${origin}/robots.txt`);
    const rules = [];
    let applies = false;
    for (const line of r.body.split('\n')) {
      const [k, ...rest] = line.split(':');
      const key = k.trim().toLowerCase();
      const val = rest.join(':').trim();
      if (key === 'user-agent') applies = val === '*';
      else if (applies && key === 'disallow' && val) rules.push(val);
    }
    return rules;
  } catch { return []; }
}

async function sitemapUrls(origin) {
  try {
    const r = await fetchUrl(`${origin}/sitemap.xml`);
    const $ = cheerio.load(r.body, { xmlMode: true });
    const locs = $('loc').map((_, el) => $(el).text().trim()).get();
    // A sitemap index points to more sitemaps: read the first few.
    const nested = locs.filter((l) => /\.xml(\?|$)/i.test(l)).slice(0, 3);
    const out = locs.filter((l) => !/\.xml(\?|$)/i.test(l));
    for (const n of nested) {
      try {
        const rr = await fetchUrl(n);
        const $$ = cheerio.load(rr.body, { xmlMode: true });
        out.push(...$$('loc').map((_, el) => $$(el).text().trim()).get());
      } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}

/**
 * Fetch pages for a business.
 * @param {{mode:'home'|'site'|'pages', website:string, pages:string[], maxPages:number}} opts
 * @param {(msg:string)=>void} progress
 */
async function readWebsite(opts, progress = () => {}) {
  const start = normalise(opts.website || opts.pages?.[0]);
  if (!start) throw new Error('Enter the website address first');
  const origin = new URL(start).origin;
  const limit = Math.min(Math.max(1, Number(opts.maxPages) || 20), 60);
  const results = [];
  const errors = [];

  const readOne = async (url) => {
    try {
      progress(`Reading ${url}`);
      const r = await fetchUrl(url);
      if (!/html|text\/plain/i.test(r.type)) return null;
      const page = /html/i.test(r.type) ? extract(r.body, r.url) : { title: '', text: r.body.slice(0, MAX_PAGE_CHARS), links: [] };
      if (page.text.trim().length < 20) return null;
      results.push({ url: r.url, title: page.title, text: page.text });
      return page;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      return null;
    }
  };

  if (opts.mode === 'pages') {
    const list = [...new Set((opts.pages || []).map(normalise).filter(Boolean))].slice(0, limit);
    if (!list.length) throw new Error('Add at least one page address');
    for (const url of list) await readOne(url);
  } else if (opts.mode === 'home') {
    await readOne(start);
  } else {
    const disallow = await robotsRules(origin);
    const allowed = (u) => {
      const url = new URL(u);
      return url.origin === origin && !SKIP_EXT.test(url.pathname) && !SKIP_PATH.test(url.pathname)
        && !disallow.some((d) => url.pathname.startsWith(d)) && url.search.length < 60;
    };
    const queue = [start];
    const seen = new Set([start]);
    const enqueue = (urls) => {
      for (const u of urls) {
        const n = normalise(u);
        if (!n || seen.has(n) || !allowed(n)) continue;
        seen.add(n);
        queue.push(n);
      }
      // Useful-looking pages first, then shallower paths.
      queue.sort((a, b) => (USEFUL.test(b) - USEFUL.test(a)) || (a.split('/').length - b.split('/').length));
    };
    const first = await readOne(queue.shift());
    if (first) enqueue(first.links);
    enqueue(await sitemapUrls(origin));
    while (queue.length && results.length < limit) {
      const page = await readOne(queue.shift());
      if (page) enqueue(page.links);
    }
  }
  if (!results.length) throw new Error(`Couldn't read any pages. ${errors[0] || ''}`.trim());
  return { pages: results, errors };
}

function savePages(businessId, pages) {
  const now = new Date().toISOString();
  tx(() => {
    db.prepare('DELETE FROM knowledge_pages WHERE business_id = ?').run(businessId);
    const ins = db.prepare('INSERT INTO knowledge_pages (business_id, url, title, text, fetched_at) VALUES (?, ?, ?, ?, ?)');
    pages.forEach((p) => ins.run(businessId, p.url, p.title || '', p.text, now));
  });
}

function listPages(businessId) {
  return db.prepare('SELECT url, title, text, fetched_at AS fetchedAt FROM knowledge_pages WHERE business_id = ? ORDER BY id').all(businessId);
}

module.exports = { readWebsite, savePages, listPages, extract, normalise, isPrivateIp };
