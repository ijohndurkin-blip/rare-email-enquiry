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
  renderApprovals();
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
      <div class="label">${ICONS[t]}<span>${TEMP_LABEL[t]}<span class="hide-sm"> leads</span></span></div>
      <div class="big num">${s.byTemp[t]}</div>
      <div class="desc">${TEMP_DESC[t]}</div>
      ${w ? `<div class="flag">${ICONS.clock}<span>${w} waiting<span class="hide-sm"> for a reply</span></span></div>` : `<div class="flag" style="background:transparent;padding-left:0;color:var(--muted)">${ICONS.check} Nobody waiting</div>`}
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
      foot: (rt == null ? '<span class="muted">No replies yet</span>'
        : `${rt <= target ? `<span class="delta-up">${ICONS.check} Within target</span>` : `<span class="status-critical">${ICONS.alert} Slower than ${formatHours(target)} target</span>`}`)
        + (t.autoSent ? `<span class="muted"> · ${t.autoSent} sent automatically</span>` : ''),
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

function timeUntil(iso) {
  const h = (Date.parse(iso) - Date.now()) / 3600000;
  if (h < 1) return 'soon';
  if (h < 24) return `in ${Math.round(h)}h`;
  return `in ${Math.round(h / 24)}d`;
}

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
        <div class="what">${esc(e.aiSummary || e.subject)}</div>
      </span>
      <span class="meta">
        <div>${tempPill(e.temperature)}</div>
        <div style="margin-top:4px" class="${e.overdue ? 'status-critical' : 'muted'}">${e.draftCount ? '<span class="draft-dot">✉ Reply ready</span>' : `${formatHours(e.waitingHours)} waiting`}</div>
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
    if (q && ![e.fromName, e.fromEmail, e.subject, e.preview, e.phone, e.aiSummary].some((v) => String(v || '').toLowerCase().includes(q))) return false;
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
    <div class="ecard-prev">${e.aiSummary ? `<span class="ai-sum">${esc(e.aiSummary)}</span>` : esc(e.preview || '')}</div>
    <div class="ecard-foot">
      <span class="pill status ${e.status}">${STATUS_LABEL[e.status]}</span>
      ${e.draftCount ? '<span class="pill draft">✉ Reply ready</span>' : waitingPill(e)}
      ${!e.draftCount && e.nextScheduledAt ? `<span class="pill waiting" title="Follow-up scheduled">${ICONS.clock} Follow-up ${timeUntil(e.nextScheduledAt)}</span>` : ''}
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
        <td class="subj">${esc(e.aiSummary || e.subject)}</td>
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
  state.review = null;
  $('#scrim').classList.add('hidden');
  $('#drawer').classList.add('hidden');
  lastFocus?.focus?.();
}

