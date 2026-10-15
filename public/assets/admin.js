/* Admin: set up businesses — email, website knowledge, prices, automations, scoring. */
const main = $('#main');
let aiState = { configured: false };


const route = () => {
  const m = location.hash.match(/^#\/b\/(\d+)/);
  return m ? renderSettings(Number(m[1])) : renderList();
};
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// AI settings

async function loadAI() {
  aiState = await api('/api/admin/ai');
  $('#aiBtn').innerHTML = aiState.configured ? '✨ AI on' : '✨ Set up AI';
  return aiState;
}

async function openAI() {
  const s = await loadAI();
  $('#aiKey').value = '';
  $('#aiErr').textContent = '';
  $('#aiModel').innerHTML = s.models.map((m) => `<option value="${esc(m.id)}" ${m.id === s.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  $('#aiStatus').innerHTML = s.configured
    ? `<span class="ok">${ICONS.check} AI is on</span> <span class="muted">· key ${esc(s.keyHint)}${s.source === 'environment' ? ' (from server environment)' : ''}</span>`
    : '<span class="status-critical">No key yet — AI features are off. Templates still work.</span>';
  $('#aiRemove').classList.toggle('hidden', s.source !== 'saved');
  $('#aiDialog').showModal();
}
$('#aiBtn').addEventListener('click', openAI);
$('#aiCancel').addEventListener('click', () => $('#aiDialog').close());
$('#aiRemove').addEventListener('click', async () => {
  if (!confirm('Remove the AI key? Drafts will fall back to your templates.')) return;
  await api('/api/admin/ai', { method: 'PUT', body: { removeKey: true, model: $('#aiModel').value } });
  await openAI();
});
$('#aiForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#aiErr').textContent = '';
  const btn = $('#aiSave');
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    await api('/api/admin/ai', { method: 'PUT', body: { key: $('#aiKey').value.trim(), model: $('#aiModel').value } });
    if (!$('#aiKey').value.trim() && aiState.configured) await api('/api/admin/ai/test', { method: 'POST' });
    toast('AI settings saved');
    await openAI();
    route();
  } catch (err) { $('#aiErr').textContent = err.message; } finally { btn.disabled = false; btn.textContent = 'Save & test'; }
});

// ---------------------------------------------------------------------------
// Business list

async function renderList() {
  document.title = 'Businesses · Admin';
  const list = await api('/api/admin/businesses');
  const aiBanner = aiState.configured ? '' : `<div class="banner">${ICONS.alert}<span>AI is off. Add an API key to have replies written from each business's website and prices.</span><button type="button" onclick="openAI()" style="margin-left:auto">Set up AI</button></div>`;
  if (!list.length) {
    main.innerHTML = `${aiBanner}<div class="card" style="text-align:center;padding:48px 24px">
      <h1 style="margin-bottom:8px">Set up your first business</h1>
      <p class="ink-2" style="max-width:460px;margin:0 auto 18px">Each business gets its own dashboard, enquiries mailbox, website knowledge, prices and autopilot rules. Start with sample data to see how it looks.</p>
      <button type="button" class="primary" onclick="openNew()">+ New business</button>
    </div>`;
    return;
  }
  main.innerHTML = `${aiBanner}<div class="card-head"><h1>Businesses</h1><span class="muted">${list.length} set up</span></div>
    <div class="biz-list">${list.map((b) => {
      const ib = b.settings.inbox;
      const conn = ib.enabled && ib.host
        ? (b.syncState.lastError ? `<span class="status-critical">${ICONS.alert} Mailbox problem</span>` : `<span class="ok">${ICONS.check} ${esc(ib.email || ib.user)}</span>`)
        : '<span class="muted">No mailbox connected</span>';
      const auto = b.settings.automations;
      const pilot = auto.reply.mode === 'auto' ? 'Auto-replies on' : auto.reply.mode === 'draft' ? 'Drafts replies' : 'Replies off';
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
        <div class="ink-2" style="font-size:13px;display:grid;gap:2px">
          <div>${conn}</div>
          <div class="muted">${b.stats.week} new this week · ${pilot}${b.settings.knowledge.profile ? ' · Knows the business' : ''}</div>
        </div>
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
// Settings page (shared with the business owner's dashboard: see settings-ui.js)

async function renderSettings(id) {
  const base = `/api/admin/businesses/${id}`;
  const b = await api(base);
  document.title = `${b.name} · Settings`;
  await SettingsUI.render(main, {
    base,
    call: api,
    admin: true,
    aiConfigured: aiState.configured,
    onOpenAI: openAI,
    onCodeChanged: showCode,
    header: `<div class="card-head">
      <div class="brand">
        <a class="btn ghost" href="#/" aria-label="Back to businesses">←</a>
        <div class="brand-mark" style="background:${esc(b.brandColor)}">${esc(b.name.trim()[0]?.toUpperCase() || '·')}</div>
        <h1>${esc(b.name)}</h1>
      </div>
      <a class="btn" href="/b/${encodeURIComponent(b.slug)}">Open dashboard →</a>
    </div>`,
    wireData: () => {
      $('#demoBtn').addEventListener('click', async () => {
        if (!confirm('This replaces all current enquiries with sample ones. Continue?')) return;
        const r = await api(`${base}/demo`, { method: 'POST' });
        toast(`Loaded ${r.created} sample enquiries`);
      });
      $('#clearBtn').addEventListener('click', () => {
        $('#clearForm').reset();
        $('#clearName').textContent = b.name;
        $('#clearDialog').showModal();
        $('#clearForm').onsubmit = async (ev) => {
          ev.preventDefault();
          const fresh = $('input[name="clearMode"]:checked').value === 'fresh';
          const r = await api(`${base}/clear`, { method: 'POST', body: { fresh, contacts: $('#clearContacts').checked } });
          $('#clearDialog').close();
          toast(`Deleted ${r.deleted} enquiries${r.contactsDeleted ? ` and ${r.contactsDeleted} contacts` : ''}${fresh ? ' — only new emails will appear from now on' : ' — the last 30 days will be re-imported'}`);
        };
      });
      $('#deleteBtn').addEventListener('click', async () => {
        if (prompt(`Type the business name to delete it and all its enquiries:\n${b.name}`) !== b.name) return;
        await api(base, { method: 'DELETE' });
        location.hash = '#/';
      });
    },
  });
}

$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });
loadAI().then(route);
