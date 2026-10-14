/* Admin: create businesses and configure each one's inbox, scoring and branding. */
const main = $('#main');

const PRESETS = {
  Gmail: { host: 'imap.gmail.com', port: 993, secure: true, sentFolder: '[Gmail]/Sent Mail' },
  'Outlook / Microsoft 365': { host: 'outlook.office365.com', port: 993, secure: true, sentFolder: 'Sent Items' },
  'Yahoo': { host: 'imap.mail.yahoo.com', port: 993, secure: true, sentFolder: 'Sent' },
  'iCloud': { host: 'imap.mail.me.com', port: 993, secure: true, sentFolder: 'Sent Messages' },
  'Zoho': { host: 'imap.zoho.eu', port: 993, secure: true, sentFolder: 'Sent' },
  'GoDaddy / 123-reg': { host: 'imap.secureserver.net', port: 993, secure: true, sentFolder: 'Sent Items' },
};

const LIST_FIELDS = [
  ['serviceTerms', 'Your products & services', 'What this business sells. Mentions make a lead warmer. e.g. kitchen, bathroom, extension'],
  ['intentTerms', 'Buying words', 'Words that show someone wants to buy or book'],
  ['urgencyTerms', 'Urgency words', 'Words that show they need it soon'],
  ['lowIntentTerms', 'Early-stage words', 'Words that suggest they are only browsing (lowers the score)'],
  ['spamTerms', 'Spam words', 'Anything containing these is filed as spam'],
  ['ignoreSenders', 'Ignore emails from', 'Skip senders whose address contains any of these (newsletters, notifications)'],
];

const route = () => {
  const m = location.hash.match(/^#\/b\/(\d+)/);
  return m ? renderSettings(Number(m[1])) : renderList();
};
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Business list

async function renderList() {
  document.title = 'Businesses · Admin';
  const list = await api('/api/admin/businesses');
  if (!list.length) {
    main.innerHTML = `<div class="card" style="text-align:center;padding:48px 24px">
      <h1 style="margin-bottom:8px">Set up your first business</h1>
      <p class="ink-2" style="max-width:460px;margin:0 auto 18px">Each business gets its own dashboard, inbox connection and lead-scoring rules. Start with sample data to see how it looks.</p>
      <button type="button" class="primary" onclick="openNew()">+ New business</button>
    </div>`;
    return;
  }
  main.innerHTML = `<div class="card-head"><h1>Businesses</h1><span class="muted">${list.length} set up</span></div>
    <div class="biz-list">${list.map((b) => {
      const inbox = b.settings.inbox;
      const syncErr = b.syncState.lastError;
      const conn = inbox.enabled && inbox.host
        ? (syncErr ? `<span class="status-critical">${ICONS.alert} Inbox error</span>` : `<span class="ok">${ICONS.check} Inbox connected</span>`)
        : '<span class="muted">Inbox not connected</span>';
      return `<div class="card biz">
        <div class="brand">
          <div class="brand-mark" style="background:${esc(b.brandColor)}">${esc(b.name.trim()[0]?.toUpperCase() || '·')}</div>
          <div style="min-width:0">
            <div class="brand-name">${esc(b.name)}</div>
            <div class="muted" style="font-size:12px">/b/${esc(b.slug)}</div>
          </div>
        </div>
        <div class="stats">
          ${tempPill('hot').replace('Hot', `${b.stats.hot} hot`)}
          ${tempPill('warm').replace('Warm', `${b.stats.warm} warm`)}
          ${tempPill('cold').replace('Cold', `${b.stats.cold} cold`)}
          ${b.stats.overdue ? `<span class="pill overdue">${ICONS.clock} ${b.stats.overdue} overdue</span>` : ''}
        </div>
        <div class="ink-2" style="font-size:13px">${b.stats.week} new this week · ${conn}</div>
        <div class="row">
          <a class="btn primary" href="/b/${encodeURIComponent(b.slug)}" style="background:var(--accent);color:#fff;border-color:var(--accent)">Open dashboard</a>
          <a class="btn" href="#/b/${b.id}">Settings</a>
        </div>
      </div>`;
    }).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// New business

const newDlg = $('#newDialog');
function openNew() { $('#newForm').reset(); $('#nColor').value = '#2a78d6'; $('#nErr').textContent = ''; newDlg.showModal(); }
$('#newBtn').addEventListener('click', openNew);
$('#nCancel').addEventListener('click', () => newDlg.close());
$('#newForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const b = await api('/api/admin/businesses', { method: 'POST', body: { name: $('#nName').value, brandColor: $('#nColor').value, demo: $('#nDemo').checked } });
    newDlg.close();
    showCode(b.name, b.slug, b.accessCode);
    location.hash = `#/b/${b.id}`;
  } catch (err) { $('#nErr').textContent = err.message; }
});