function mailtoLink(e, subject, body) {
  return `mailto:${encodeURIComponent(e.fromEmail)}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
}

function whenLabel(iso) {
  const d = new Date(iso);
  const mins = (d - Date.now()) / 60000;
  if (mins < 1) return 'in a moment';
  if (mins < 60) return `in ${Math.round(mins)} min`;
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const WRITTEN_BY = { ai: 'Written by AI', template: 'From your template', manual: 'Written by you' };

function composerHtml(e, o) {
  const s = state.summary || {};
  const label = o.kind === 'followup' ? `Follow-up ${o.step || ''}`.trim() : 'Reply';
  const realEmail = !e.fromEmail.endsWith('@manual.local');
  const canSend = s.canSend && realEmail;
  return `<div class="composer" data-oid="${o.id ?? ''}">
    <div class="composer-head">
      <span><b>${o.id ? `${label} ready to check` : 'Your reply'}</b>${o.writtenBy ? ` <span class="muted">· ${WRITTEN_BY[o.writtenBy] || ''}</span>` : ''}</span>
      ${o.status === 'failed' ? `<span class="status-critical">${ICONS.alert} Not sent</span>` : ''}
    </div>
    ${o.error ? `<div class="note">${esc(o.error)}</div>` : ''}
    <input class="c-subject" value="${esc(o.subject || '')}" aria-label="Subject">
    <textarea class="c-body" rows="10" aria-label="Email">${esc(o.body || '')}</textarea>
    ${s.aiEnabled ? `<div class="rewrite">
      <input class="c-instr" placeholder="Ask AI to change it — e.g. “shorter”, “offer a 10% discount”, “say we can do Friday”" aria-label="Instruction for AI">
      <button type="button" data-act="rewrite">✨ Rewrite</button>
    </div>` : ''}
    <div class="c-actions">
      ${canSend ? '<button type="button" class="primary" data-act="send">Send</button>' : `<a class="btn primary" data-act="mailto" href="#" style="background:var(--accent);color:#fff;border-color:var(--accent)">Open in email app</a>`}
      <button type="button" data-act="copy">Copy text</button>
      <span class="spacer"></span>
      ${o.id ? '<button type="button" class="ghost danger" data-act="discard">Discard</button>' : '<button type="button" class="ghost" data-act="cancel-new">Cancel</button>'}
    </div>
    ${!canSend && realEmail ? '<div class="muted" style="font-size:12px;margin-top:6px">Sending from the dashboard needs the mailbox connected. After sending from your email app, press “Mark as replied”.</div>' : ''}
  </div>`;
}

function renderDrawer(e) {
  const cur = state.summary?.currency || '£';
  const realEmail = !e.fromEmail.endsWith('@manual.local');
  const s = state.summary || {};
  const drafts = e.outbox.filter((o) => o.status === 'draft' || o.status === 'failed');
  const scheduled = e.outbox.filter((o) => o.status === 'scheduled');
  const d = e.aiDetails || {};
  const facts = [['Wants', d.wants], ['When', d.deadline], ['Budget', d.budget]].filter(([, v]) => v);
  const reviewNav = state.review ? `<div class="review-nav"><span>Checking replies · ${state.review.index + 1} of ${state.review.ids.length}</span>
      <span><button type="button" class="ghost" id="rvPrev" ${state.review.index === 0 ? 'disabled' : ''}>← Back</button><button type="button" class="ghost" id="rvNext">${state.review.index + 1 < state.review.ids.length ? 'Skip →' : 'Done'}</button></span></div>` : '';

  $('#drawer').innerHTML = `
    ${reviewNav}
    <div class="drawer-head" style="border-top:4px solid var(--${e.temperature})">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div style="display:flex;gap:6px;flex-wrap:wrap">${tempPill(e.temperature)}<span class="pill status ${e.status}">${STATUS_LABEL[e.status]}</span>${waitingPill(e)}</div>
        <button type="button" class="ghost" id="dClose" aria-label="Close">✕</button>
      </div>
      <div class="who" id="dWho" style="margin-top:10px">${esc(e.fromName || e.fromEmail)}</div>
      <div class="contact">
        ${realEmail ? `<a href="mailto:${esc(e.fromEmail)}">${esc(e.fromEmail)}</a>` : ''}
        ${e.phone ? `<a href="tel:${esc(e.phone.replace(/[^\d+]/g, ''))}">${esc(e.phone)}</a>` : '<span class="muted">No phone number</span>'}
      </div>
      ${e.aiSummary ? `<div class="summary-box"><div class="sum">${esc(e.aiSummary)}</div>
        ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<span><b>${k}:</b> ${esc(v)}</span>`).join('')}</div>` : ''}
        ${d.questions?.length ? `<div class="facts"><span><b>Asked:</b> ${d.questions.map(esc).join(' · ')}</span></div>` : ''}</div>` : ''}
      <div class="actions">
        ${!drafts.length && realEmail ? `${s.aiEnabled ? '<button type="button" class="primary" id="dDraft">✨ Write a reply</button>' : ''}<button type="button" id="dWrite" ${s.aiEnabled ? '' : 'class="primary"'}>Write my own</button>` : ''}
        ${e.phone ? `<a class="btn" href="tel:${esc(e.phone.replace(/[^\d+]/g, ''))}">Call</a>` : ''}
        ${e.awaitingReply ? '<button type="button" id="dReplied">✓ Mark as replied</button>' : ''}
      </div>
    </div>
    <div class="drawer-body">
      <div id="composers">${drafts.map((o) => composerHtml(e, o)).join('')}</div>

      ${scheduled.length ? `<div class="block"><h3>Coming up</h3>${scheduled.map((o) => `<div class="sched">
        <span>${ICONS.clock} <b>${o.kind === 'followup' ? `Follow-up ${o.step}` : 'Reply'}</b> ${o.auto ? 'sends automatically' : 'will be drafted for you to check'} ${whenLabel(o.dueAt)}</span>
        <button type="button" class="ghost" data-cancel="${o.id}">Cancel</button>
      </div>`).join('')}<div class="muted" style="font-size:12px">Follow-ups stop by themselves if they reply.</div></div>` : ''}

      <div class="block">
        <h3>Conversation (${e.messages.length})</h3>
        ${e.messages.map((m) => `<div class="msg ${m.direction}">
          <div class="msg-meta"><span>${m.direction === 'in' ? esc(e.fromName || e.fromEmail) : m.auto ? 'Sent automatically' : 'You replied'}</span><span>${formatDateTime(m.sentAt)}</span></div>
          ${m.subject ? `<div style="font-weight:600;margin-bottom:4px">${esc(m.subject)}</div>` : ''}
          <div class="msg-body">${esc(m.body)}</div>
        </div>`).join('')}
      </div>

      <div class="block">
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
      </div>

      <div class="block">
        <h3>Notes</h3>
        <textarea id="dNotes" placeholder="Anything worth remembering — saved automatically">${esc(e.notes)}</textarea>
      </div>

      <div class="block">
        <h3>Why it's ${TEMP_LABEL[e.temperature].toLowerCase()}${e.tempSource === 'manual' ? ' (set by hand)' : ''}</h3>
        ${e.tempSource === 'ai' && e.aiReason ? `<p class="ink-2" style="margin:0 0 8px">${esc(e.aiReason)}</p>` : ''}
        <details ${e.tempSource === 'rules' ? 'open' : ''}><summary class="muted" style="cursor:pointer;font-size:12px">Score ${e.score}/100 from signals in the email</summary>
        <ul class="why">
          ${e.signals.map((x) => `<li><span>${esc(x.label)}</span><span class="pts ${x.points > 0 ? 'pos' : x.points < 0 ? 'neg' : ''}">${x.points > 0 ? '+' : ''}${x.points}</span></li>`).join('')}
        </ul></details>
      </div>
    </div>`;

  wireDrawer(e);
}

function wireDrawer(e) {
  const refresh = (updated, msg) => {
    if (msg) toast(msg);
    if (updated) renderDrawer(updated);
    load();
  };
  const save = async (patch, msg) => refresh(await call(`${base}/enquiries/${e.id}`, { method: 'PATCH', body: patch }), msg);
  $('#dClose').addEventListener('click', closeDrawer);
  $('#dStatus').addEventListener('change', (ev) => save({ status: ev.target.value }, `Moved to ${STATUS_LABEL[ev.target.value]}`));
  $('#dTemp').addEventListener('change', (ev) => save({ tempOverride: ev.target.value || null }, 'Temperature updated'));
  $('#dValue').addEventListener('change', (ev) => save({ value: ev.target.value }, 'Value saved'));
  $('#dNotes').addEventListener('blur', (ev) => { if (ev.target.value !== e.notes) save({ notes: ev.target.value }, 'Notes saved'); });
  $('#dReplied')?.addEventListener('click', () => save({ markReplied: true }, 'Marked as replied'));
  $('#rvNext')?.addEventListener('click', () => reviewStep(1));
  $('#rvPrev')?.addEventListener('click', () => reviewStep(-1));

  $('#dDraft')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true; ev.target.textContent = 'Writing…';
    try { refresh(await call(`${base}/enquiries/${e.id}/draft`, { method: 'POST', body: {} })); } catch (err) { toast(err.message); ev.target.disabled = false; ev.target.textContent = '✨ Write a reply'; }
  });
  $('#dWrite')?.addEventListener('click', () => {
    const first = (e.fromName || '').split(' ')[0];
    $('#composers').innerHTML = composerHtml(e, { subject: /^re:/i.test(e.subject || '') ? e.subject : `Re: ${e.subject || ''}`, body: `Hi ${first || 'there'},\n\n` });
    wireComposers(e, refresh);
    $('#composers .c-body').focus();
  });
  $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    refresh(await call(`${base}/outbox/${b.dataset.cancel}`, { method: 'DELETE' }), 'Cancelled');
  }));
  wireComposers(e, refresh);
}

function wireComposers(e, refresh) {
  $$('#composers .composer').forEach((c) => {
    const oid = c.dataset.oid;
    const subject = () => $('.c-subject', c).value;
    const body = () => $('.c-body', c).value;
    const busy = (btn, text) => { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = text; };
    const idle = (btn) => { btn.disabled = false; btn.textContent = btn.dataset.label; };
    // Keep edits to a saved draft.
    if (oid) {
      [$('.c-subject', c), $('.c-body', c)].forEach((el) => el.addEventListener('change', () => {
        call(`${base}/outbox/${oid}`, { method: 'PATCH', body: { subject: subject(), body: body() } }).catch(() => {});
      }));
    }
    c.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'copy') {
        navigator.clipboard?.writeText(body());
        toast('Copied');
      } else if (act === 'mailto') {
        ev.preventDefault();
        location.href = mailtoLink(e, subject(), body());
      } else if (act === 'cancel-new') {
        renderDrawer(e);
      } else if (act === 'discard') {
        refresh(await call(`${base}/outbox/${oid}`, { method: 'DELETE' }), 'Draft discarded');
      } else if (act === 'rewrite') {
        const instruction = $('.c-instr', c).value.trim();
        busy(btn, 'Rewriting…');
        try {
          if (oid) await call(`${base}/outbox/${oid}`, { method: 'PATCH', body: { subject: subject(), body: body() } });
          refresh(await call(`${base}/enquiries/${e.id}/draft`, { method: 'POST', body: { instruction: instruction || 'Improve this draft.' } }));
        } catch (err) { toast(err.message); idle(btn); }
      } else if (act === 'send') {
        if (!body().trim()) return toast('The email is empty');
        busy(btn, 'Sending…');
        try {
          const updated = oid
            ? await call(`${base}/outbox/${oid}/send`, { method: 'POST', body: { subject: subject(), body: body() } })
            : await call(`${base}/enquiries/${e.id}/send`, { method: 'POST', body: { subject: subject(), body: body() } });
          toast('Sent ✓');
          if (state.review) { load(); return reviewStep(1, true); }
          refresh(updated);
        } catch (err) { toast(err.message); idle(btn); }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Approval queue: step through drafted replies one after another

async function startReview() {
  const queue = await call(`${base}/queue`);
  const ids = [...new Set(queue.map((q) => q.enquiryId))];
  if (!ids.length) return toast('Nothing waiting — all caught up');
  state.review = { ids, index: 0 };
  openDrawer(ids[0]);
}

function reviewStep(dir, afterSend = false) {
  const r = state.review;
  if (!r) return;
  if (afterSend) r.ids.splice(r.index, 1);
  else r.index += dir;
  if (afterSend && r.index >= r.ids.length) r.index = r.ids.length - 1;
  if (r.index < 0 || r.index >= r.ids.length || !r.ids.length) {
    state.review = null;
    closeDrawer();
    toast('All replies checked');
    return;
  }
  openDrawer(r.ids[r.index]);
}

function renderApprovals() {
  const s = state.summary;
  const n = s.totals.drafts;
  const el = $('#approvals');
  if (!n) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="approve-icon">✉</div>
    <div style="flex:1;min-width:0"><div style="font-weight:600">${n} ${n === 1 ? 'reply is' : 'replies are'} ready for you to check</div>
    <div class="ink-2" style="font-size:13px">${s.aiEnabled ? 'Written using your website and prices.' : 'Prepared from your template.'} Read, tweak if needed, and send.</div></div>
    <button type="button" class="primary" id="reviewBtn">Check &amp; send</button>`;
  $('#reviewBtn').addEventListener('click', startReview);
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
// Links like /b/slug#enquiry-42 (used in alert emails) open that enquiry.
const openFromHash = () => {
  const m = location.hash.match(/^#enquiry-(\d+)/);
  if (m) openDrawer(Number(m[1]));
};
window.addEventListener('hashchange', openFromHash);
load().then(openFromHash);
setInterval(() => { if (!state.openId && document.visibilityState === 'visible') load(); }, 60000);
