// Works out IMAP/SMTP settings from just an email address and password.
// 1. Known providers by domain or MX record (Google, Microsoft, Zoho, GoDaddy…)
// 2. Mozilla's public mail-settings database (the one Thunderbird uses)
// 3. The domain's own autoconfig file
// 4. Common guesses (mail.domain, imap.domain…)
// Each candidate is tried with the real password, so what comes back is proven to work.
const dns = require('node:dns').promises;
const cheerio = require('cheerio');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');

const TIMEOUT = 12000;

const imapSSL = (host) => ({ host, port: 993, secure: true });
const smtpSSL = (host) => ({ host, port: 465, secure: true });
const smtpTLS = (host) => ({ host, port: 587, secure: false });

// provider id -> settings and advice
const PROVIDERS = {
  gmail: {
    name: 'Google (Gmail / Google Workspace)', imap: imapSSL('imap.gmail.com'), smtp: smtpSSL('smtp.gmail.com'),
    authHelp: 'Google needs an app password, not your normal password. Turn on 2-Step Verification for this account, then create one at myaccount.google.com/apppasswords and use that here.',
  },
  microsoft: {
    name: 'Microsoft 365 / Outlook', imap: imapSSL('outlook.office365.com'), smtp: smtpTLS('smtp.office365.com'),
    authHelp: 'Microsoft has switched off password sign-in for email apps on most Microsoft 365 and Outlook.com mailboxes. The simplest fix is to forward this mailbox to a Gmail or hosting mailbox and connect that one, or use the forwarding address in "Forwarding & web forms".',
  },
  zoho: { name: 'Zoho Mail', imap: imapSSL('imap.zoho.com'), smtp: smtpSSL('smtp.zoho.com'), authHelp: 'If you use two-factor sign-in with Zoho, create an app-specific password in Zoho Mail settings.' },
  zohoeu: { name: 'Zoho Mail (EU)', imap: imapSSL('imap.zoho.eu'), smtp: smtpSSL('smtp.zoho.eu'), authHelp: 'If you use two-factor sign-in with Zoho, create an app-specific password in Zoho Mail settings.' },
  godaddy: { name: 'GoDaddy email', imap: imapSSL('imap.secureserver.net'), smtp: smtpSSL('smtpout.secureserver.net'), saveToSent: true },
  ionos: { name: 'IONOS', imap: imapSSL('imap.ionos.co.uk'), smtp: smtpTLS('smtp.ionos.co.uk'), saveToSent: true },
  ionoscom: { name: 'IONOS', imap: imapSSL('imap.ionos.com'), smtp: smtpTLS('smtp.ionos.com'), saveToSent: true },
  hostinger: { name: 'Hostinger', imap: imapSSL('imap.hostinger.com'), smtp: smtpSSL('smtp.hostinger.com'), saveToSent: true },
  namecheap: { name: 'Namecheap Private Email', imap: imapSSL('mail.privateemail.com'), smtp: smtpSSL('mail.privateemail.com'), saveToSent: true },
  reg123: { name: '123 Reg', imap: imapSSL('imap.123-reg.co.uk'), smtp: smtpTLS('smtp.123-reg.co.uk'), saveToSent: true },
  onecom: { name: 'one.com', imap: imapSSL('imap.one.com'), smtp: smtpSSL('send.one.com'), saveToSent: true },
  fasthosts: { name: 'Fasthosts', imap: imapSSL('imap.livemail.co.uk'), smtp: smtpSSL('smtp.livemail.co.uk'), saveToSent: true },
  yahoo: { name: 'Yahoo Mail', imap: imapSSL('imap.mail.yahoo.com'), smtp: smtpSSL('smtp.mail.yahoo.com'), authHelp: 'Yahoo needs an app password: Account security → Generate app password.' },
  aol: { name: 'AOL Mail', imap: imapSSL('imap.aol.com'), smtp: smtpSSL('smtp.aol.com'), authHelp: 'AOL needs an app password: Account security → Generate app password.' },
  icloud: { name: 'iCloud Mail', imap: imapSSL('imap.mail.me.com'), smtp: smtpTLS('smtp.mail.me.com'), authHelp: 'iCloud needs an app-specific password from appleid.apple.com.' },
  fastmail: { name: 'Fastmail', imap: imapSSL('imap.fastmail.com'), smtp: smtpSSL('smtp.fastmail.com'), authHelp: 'Fastmail needs an app password from Settings → Privacy & Security.' },
};