function showCode(name, slug, code) {
  $('#cName').textContent = name;
  $('#cUrl').textContent = `${location.origin}/b/${slug}`;
  $('#cCode').textContent = code;
  $('#cCopy').onclick = () => {
    navigator.clipboard?.writeText(`${name} enquiry dashboard\n${location.origin}/b/${slug}\nAccess code: ${code}`);
    toast('Copied');
  };
  $('#codeDialog').showModal();
}

// ---------------------------------------------------------------------------
// Settings

const lines = (arr) => (arr || []).join('\n');
const fromLines = (s) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

async function renderSettings(id) {
  const b = await api(`/api/admin/businesses/${id}`);
  const s = b.settings;
  const sc = s.scoring;
  const ib = s.inbox;
  document.title = `${b.name} · Settings`;
  const hook = `${location.origin}/api/inbound/${b.inboundToken}`;

  main.innerHTML = `
    <div class="card-head">
      <div class="brand">
        <a class="btn ghost" href="#/" aria-label="Back to businesses">←</a>
        <div class="brand-mark" style="background:${esc(b.brandColor)}">${esc(b.name.trim()[0]?.toUpperCase() || '·')}</div>
        <h1>${esc(b.name)}</h1>
      </div>
      <a class="btn" href="/b/${encodeURIComponent(b.slug)}">Open dashboard →</a>
    </div>
    <form class="settings" id="sf" autocomplete="off">
      <nav aria-label="Settings sections">
        <a href="#basics" data-jump>Basics</a>
        <a href="#inbox" data-jump>Connect inbox</a>
        <a href="#forward" data-jump>Forwarding &amp; web forms</a>
        <a href="#scoring" data-jump>Lead scoring</a>
        <a href="#data" data-jump>Data</a>
      </nav>
      <div>
        <section class="card" id="basics">
          <h2>Basics</h2>
          <p class="lead">How the dashboard looks and how your client signs in.</p>
          <div class="two">
            <div class="field"><label for="name">Business name</label><input id="name" value="${esc(b.name)}" required></div>
            <div class="field"><label for="slug">Dashboard address</label><input id="slug" value="${esc(b.slug)}"><div class="hint">${esc(location.origin)}/b/<b>${esc(b.slug)}</b></div></div>
            <div class="field"><label for="color">Brand colour</label><input id="color" type="color" value="${esc(b.brandColor)}" style="height:38px;padding:3px"></div>
            <div class="field"><label for="code">New access code</label>
              <div style="display:flex;gap:6px"><input id="code" placeholder="${b.hasAccessCode ? 'Leave blank to keep current code' : 'Set a code'}"><button type="button" id="genCode">Generate</button></div>
              <div class="hint">What your client types to open their dashboard.</div>
            </div>
            <div class="field"><label for="contactEmail">Business email address</label><input id="contactEmail" type="email" value="${esc(s.contactEmail)}"><div class="hint">Emails from this address are treated as replies, not enquiries.</div></div>
            <div class="field"><label for="target">Reply target (hours)</label><input id="target" type="number" min="0.25" step="0.25" value="${s.responseTargetHours}"><div class="hint">Enquiries waiting longer than this are flagged as overdue.</div></div>
          </div>
        </section>

        <section class="card" id="inbox">
          <h2>Connect inbox</h2>
          <p class="lead">Checks the business inbox for new enquiries automatically. For Gmail and Microsoft 365 use an <b>app password</b>, not the normal login password.</p>
          <div class="presets">${Object.keys(PRESETS).map((k) => `<button type="button" data-preset="${esc(k)}">${esc(k)}</button>`).join('')}</div>
          <label class="chk field"><input type="checkbox" id="ibEnabled" ${ib.enabled ? 'checked' : ''}> Check this inbox automatically</label>
          <div class="three">
            <div class="field" style="grid-column:span 2"><label for="ibHost">IMAP server</label><input id="ibHost" value="${esc(ib.host)}" placeholder="imap.example.com"></div>
            <div class="field"><label for="ibPort">Port</label><input id="ibPort" type="number" value="${ib.port}"></div>
          </div>
          <div class="two">
            <div class="field"><label for="ibUser">Email / username</label><input id="ibUser" value="${esc(ib.user)}"></div>
            <div class="field"><label for="ibPass">Password</label><input id="ibPass" type="password" value="${esc(ib.password)}" placeholder="App password"></div>
            <div class="field"><label for="ibFolder">Enquiries folder</label><input id="ibFolder" value="${esc(ib.folder)}"></div>
            <div class="field"><label for="ibSent">Sent folder (optional)</label><input id="ibSent" value="${esc(ib.sentFolder)}"><div class="hint">Lets the dashboard see replies, so reply times are tracked automatically.</div></div>
            <div class="field"><label for="ibPoll">Check every (minutes)</label><input id="ibPoll" type="number" min="1" value="${ib.pollMinutes}"></div>
            <label class="chk field" style="align-self:center"><input type="checkbox" id="ibSecure" ${ib.secure ? 'checked' : ''}> Use SSL/TLS</label>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" id="testBtn">Test connection</button>
            <button type="button" id="syncBtn">Check inbox now</button>
          </div>
          <div class="result" id="ibResult">${b.syncState.lastError ? `<span class="status-critical">${ICONS.alert} Last check failed: ${esc(b.syncState.lastError)}</span>` : b.syncState.lastSync ? `<span class="ok">${ICONS.check} Last checked ${timeAgo(b.syncState.lastSync)}</span>` : ''}</div>
        </section>

        <section class="card" id="forward">
          <h2>Forwarding &amp; web forms</h2>
          <p class="lead">No IMAP access? Point an email-forwarding service (Postmark, Mailgun, Zapier, Make) or the website's contact form at this address instead.</p>
          <div class="field"><label>Inbound address</label><pre id="hookUrl">${esc(hook)}</pre>
            <div style="display:flex;gap:8px"><button type="button" id="copyHook">Copy</button><button type="button" id="rotate">Generate new address</button></div>
          </div>
          <details><summary style="cursor:pointer">Website contact form example</summary>
<pre>&lt;form action="${esc(hook)}" method="post"&gt;
  &lt;input name="name" placeholder="Your name"&gt;
  &lt;input name="email" type="email" required&gt;
  &lt;input name="phone"&gt;
  &lt;textarea name="message"&gt;&lt;/textarea&gt;
  &lt;button&gt;Send&lt;/button&gt;
&lt;/form&gt;</pre></details>
          <details style="margin-top:8px"><summary style="cursor:pointer">Test it from a terminal</summary>
<pre>curl -X POST ${esc(hook)} \\
  -H "Content-Type: application/json" \\
  -d '{"from":"Jane &lt;jane@example.com&gt;","subject":"Quote please","text":"Hi, can I get a price for next week? Budget £2,000."}'</pre></details>
        </section>

        <section class="card" id="scoring">
          <h2>Lead scoring</h2>
          <p class="lead">Every enquiry gets a score out of 100 from what it says. These rules decide where hot, warm and cold begin. Saving re-scores existing enquiries.</p>
          <div class="three">
            <div class="field"><label for="hotT">Hot from score</label><input id="hotT" type="number" min="1" max="100" value="${sc.hotThreshold}"></div>
            <div class="field"><label for="warmT">Warm from score</label><input id="warmT" type="number" min="0" max="100" value="${sc.warmThreshold}"></div>
            <div class="field"><label for="minBudget">Minimum budget</label><input id="minBudget" type="number" min="0" value="${sc.minBudget}"><div class="hint">Budgets below this lower the score. 0 = off.</div></div>
          </div>
          <div class="field"><div class="thresholds" id="thBar"></div><div class="hint" id="thHint"></div></div>
          <div class="field" style="max-width:120px"><label for="currency">Currency symbol</label><input id="currency" value="${esc(sc.currency)}" maxlength="3"></div>
          <div class="two">
            ${LIST_FIELDS.map(([k, label, hint]) => `<div class="field"><label for="l_${k}">${label}</label><textarea id="l_${k}" rows="5">${esc(lines(sc[k]))}</textarea><div class="hint">${hint}. One per line.</div></div>`).join('')}
          </div>
        </section>

        <section class="card" id="data">
          <h2>Data</h2>
          <p class="lead">Sample data is handy for demos. Clear it before connecting the real inbox.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" id="demoBtn">Load sample enquiries</button>
            <button type="button" id="clearBtn">Clear all enquiries</button>
            <button type="button" class="danger" id="deleteBtn">Delete business</button>
          </div>
        </section>

        <div class="savebar">
          <span class="err" id="sErr" style="margin:auto auto auto 0"></span>
          <a class="btn" href="#/">Cancel</a>
          <button type="submit" class="primary">Save changes</button>
        </div>
      </div>
    </form>`;

  const drawThresholds = () => {
    const hot = Number($('#hotT').value) || 0;
    const warm = Number($('#warmT').value) || 0;
    $('#thBar').innerHTML = `<span style="flex:${Math.max(0, warm)};background:var(--cold)"></span><span style="flex:${Math.max(0, hot - warm)};background:var(--warm)"></span><span style="flex:${Math.max(0, 100 - hot)};background:var(--hot)"></span>`;
    $('#thHint').textContent = `Cold 0–${Math.max(0, warm - 1)} · Warm ${warm}–${Math.max(warm, hot - 1)} · Hot ${hot}–100`;
  };
  drawThresholds();
  ['#hotT', '#warmT'].forEach((s) => $(s).addEventListener('input', drawThresholds));

  $$('[data-jump]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); $(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth' }); }));
  $('#genCode').addEventListener('click', () => {
    const words = 'amber,birch,cedar,delta,ember,fable,grove,harbor,ivory,juniper,kestrel,lumen,maple,north,orchid,pebble,quartz,river,sage,tidal'.split(',');
    const r = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
    $('#code').value = `${words[r(words.length)]}-${words[r(words.length)]}-${100 + r(900)}`;
  });
  $$('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset];
    $('#ibHost').value = p.host; $('#ibPort').value = p.port; $('#ibSecure').checked = p.secure; $('#ibSent').value = p.sentFolder;
    if (!$('#ibUser').value && $('#contactEmail').value) $('#ibUser').value = $('#contactEmail').value;
  }));

  const inboxValues = () => ({
    enabled: $('#ibEnabled').checked, host: $('#ibHost').value.trim(), port: Number($('#ibPort').value),
    secure: $('#ibSecure').checked, user: $('#ibUser').value.trim(), password: $('#ibPass').value,
    folder: $('#ibFolder').value.trim() || 'INBOX', sentFolder: $('#ibSent').value.trim(), pollMinutes: Number($('#ibPoll').value) || 5,
  });

  $('#testBtn').addEventListener('click', async () => {
    const out = $('#ibResult');
    out.innerHTML = '<span class="muted">Connecting…</span>';
    try {
      const r = await api(`/api/admin/businesses/${id}/test-inbox`, { method: 'POST', body: { inbox: inboxValues() } });
      out.innerHTML = `<span class="ok">${ICONS.check} Connected.</span> <span class="muted">Folders: ${esc(r.folders.slice(0, 12).join(', '))}${r.folders.length > 12 ? '…' : ''}</span>`;
    } catch (err) { out.innerHTML = `<span class="status-critical">${ICONS.alert} ${esc(err.message)}</span>`; }
  });
  $('#syncBtn').addEventListener('click', async () => {
    const out = $('#ibResult');
    out.innerHTML = '<span class="muted">Saving settings and checking inbox…</span>';
    try {
      await save(false);
      const r = await api(`/api/admin/businesses/${id}/sync`, { method: 'POST' });
      out.innerHTML = `<span class="ok">${ICONS.check} Done:</span> ${r.created || 0} new enquiries, ${r.appended || 0} follow-ups, ${r.replies || 0} replies found.`;
    } catch (err) { out.innerHTML = `<span class="status-critical">${ICONS.alert} ${esc(err.message)}</span>`; }
  });
  $('#copyHook').addEventListener('click', () => { navigator.clipboard?.writeText(hook); toast('Copied'); });
  $('#rotate').addEventListener('click', async () => {
    if (!confirm('Anything using the current address (forwarding rules, website forms) will stop working until updated. Continue?')) return;
    await api(`/api/admin/businesses/${id}/rotate-token`, { method: 'POST' });
    renderSettings(id);
  });
  $('#demoBtn').addEventListener('click', async () => {
    if (!confirm('This replaces all current enquiries with sample ones. Continue?')) return;
    const r = await api(`/api/admin/businesses/${id}/demo`, { method: 'POST' });
    toast(`Loaded ${r.created} sample enquiries`);
  });
  $('#clearBtn').addEventListener('click', async () => {
    if (!confirm(`Delete every enquiry for ${b.name}? This cannot be undone.`)) return;
    const r = await api(`/api/admin/businesses/${id}/clear`, { method: 'POST' });
    toast(`Deleted ${r.deleted} enquiries`);
  });
  $('#deleteBtn').addEventListener('click', async () => {
    if (prompt(`Type the business name to delete it and all its enquiries:\n${b.name}`) !== b.name) return;
    await api(`/api/admin/businesses/${id}`, { method: 'DELETE' });
    location.hash = '#/';
  });

  async function save(rescore = true) {
    const body = {
      name: $('#name').value, slug: $('#slug').value, brandColor: $('#color').value, rescore,
      settings: {
        contactEmail: $('#contactEmail').value.trim(),
        responseTargetHours: Number($('#target').value),
        inbox: inboxValues(),
        scoring: {
          hotThreshold: Number($('#hotT').value), warmThreshold: Number($('#warmT').value),
          minBudget: Number($('#minBudget').value) || 0, currency: $('#currency').value,
          ...Object.fromEntries(LIST_FIELDS.map(([k]) => [k, fromLines($(`#l_${k}`).value)])),
        },
      },
    };
    const code = $('#code').value.trim();
    if (code) body.accessCode = code;
    const updated = await api(`/api/admin/businesses/${id}`, { method: 'PUT', body });
    if (code) showCode(updated.name, updated.slug, code);
    return updated;
  }

  $('#sf').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#sErr').textContent = '';
    if (Number($('#warmT').value) >= Number($('#hotT').value)) { $('#sErr').textContent = 'Warm must start below hot.'; return; }
    try {
      await save();
      toast('Saved — enquiries re-scored');
      renderSettings(id);
    } catch (err) { $('#sErr').textContent = err.message; }
  });
}

$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });
route();
