/* Business dashboard. */
const slug = decodeURIComponent(location.pathname.split('/')[2]);
const base = `/api/b/${encodeURIComponent(slug)}`;
const loginUrl = `/b/${encodeURIComponent(slug)}/login`;
const call = (url, opts = {}) => api(url, { ...opts, loginUrl });

const state = {
  days: 30,
  view: 'board',
  summary: null,
  enquiries: [],
  openId: null,
  expanded: { hot: false, warm: false, cold: false },
};
const TEMPS = ['hot', 'warm', 'cold'];
const TEMP_DESC = {
  hot: 'Ready to buy — reply fast',
  warm: 'Interested — keep them engaged',
  cold: 'Early stage or gone quiet',
};

// ---------------------------------------------------------------------------
// Loading

async function load() {
  const [summary, enquiries] = await Promise.all([
    call(`${base}/summary?days=${state.days}`),
    call(`${base}/enquiries${$('#fStatus').value === 'spam' ? '?spam=1' : ''}`),
  ]);
  state.summary = summary;
  state.enquiries = enquiries;
  renderHeader();
  renderTemps();
  renderKpis();
  renderChart();
  renderAttention();
  renderEnquiries();
}

function renderHeader() {
  const s = state.summary;
  document.title = `${s.business.name} · Enquiries`;
  document.documentElement.style.setProperty('--brand', s.business.brandColor);
  $('#brandName').textContent = s.business.name;
  $('#brandMark').textContent = s.business.name.trim()[0]?.toUpperCase() || '·';
  const sync = $('#syncStatus');
  if (s.lastSyncError) sync.innerHTML = `<span class="status-critical">${ICONS.alert} Inbox sync problem</span>`;
  else if (s.lastSync) sync.textContent = `Inbox checked ${timeAgo(s.lastSync)}`;
  else sync.textContent = s.inboxEnabled ? 'Waiting for first inbox check…' : '';
  const banner = $('#banner');
  if (s.lastSyncError) {
    banner.innerHTML = `${ICONS.alert}<span>We couldn't check the inbox: ${esc(s.lastSyncError)}. New emails may be missing until this is fixed.</span>`;
    banner.classList.remove('hidden');
  } else banner.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Temperature tiles + mix bar

function renderTemps() {
  const s = state.summary;
  const open = state.enquiries.filter((e) => ['new', 'contacted', 'quoted'].includes(e.status));
  const waiting = (t) => open.filter((e) => e.temperature === t && e.awaitingReply).length;
  const active = $('#fTemp').value;
  $('#tempTiles').innerHTML = TEMPS.map((t) => {
    const w = waiting(t);
    return `<button type="button" class="temp-tile t-${t}" data-temp="${t}" aria-pressed="${active === t}">
      <div class="label">${ICONS[t]} ${TEMP_LABEL[t]}<span class="hide-sm">&nbsp;leads</span></div>
      <div class="big num">${s.byTemp[t]}</div>
      <div class="desc">${TEMP_DESC[t]}</div>
      ${w ? `<div class="flag">${ICONS.clock} ${w} waiting<span class="hide-sm">&nbsp;for a reply</span></div>` : `<div class="flag" style="background:transparent;padding-left:0;color:var(--muted)">${ICONS.check} Nobody waiting</div>`}
    </button>`;
  }).join('');
  $$('#tempTiles .temp-tile').forEach((b) => b.addEventListener('click', () => {
    $('#fTemp').value = $('#fTemp').value === b.dataset.temp ? '' : b.dataset.temp;
    renderTemps();
    renderEnquiries();
    $('#enqTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  const total = TEMPS.reduce((n, t) => n + s.byTemp[t], 0);
  const pct = (t) => (total ? Math.round((s.byTemp[t] / total) * 100) : 0);
  $('#mix').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
      <h3>Lead mix <span class="muted" style="font-weight:400">· ${total} open ${total === 1 ? 'enquiry' : 'enquiries'}</span></h3>
    </div>
    <div class="mix-bar" role="img" aria-label="${TEMPS.map((t) => `${TEMP_LABEL[t]} ${pct(t)}%`).join(', ')}">
      ${total ? TEMPS.filter((t) => s.byTemp[t]).map((t) => `<span style="flex:${s.byTemp[t]};background:var(--${t})" title="${TEMP_LABEL[t]}: ${s.byTemp[t]}"></span>`).join('') : ''}
    </div>
    <div class="mix-legend">${TEMPS.map((t) => `<span><i class="swatch" style="background:var(--${t})"></i>${TEMP_LABEL[t]} <b class="num">${s.byTemp[t]}</b> <span class="muted">(${pct(t)}%)</span></span>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// KPI tiles

function delta(cur, prev, { lowerIsBetter = false, suffix = '' } = {}) {
  if (prev == null || cur == null || prev === 0) return '';
  const change = ((cur - prev) / prev) * 100;
  if (Math.abs(change) < 1) return `<span class="muted">No change${suffix}</span>`;
  const good = lowerIsBetter ? change < 0 : change > 0;
  return `<span class="${good ? 'delta-up' : 'delta-down'}">${change > 0 ? '▲' : '▼'} ${Math.abs(Math.round(change))}%</span>${suffix}`;
}

function renderKpis() {
  const { totals: t, days, responseTargetHours: target, currency } = state.summary;
  const vs = ` <span class="muted">vs previous ${days} days</span>`;
  const rt = t.medianResponseHours;
  const tiles = [
    {
      label: 'New enquiries',
      value: t.enquiries,
      foot: delta(t.enquiries, t.enquiriesPrev, { suffix: vs }) || `<span class="muted">In the last ${days} days</span>`,
    },
    {
      label: 'Waiting for a reply',
      value: t.awaitingReply,
      foot: t.overdue
        ? `<span class="status-critical">${ICONS.alert} ${t.overdue} over your ${formatHours(target)} target</span>`
        : `<span class="delta-up">${ICONS.check} All within ${formatHours(target)} target</span>`,
    },
    {
      label: 'Typical reply time',
      value: formatHours(rt),
      foot: rt == null ? '<span class="muted">No replies yet</span>'
        : `${rt <= target ? `<span class="delta-up">${ICONS.check} Within target</span>` : `<span class="status-critical">${ICONS.alert} Slower than ${formatHours(target)} target</span>`}`,
    },
    {
      label: 'Won',
      value: t.won,
      foot: t.winRate == null ? '<span class="muted">Nothing closed yet</span>'
        : `<span class="ink-2">${Math.round(t.winRate * 100)}% win rate${t.wonValue ? ` · ${money(t.wonValue, currency)}` : ''}</span>`,
    },
  ];
  $('#kpis').innerHTML = tiles.map((k) => `<div class="card kpi">
    <div class="k-label">${k.label}</div>
    <div class="k-value num">${k.value}</div>
    <div class="k-foot">${k.foot}</div>
  </div>`).join('');
}

// ---------------------------------------------------------------------------
// Stacked column chart: enquiries per day by temperature

function niceMax(v) {
  if (v <= 4) return 4;
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  for (const s of steps) if (v <= s) return s;
  return Math.ceil(v / 1000) * 1000;
}

function roundedTopRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderChart() {
  const { series, days } = state.summary;
  const el = $('#chart');
  const W = Math.max(280, el.clientWidth);
  const H = W < 500 ? 200 : 300;
  const m = { t: 10, r: 4, b: 24, l: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const totals = series.map((d) => d.hot + d.warm + d.cold);
  const max = niceMax(Math.max(1, ...totals));
  const ticks = max <= 4 ? [0, 1, 2, 3, 4] : [0, max / 4, max / 2, (3 * max) / 4, max].filter((v) => Number.isInteger(v));
  const band = iw / series.length;
  const bw = Math.max(2, Math.min(24, band * 0.7));
  const y = (v) => m.t + ih - (v / max) * ih;
  const GAP = 2;

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Enquiries per day over the last ${days} days, split by hot, warm and cold">`;
  ticks.forEach((v) => {
    svg += `<line class="${v === 0 ? 'axis-line' : 'grid-line'}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  });

  const labelEvery = days <= 7 ? 1 : days <= 30 ? 7 : 14;
  series.forEach((d, i) => {
    const cx = m.l + band * i + band / 2;
    const x = cx - bw / 2;
    svg += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
    let acc = 0;
    const segs = TEMPS.filter((t) => d[t] > 0);
    segs.forEach((t, si) => {
      const y0 = y(acc);
      const y1 = y(acc + d[t]);
      const top = si === segs.length - 1;
      const hgt = Math.max(1, y0 - y1 - (si > 0 ? GAP : 0));
      const yTop = y0 - (si > 0 ? GAP : 0) - hgt;
      svg += top
        ? `<path d="${roundedTopRect(x, yTop, bw, hgt, 4)}" fill="var(--${t})" pointer-events="none"/>`
        : `<rect x="${x}" y="${yTop}" width="${bw}" height="${hgt}" fill="var(--${t})" pointer-events="none"/>`;
      acc += d[t];
    });
    const fromEnd = series.length - 1 - i;
    if (fromEnd % labelEvery === 0) {
      const label = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, days <= 7 ? { weekday: 'short' } : { day: 'numeric', month: 'short' });
      svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${label}</text>`;
    }
  });
  svg += '</svg>';
  el.innerHTML = `${svg}<div class="tooltip hidden" id="tt"></div>`;

  const tt = $('#tt', el);
  $$('.hit', el).forEach((r) => {
    const show = () => {
      const d = series[Number(r.dataset.i)];
      const total = d.hot + d.warm + d.cold;
      $$('.hit.active', el).forEach((a) => a.classList.remove('active'));
      r.classList.add('active');
      tt.innerHTML = `<div class="tt-title">${new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
        ${TEMPS.map((t) => `<div class="tt-row"><span><i class="swatch" style="background:var(--${t})"></i>${TEMP_LABEL[t]}</span><b class="num">${d[t]}</b></div>`).join('')}
        <div class="tt-row" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span>Total</span><b class="num">${total}</b></div>`;
      const bx = Number(r.getAttribute('x')) + band / 2;
      tt.style.left = `${Math.min(Math.max(bx, 70), W - 70)}px`;
      tt.style.top = `${Math.max(y(total), m.t + 60)}px`;
      tt.classList.remove('hidden');
    };
    r.addEventListener('mouseenter', show);
    r.addEventListener('click', show);
  });
  el.querySelector('svg').addEventListener('mouseleave', () => {
    tt.classList.add('hidden');
    $$('.hit.active', el).forEach((a) => a.classList.remove('active'));
  });

  const total = totals.reduce((a, b) => a + b, 0);
  $('#chartSub').textContent = `${total} in the last ${days} days`;
  $('#chartLegend').innerHTML = TEMPS.map((t) => `<span><i class="swatch" style="background:var(--${t})"></i>${TEMP_LABEL[t]}</span>`).join('');
  $('#chartTable').innerHTML = `<table class="list"><thead><tr><th>Day</th>${TEMPS.map((t) => `<th>${TEMP_LABEL[t]}</th>`).join('')}<th>Total</th></tr></thead><tbody>
    ${series.filter((d) => d.hot + d.warm + d.cold).reverse().map((d) => `<tr style="cursor:default"><td>${d.date}</td>${TEMPS.map((t) => `<td class="num">${d[t]}</td>`).join('')}<td class="num">${d.hot + d.warm + d.cold}</td></tr>`).join('')}
  </tbody></table>`;
}

// ---------------------------------------------------------------------------
// Needs attention

function waitingPill(e) {
  if (!e.awaitingReply) return '';
  return e.overdue
    ? `<span class="pill overdue">${ICONS.clock} Waiting ${formatHours(e.waitingHours)}</span>`
    : `<span class="pill waiting">${ICONS.clock} Waiting ${formatHours(e.waitingHours)}</span>`;
}

function renderAttention() {
  const list = state.summary.needsAttention;
  $('#attention').innerHTML = list.length ? list.map((e) => `<li><button type="button" data-id="${e.id}">
      <span class="dot t-${e.temperature}" title="${TEMP_LABEL[e.temperature]}"></span>
      <span class="body">
        <div class="who">${esc(e.fromName || e.fromEmail)}</div>
        <div class="what">${esc(e.subject)}</div>
      </span>
      <span class="meta">
        <div>${tempPill(e.temperature)}</div>
        <div style="margin-top:4px" class="${e.overdue ? 'status-critical' : 'muted'}">${formatHours(e.waitingHours)} waiting</div>
      </span>
    </button></li>`).join('')
    : `<li class="empty">${ICONS.check} You're all caught up — nobody important is waiting.</li>`;
  $$('#attention button').forEach((b) => b.addEventListener('click', () => openDrawer(Number(b.dataset.id))));
}

// ---------------------------------------------------------------------------
// Board / list

function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const temp = $('#fTemp').value;
  const status = $('#fStatus').value;
  const awaiting = $('#fAwaiting').checked;
  return state.enquiries.filter((e) => {
    if (temp && e.temperature !== temp) return false;
    if (status === 'open' && !['new', 'contacted', 'quoted'].includes(e.status)) return false;
    if (status && status !== 'open' && e.status !== status) return false;
    if (awaiting && !e.awaitingReply) return false;
    if (q && ![e.fromName, e.fromEmail, e.subject, e.preview, e.phone].some((v) => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

function card(e) {
  return `<div class="card" tabindex="0" role="button" data-id="${e.id}" style="--t:var(--${e.temperature})">
    <div class="ecard-top">
      <span class="ecard-name">${esc(e.fromName || e.fromEmail)}</span>
      <span class="ecard-time">${timeAgo(e.lastInboundAt)}</span>
    </div>
    <div class="ecard-subj">${esc(e.subject)}</div>
    <div class="ecard-prev">${esc(e.preview || '')}</div>
    <div class="ecard-foot">
      <span class="pill status ${e.status}">${STATUS_LABEL[e.status]}</span>
      ${waitingPill(e)}
      <span class="score" title="Lead score out of 100">${e.score}</span>
    </div>
  </div>`;
}

function renderEnquiries() {
  const items = filtered();
  const host = $('#enquiries');
  if (state.view === 'board') {
    const PAGE = 12;
    host.innerHTML = `<div class="board">${TEMPS.map((t) => {
      const col = items.filter((e) => e.temperature === t)
        .sort((a, b) => Number(b.awaitingReply) - Number(a.awaitingReply) || b.score - a.score);
      const shown = state.expanded[t] ? col : col.slice(0, PAGE);
      return `<div class="col t-${t}">
        <div class="col-head">${ICONS[t]} ${TEMP_LABEL[t]} <span class="count num">${col.length}</span></div>
        ${shown.map(card).join('') || '<div class="empty">None</div>'}
        ${col.length > shown.length ? `<div class="more"><button type="button" class="ghost" data-more="${t}">Show ${col.length - shown.length} more</button></div>` : ''}
      </div>`;
    }).join('')}</div>`;
    $$('[data-more]', host).forEach((b) => b.addEventListener('click', () => { state.expanded[b.dataset.more] = true; renderEnquiries(); }));
  } else {
    const sorted = [...items].sort((a, b) => Date.parse(b.lastInboundAt) - Date.parse(a.lastInboundAt));
    host.innerHTML = sorted.length ? `<div class="table-wrap"><table class="list">
      <thead><tr><th>Lead</th><th>From</th><th>Subject</th><th>Status</th><th>Reply</th><th>Received</th><th class="num">Score</th></tr></thead>
      <tbody>${sorted.map((e) => `<tr tabindex="0" data-id="${e.id}">
        <td>${tempPill(e.temperature)}</td>
        <td><div style="font-weight:600">${esc(e.fromName || '')}</div><div class="muted">${esc(e.fromEmail)}</div></td>
        <td class="subj">${esc(e.subject)}</td>
        <td><span class="pill status ${e.status}">${STATUS_LABEL[e.status]}</span></td>
        <td>${waitingPill(e) || `<span class="muted">${e.lastResponseAt ? 'Replied' : '—'}</span>`}</td>
        <td class="muted" style="white-space:nowrap">${timeAgo(e.receivedAt)}</td>
        <td class="num">${e.score}</td>
      </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">No enquiries match these filters.</div>';
  }
  $$('[data-id]', host).forEach((el) => {
    el.addEventListener('click', () => openDrawer(Number(el.dataset.id)));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDrawer(Number(el.dataset.id)); } });
  });
}

// ---------------------------------------------------------------------------
// Detail drawer

let lastFocus = null;

async function openDrawer(id) {
  lastFocus = document.activeElement;
  state.openId = id;
  const e = await call(`${base}/enquiries/${id}`);
  renderDrawer(e);
  $('#scrim').classList.remove('hidden');
  $('#drawer').classList.remove('hidden');
  $('#dClose').focus();
}

function closeDrawer() {
  state.openId = null;
  $('#scrim').classList.add('hidden');
  $('#drawer').classList.add('hidden');
  lastFocus?.focus?.();
}

function renderDrawer(e) {
  const cur = state.summary?.currency || '£';
  const firstIn = e.messages.find((m) => m.direction === 'in');
  const reSubject = /^re:/i.test(e.subject || '') ? e.subject : `Re: ${e.subject || ''}`;
  const quote = firstIn ? `\n\n\n> ${firstIn.body.split('\n').join('\n> ')}` : '';
  const mailto = `mailto:${encodeURIComponent(e.fromEmail)}?subject=${encodeURIComponent(reSubject)}&body=${encodeURIComponent(`Hi ${(e.fromName || '').split(' ')[0] || 'there'},\n\n${quote}`)}`;
  const realEmail = !e.fromEmail.endsWith('@manual.local');

  $('#drawer').innerHTML = `
    <div class="drawer-head" style="border-top:4px solid var(--${e.temperature})">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div style="display:flex;gap:6px;flex-wrap:wrap">${tempPill(e.temperature)}<span class="pill status ${e.status}">${STATUS_LABEL[e.status]}</span>${waitingPill(e)}</div>
        <button type="button" class="ghost" id="dClose" aria-label="Close">✕</button>
      </div>
      <div class="who" id="dWho" style="margin-top:10px">${esc(e.fromName || e.fromEmail)}</div>
      <div class="contact">
        ${realEmail ? `<a href="mailto:${esc(e.fromEmail)}">${esc(e.fromEmail)}</a>` : ''}
        ${e.phone ? `<a href="tel:${esc(e.phone.replace(/[^\d+]/g, ''))}">${esc(e.phone)}</a>` : ''}
      </div>
      <div class="actions">
        ${realEmail ? `<a class="btn primary" href="${esc(mailto)}" style="background:var(--accent);color:#fff;border-color:var(--accent)">Reply by email</a>` : ''}
        ${e.phone ? `<a class="btn" href="tel:${esc(e.phone.replace(/[^\d+]/g, ''))}">Call</a>` : ''}
        ${e.awaitingReply ? '<button type="button" id="dReplied">✓ Mark as replied</button>' : ''}
      </div>
    </div>
    <div class="drawer-body">
      <div class="dl">
        <div class="field"><label for="dStatus">Stage</label>
          <select id="dStatus">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === e.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <div class="field"><label for="dTemp">Lead temperature</label>
          <select id="dTemp">
            <option value="">Automatic</option>
            ${TEMPS.map((t) => `<option value="${t}" ${e.tempOverridden && e.temperature === t ? 'selected' : ''}>${TEMP_LABEL[t]} (set by hand)</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="dValue">Deal value (${esc(cur)})</label>
          <input id="dValue" type="number" min="0" step="any" value="${e.value ?? ''}" placeholder="${e.budget ? `Budget mentioned: ${e.budget}` : 'e.g. 2500'}">
        </div>
        <div class="field"><label>Received</label><div class="ink-2" style="padding-top:6px">${formatDateTime(e.receivedAt)}</div></div>
      </div>

      <div class="block">
        <h3>Why it's ${TEMP_LABEL[e.temperature].toLowerCase()} — score ${e.score}/100${e.tempOverridden ? ' (temperature set by hand)' : ''}</h3>
        <ul class="why">
          ${e.signals.map((s) => `<li><span>${esc(s.label)}</span><span class="pts ${s.points > 0 ? 'pos' : s.points < 0 ? 'neg' : ''}">${s.points > 0 ? '+' : ''}${s.points}</span></li>`).join('')}
        </ul>
      </div>

      <div class="block">
        <h3>Notes</h3>
        <textarea id="dNotes" placeholder="Anything worth remembering — saved automatically">${esc(e.notes)}</textarea>
      </div>

      <div class="block">
        <h3>Conversation (${e.messages.length})</h3>
        ${e.messages.map((m) => `<div class="msg ${m.direction}">
          <div class="msg-meta"><span>${m.direction === 'in' ? esc(e.fromName || e.fromEmail) : 'You replied'}</span><span>${formatDateTime(m.sentAt)}</span></div>
          ${m.subject ? `<div style="font-weight:600;margin-bottom:4px">${esc(m.subject)}</div>` : ''}
          <div class="msg-body">${esc(m.body)}</div>
        </div>`).join('')}
      </div>
    </div>`;

  $('#dClose').addEventListener('click', closeDrawer);
  const save = async (patch, msg) => {
    const updated = await call(`${base}/enquiries/${e.id}`, { method: 'PATCH', body: patch });
    if (msg) toast(msg);
    renderDrawer(updated);
    load();
  };
  $('#dStatus').addEventListener('change', (ev) => save({ status: ev.target.value }, `Moved to ${STATUS_LABEL[ev.target.value]}`));
  $('#dTemp').addEventListener('change', (ev) => save({ tempOverride: ev.target.value || null }, 'Temperature updated'));
  $('#dValue').addEventListener('change', (ev) => save({ value: ev.target.value }, 'Value saved'));
  $('#dNotes').addEventListener('blur', (ev) => { if (ev.target.value !== e.notes) save({ notes: ev.target.value }, 'Notes saved'); });
  $('#dReplied')?.addEventListener('click', () => save({ markReplied: true }, 'Marked as replied'));
}

// ---------------------------------------------------------------------------
// Wiring

$$('#period button').forEach((b) => b.addEventListener('click', () => {
  $$('#period button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  state.days = Number(b.dataset.days);
  load();
}));
$$('[data-view]').forEach((b) => b.addEventListener('click', () => {
  $$('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  state.view = b.dataset.view;
  renderEnquiries();
}));
['#q', '#fTemp', '#fAwaiting'].forEach((s) => $(s).addEventListener('input', () => { renderTemps(); renderEnquiries(); }));
$('#fStatus').addEventListener('change', load);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && state.openId) closeDrawer(); });
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = loginUrl; });

const dlg = $('#addDialog');
$('#addBtn').addEventListener('click', () => { $('#addForm').reset(); $('#aErr').textContent = ''; dlg.showModal(); });
$('#aCancel').addEventListener('click', () => dlg.close());
$('#addForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  try {
    const e = await call(`${base}/enquiries`, { method: 'POST', body });
    dlg.close();
    toast(`Added — scored ${TEMP_LABEL[e.temperature].toLowerCase()}`);
    await load();
    openDrawer(e.id);
  } catch (err) {
    $('#aErr').textContent = err.message;
  }
});

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.summary && renderChart(), 150); });

api('/api/me').then((me) => { if (me.admin) $('#adminLink').classList.remove('hidden'); });
load();
setInterval(() => { if (!state.openId && document.visibilityState === 'visible') load(); }, 60000);