const DOMAIN_PROVIDERS = {
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'outlook.com': 'microsoft', 'hotmail.com': 'microsoft', 'hotmail.co.uk': 'microsoft', 'live.com': 'microsoft', 'live.co.uk': 'microsoft', 'msn.com': 'microsoft',
  'yahoo.com': 'yahoo', 'yahoo.co.uk': 'yahoo', 'ymail.com': 'yahoo', 'aol.com': 'aol',
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'zoho.com': 'zoho', 'zohomail.eu': 'zohoeu', 'fastmail.com': 'fastmail',
};

const MX_PROVIDERS = [
  [/google\.com$|googlemail\.com$/, 'gmail'],
  [/outlook\.com$|office365\.us$/, 'microsoft'],
  [/zoho\.eu$/, 'zohoeu'],
  [/zoho\.(com|in)$/, 'zoho'],
  [/secureserver\.net$/, 'godaddy'],
  [/(ionos|1and1|kundenserver)\./, null], // resolved by TLD below
  [/hostinger\.|titan\.email$/, 'hostinger'],
  [/privateemail\.com$|registrar-servers\.com$/, 'namecheap'],
  [/123-reg\.co\.uk$/, 'reg123'],
  [/one\.com$/, 'onecom'],
  [/livemail\.co\.uk$|fasthosts/, 'fasthosts'],
  [/yahoodns\.net$/, 'yahoo'],
  [/icloud\.com$|me\.com$/, 'icloud'],
  [/messagingengine\.com$/, 'fastmail'],
];

function parseAutoconfigXml(xml, email) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const local = email.split('@')[0];
  const domain = email.split('@')[1];
  const user = (u) => (u || '%EMAILADDRESS%').replace('%EMAILADDRESS%', email).replace('%EMAILLOCALPART%', local).replace('%EMAILDOMAIN%', domain);
  const pick = (sel) => {
    const servers = $(sel).map((_, el) => ({
      host: $(el).find('hostname').first().text().trim().replace('%EMAILDOMAIN%', domain),
      port: Number($(el).find('port').first().text().trim()),
      socket: $(el).find('socketType').first().text().trim().toUpperCase(),
      username: user($(el).find('username').first().text().trim()),
    })).get().filter((s) => s.host && s.port && s.socket !== 'PLAIN');
    return servers.find((s) => s.socket === 'SSL') || servers[0] || null;
  };
  const i = pick('incomingServer[type="imap"]');
  const o = pick('outgoingServer[type="smtp"]');
  if (!i) return null;
  return {
    imap: { host: i.host, port: i.port, secure: i.socket === 'SSL', user: i.username },
    smtp: o ? { host: o.host, port: o.port, secure: o.socket === 'SSL', user: o.username } : null,
    name: $('emailProvider displayName').first().text().trim() || null,
  };
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/xml,text/xml' } });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

async function lookupMx(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    return mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
  } catch { return []; }
}

const baseDomain = (host) => host.split('.').slice(-((/\.(co|org|ac|gov|net)\.[a-z]{2}$/.test(host)) ? 3 : 2)).join('.');

/** Gather candidate server settings, most likely first. */
async function findCandidates(email, log) {
  const domain = email.split('@')[1].toLowerCase();
  const imap = [];
  const smtp = [];
  let provider = DOMAIN_PROVIDERS[domain] || null;
  let providerName = null;
  const add = (cfg, source) => {
    if (cfg.imap && !imap.some((c) => c.host === cfg.imap.host && c.port === cfg.imap.port)) imap.push({ ...cfg.imap, source });
    if (cfg.smtp && !smtp.some((c) => c.host === cfg.smtp.host && c.port === cfg.smtp.port)) smtp.push({ ...cfg.smtp, source });
  };

  const mx = provider ? [] : await lookupMx(domain);
  if (mx.length) log(`Mail for ${domain} is handled by ${mx[0]}`);
  if (!provider) {
    for (const [re, id] of MX_PROVIDERS) {
      if (mx.some((h) => re.test(h))) { provider = id || (domain.endsWith('.uk') ? 'ionos' : 'ionoscom'); break; }
    }
  }
  if (provider) {
    providerName = PROVIDERS[provider].name;
    log(`Recognised ${providerName}`);
    add(PROVIDERS[provider], provider);
  }

  // Mozilla ISPDB by domain, then by the MX's domain; then the domain's own autoconfig.
  const sources = [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    ...(mx[0] ? [`https://autoconfig.thunderbird.net/v1.1/${baseDomain(mx[0])}`] : []),
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
  ];
  if (!provider) {
    for (const url of sources) {
      const xml = await fetchText(url);
      const cfg = xml && parseAutoconfigXml(xml, email);
      if (cfg) {
        log(`Found published settings${cfg.name ? ` for ${cfg.name}` : ''}`);
        providerName = providerName || cfg.name;
        add(cfg, 'autoconfig');
        break;
      }
    }
  }

  // Common hosting set-ups (cPanel, Plesk, most UK hosts) — only when the provider is unknown.
  if (provider) return { provider, providerName, imap, smtp };
  for (const h of [`mail.${domain}`, `imap.${domain}`, ...(mx[0] ? [mx[0]] : [])]) add({ imap: imapSSL(h) }, 'guess');
  for (const h of [`mail.${domain}`, `smtp.${domain}`, ...(mx[0] ? [mx[0]] : [])]) {
    add({ smtp: smtpSSL(h) }, 'guess');
    add({ smtp: smtpTLS(h) }, 'guess');
  }
  return { provider, providerName, imap, smtp };
}

function isAuthError(err) {
  return Boolean(err && (err.authenticationFailed || err.code === 'EAUTH'
    || /auth|credential|password|login|LOGIN failed|invalid/i.test(`${err.responseText || ''} ${err.response || ''}`)));
}

async function tryImap(cfg, user, pass) {
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user, pass }, logger: false,
    connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: TIMEOUT * 2,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === '\\Sent');
    return { folders: folders.map((f) => f.path), sentFolder: sent ? sent.path : '' };
  } finally {
    await client.logout().catch(() => {});
  }
}

async function trySmtp(cfg, user, pass) {
  const t = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user, pass },
    connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: TIMEOUT,
  });
  try { await t.verify(); } finally { t.close(); }
}

/**
 * Find and test settings.
 * @returns {{ok:boolean, provider, providerName, imap, smtp, sentFolder, folders, saveToSent, steps:string[], error?:string, help?:string}}
 */
async function discover(email, password) {
  const steps = [];
  const log = (s) => steps.push(s);
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, steps, error: 'That email address doesn\'t look right.' };
  if (!password) return { ok: false, steps, error: 'Enter the mailbox password.' };

  const found = await findCandidates(email, log);
  const help = found.provider && PROVIDERS[found.provider].authHelp;
  const users = (c) => [...new Set([c.user || email, email, email.split('@')[0]])];

  let imap = null;
  let imapInfo = null;
  let authFailed = false;
  let connError = null;
  for (const c of found.imap) {
    for (const user of users(c)) {
      try {
        log(`Trying to sign in at ${c.host}…`);
        imapInfo = await tryImap(c, user, password);
        imap = { host: c.host, port: c.port, secure: c.secure, user };
        break;
      } catch (err) {
        if (isAuthError(err)) { authFailed = true; continue; }
        connError = connError || `${c.host}: ${err.code || err.message}`;
        break; // server unreachable: no point trying other usernames
      }
    }
    if (imap) break;
    // A recognised provider rejected the password: don't hammer guesses.
    if (authFailed && c.source !== 'guess') break;
  }
  if (!imap) {
    return {
      ok: false, steps, provider: found.provider, providerName: found.providerName, help,
      error: authFailed
        ? 'The mail server was found but it rejected the email or password.'
        : found.provider
          ? `Couldn't reach ${found.providerName}'s mail server from this server (${connError}). Check the server's internet access, or try again shortly.`
          : 'Couldn\'t find the mail server automatically. Use "Enter settings manually" with the details from the email provider.',
    };
  }
  log(`Signed in to receive mail (${imap.host})`);

  let smtp = null;
  for (const c of found.smtp) {
    try {
      log(`Checking sending at ${c.host}:${c.port}…`);
      await trySmtp(c, imap.user, password);
      smtp = { host: c.host, port: c.port, secure: c.secure };
      break;
    } catch (err) {
      if (isAuthError(err) && c.source !== 'guess') break;
    }
  }
  if (smtp) log(`Signed in to send mail (${smtp.host})`);
  else log('Could not confirm sending — replies can still be copied into your email app.');

  return {
    ok: true,
    provider: found.provider || 'other',
    providerName: found.providerName || 'Your email host',
    imap, smtp,
    sentFolder: imapInfo.sentFolder,
    folders: imapInfo.folders,
    saveToSent: found.provider ? Boolean(PROVIDERS[found.provider].saveToSent) : true,
    steps,
  };
}

module.exports = { discover, parseAutoconfigXml, findCandidates, PROVIDERS, tryImap, trySmtp, isAuthError };
