/* Business settings page, shared by the admin area and the business owner's dashboard.
 *
 * SettingsUI.render(container, {
 *   base,          // API base: /api/admin/businesses/:id  or  /api/b/:slug/settings
 *   call,          // fetch helper (api / call)
 *   admin,         // true in the admin area (extra sections: address, data)
 *   aiConfigured,  // whether an AI key is set
 *   onOpenAI,      // admin only: open the AI settings dialog
 *   onCodeChanged, // (name, slug, code) after a new access code is saved
 *   header,        // HTML shown above the form
 * })
 */
const SettingsUI = (() => {
  const LIST_FIELDS = [
    ['serviceTerms', 'Your products & services', 'Mentions make a lead warmer. e.g. business cards, flyers, banners'],
    ['intentTerms', 'Buying words', 'Words that show someone wants to buy or book'],
    ['urgencyTerms', 'Urgency words', 'Words that show they need it soon'],
    ['lowIntentTerms', 'Early-stage words', 'Words that suggest they are only browsing (lowers the score)'],
    ['spamTerms', 'Junk words', 'Anything containing these is filed as junk'],
    ['ignoreSenders', 'Ignore emails from', 'Skip senders whose address contains any of these'],
  ];
  const TIMEZONES = ['Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Pacific/Auckland', 'Asia/Dubai', 'Asia/Singapore', 'Africa/Johannesburg'];
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const lines = (arr) => (arr || []).join('\n');
  const fromLines = (s) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const numbers = (s) => String(s).split(/[,\s]+/).map(Number).filter((n) => n > 0);
  const radio = (name, value, current, label, hint = '') => `<label><input type="radio" name="${name}" value="${esc(value)}" ${value === current ? 'checked' : ''}><span><b>${label}</b>${hint ? `<span>${hint}</span>` : ''}</span></label>`;
  const modeRadios = (name, current) => ['off', 'draft', 'auto'].map((m) => `<label><input type="radio" name="${name}" value="${m}" ${current === m ? 'checked' : ''}> ${{ off: 'Off', draft: 'Prepare a draft to approve', auto: 'Send automatically' }[m]}</label>`).join('');
  const val = (name) => $(`input[name="${name}"]:checked`)?.value;

  function fillVars(t, vars) {
    return String(t || '').replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m)).replace(/\n{3,}/g, '\n\n').trim();
  }

  function inboxStatus(b) {
    const ib = b.settings.inbox;
    if (!(ib.enabled && ib.host)) return '';
    const st = b.syncState || {};
    return `<div class="connected">
      <div class="big-tick">${ICONS.check}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${esc(ib.email || ib.user)}</div>
        <div class="ink-2" style="font-size:13px">Receiving ${ICONS.check} · Sending ${ib.smtpHost ? ICONS.check : '<span class="status-critical">not set up</span>'}${ib.sentFolder ? ` · Reads "${esc(ib.sentFolder)}" to spot your replies` : ''}</div>
        <div class="muted" style="font-size:12px;margin-top:2px">${st.lastError ? `<span class="status-critical">${ICONS.alert} Last check failed: ${esc(st.lastError)}</span>` : st.lastSync ? `Last checked ${timeAgo(st.lastSync)}` : 'Checking for the first time…'}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" id="syncBtn">Check now</button><button type="button" id="changeMail">Change</button></div>
    </div>`;
  }

  function priceRow(p = {}) {
    return `<tr>
      <td><input data-k="item" value="${esc(p.item || '')}" placeholder="e.g. Business cards ×500" aria-label="Item"></td>
      <td style="width:22%"><input data-k="price" value="${esc(p.price || '')}" placeholder="£45" aria-label="Price"></td>
      <td><input data-k="notes" value="${esc(p.notes || '')}" placeholder="400gsm, double-sided" aria-label="Notes"></td>
      <td><button type="button" class="ghost" data-del aria-label="Remove row">✕</button></td>
    </tr>`;
  }

  function readPrices() {
    return $$('#priceRows tr').map((tr) => Object.fromEntries($$('input', tr).map((i) => [i.dataset.k, i.value.trim()])))
      .filter((p) => p.item || p.price);
  }

  function updatePriceCount() {
    const n = readPrices().length;
    $('#priceCount').textContent = `${n} item${n === 1 ? '' : 's'}`;
  }

  function addPrices(list) {
    const body = $('#priceRows');
    const existing = new Set(readPrices().map((p) => `${p.item}|${p.price}`.toLowerCase()));
    list.filter((p) => !existing.has(`${p.item}|${p.price}`.toLowerCase())).forEach((p) => body.insertAdjacentHTML('beforeend', priceRow(p)));
    body.querySelectorAll('tr').forEach((tr) => { if (!$$('input', tr).some((i) => i.value)) tr.remove(); });
    updatePriceCount();
  }

  // "If your first email goes on a Monday: Tuesday, Wednesday, then the Wednesday after."
  function chaseSummary(days, weekLater) {
    const steps = [...days];
    if (weekLater) steps.push(7);
    if (!steps.length) return 'Add at least one number of days.';
    let at = 0;
    const names = steps.map((d, i) => {
      at += d;
      const name = DAYS[at % 7];
      const weeks = Math.floor(at / 7);
      if (i === steps.length - 1 && weekLater && d === 7) return `then the ${name} after`;
      return weeks >= 1 ? `${name} the following week` : name;
    });
    return `If your first email goes on a Monday, chasers go on ${names.join(', ')}.`;
  }

  async function render(main, opts) {
    const call = opts.call;
    const base = opts.base;
    const b = await call(base);
    const s = b.settings;
    const sc = s.scoring;
    const ib = s.inbox;
    const k = s.knowledge;
    const info = s.info;
    const au = s.automations;
    const admin = Boolean(opts.admin);
    const aiOn = Boolean(opts.aiConfigured);
    const connected = ib.enabled && ib.host;
    const hook = `${location.origin}/api/inbound/${b.inboundToken}`;
    const aiOffNote = aiOn ? '' : `<div class="help">AI is off, so this uses your template instead. ${admin ? '<a href="#" data-open-ai>Set up AI</a> to have replies written from the business\'s website and prices.' : 'Ask your administrator to switch on AI to have replies written from your website and prices.'}</div>`;

    main.innerHTML = `
      ${opts.header || ''}
      <form class="settings" id="sf" autocomplete="off">
        <nav aria-label="Settings sections">
          <a href="#s-mail" data-jump>1. Enquiries mailbox ${connected ? `<span class="tick">${ICONS.check}</span>` : ''}</a>
          <a href="#s-about" data-jump>2. About the business</a>
          <a href="#s-knowledge" data-jump>3. Website knowledge ${k.profile ? `<span class="tick">${ICONS.check}</span>` : ''}</a>
          <a href="#s-prices" data-jump>4. Prices ${k.prices.length ? `<span class="tick">${ICONS.check}</span>` : ''}</a>
          <a href="#s-auto" data-jump>5. Autopilot</a>
          <a href="#s-test" data-jump>6. Try it out</a>
          <a href="#s-scoring" data-jump>Lead scoring</a>
          <a href="#s-basics" data-jump>Dashboard &amp; login</a>
          <a href="#s-forward" data-jump>Web forms &amp; forwarding</a>
          ${admin ? '<a href="#s-data" data-jump>Data</a>' : ''}
        </nav>
        <div>
          <section class="card" id="s-mail">
            <h2>1. Enquiries mailbox</h2>
            <p class="lead">The dedicated email address enquiries go to. Enter the address and its password — the server settings are found automatically and both receiving and sending are tested.</p>
            <div id="mailStatus">${inboxStatus(b)}</div>
            <div id="mailConnect" class="${connected ? 'hidden' : ''}">
              <div class="two">
                <div class="field"><label for="mEmail">Email address</label><input id="mEmail" type="email" value="${esc(ib.email || ib.user)}" placeholder="enquiries@yourbusiness.co.uk"></div>
                <div class="field"><label for="mPass">Password</label><input id="mPass" type="password" placeholder="Mailbox password or app password"></div>
              </div>
              <button type="button" class="primary" id="mConnect">Connect mailbox</button>
              <div id="mResult"></div>
            </div>
            <details style="margin-top:14px">
              <summary style="cursor:pointer" class="muted">Enter server settings manually</summary>
              <div style="margin-top:12px">
                <div class="three">
                  <div class="field" style="grid-column:span 2"><label for="ibHost">Incoming (IMAP) server</label><input id="ibHost" value="${esc(ib.host)}" placeholder="imap.example.com"></div>
                  <div class="field"><label for="ibPort">Port</label><input id="ibPort" type="number" value="${ib.port}"></div>
                  <div class="field" style="grid-column:span 2"><label for="smHost">Outgoing (SMTP) server</label><input id="smHost" value="${esc(ib.smtpHost)}" placeholder="smtp.example.com"></div>
                  <div class="field"><label for="smPort">Port</label><input id="smPort" type="number" value="${ib.smtpPort}"></div>
                </div>
                <div class="two">
                  <div class="field"><label for="ibUser">Username</label><input id="ibUser" value="${esc(ib.user)}"></div>
                  <div class="field"><label for="ibPass">Password</label><input id="ibPass" type="password" value="${esc(ib.password)}"></div>
                  <div class="field"><label for="ibFolder">Enquiries folder</label><input id="ibFolder" value="${esc(ib.folder)}"></div>
                  <div class="field"><label for="ibSent">Sent folder</label><input id="ibSent" value="${esc(ib.sentFolder)}"><div class="hint">Lets the dashboard notice replies sent from the normal email app.</div></div>
                  <div class="field"><label for="ibPoll">Check every (minutes)</label><input id="ibPoll" type="number" min="1" value="${ib.pollMinutes}"></div>
                  <div class="inline" style="align-self:center">
                    <label><input type="checkbox" id="ibEnabled" ${ib.enabled ? 'checked' : ''}> Check automatically</label>
                    <label><input type="checkbox" id="ibSecure" ${ib.secure ? 'checked' : ''}> IMAP SSL</label>
                    <label><input type="checkbox" id="smSecure" ${ib.smtpSecure ? 'checked' : ''}> SMTP SSL</label>
                  </div>
                </div>
                <button type="button" id="testBtn">Test incoming connection</button>
                <div class="result" id="ibResult"></div>
              </div>
            </details>
          </section>

          <section class="card" id="s-about">
            <h2>2. About the business</h2>
            <p class="lead">Used in every reply.</p>
            <div class="two">
              <div class="field"><label for="iPhone">Phone number for customers</label><input id="iPhone" value="${esc(info.phone)}" placeholder="0113 496 0000"></div>
              <div class="field"><label for="iHours">Opening hours</label><input id="iHours" value="${esc(info.hours)}" placeholder="Mon–Fri 9am–5pm"></div>
              <div class="field"><label for="iTone">Tone of replies</label>
                <select id="iTone">${[['friendly', 'Friendly & warm'], ['professional', 'Professional'], ['casual', 'Relaxed & casual']].map(([v, l]) => `<option value="${v}" ${info.tone === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
              </div>
              <div class="field"><label for="iTz">Time zone</label>
                <select id="iTz">${[...new Set([info.timezone, ...TIMEZONES])].map((t) => `<option ${t === info.timezone ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
              </div>
            </div>
            <div class="field"><label for="iSig">Email signature</label><textarea id="iSig" rows="3" placeholder="Sam&#10;Harbour Print Co · 0113 496 0000">${esc(info.signature)}</textarea></div>
            <div class="field"><label for="iExtra">Anything else the AI should know or always do</label><textarea id="iExtra" rows="3" placeholder="e.g. We don't do same-day jobs. Always mention free delivery over £50. Never offer discounts.">${esc(info.extraInstructions)}</textarea></div>
          </section>

          <section class="card" id="s-knowledge">
            <h2>3. Website knowledge</h2>
            <p class="lead">Read the business's website so replies know what it sells, where it works and how. You can edit what it learned.</p>
            <div class="field"><label for="kSite">Website</label><input id="kSite" value="${esc(info.website)}" placeholder="yourbusiness.co.uk"></div>
            <div class="radio-cards">
              ${radio('kMode', 'home', k.crawlMode, 'Homepage only', 'Quickest — fine for one-page sites')}
              ${radio('kMode', 'site', k.crawlMode, 'Whole website', 'Follows links, prices &amp; services first')}
              ${radio('kMode', 'pages', k.crawlMode, 'Just these pages', 'You list the pages to read')}
            </div>
            <div class="field ${k.crawlMode === 'pages' ? '' : 'hidden'}" id="kPagesWrap"><label for="kPages">Pages to read (one per line)</label><textarea id="kPages" rows="4" placeholder="yourbusiness.co.uk/prices&#10;yourbusiness.co.uk/services">${esc(lines(k.pages))}</textarea></div>
            <div class="field ${k.crawlMode === 'site' ? '' : 'hidden'}" id="kMaxWrap" style="max-width:220px"><label for="kMax">Read up to (pages)</label><input id="kMax" type="number" min="1" max="60" value="${k.maxPages}"></div>
            <button type="button" class="primary" id="kRead">Read website</button>
            <span class="muted" style="margin-left:8px;font-size:12px" id="kBuilt">${k.builtAt ? `Last read ${timeAgo(k.builtAt)}` : ''}</span>
            <div id="kProgress"></div>
            <div class="field" style="margin-top:16px"><label for="kProfile">What the business does</label><textarea id="kProfile" rows="12" placeholder="${aiOn ? 'Read the website and the AI writes this for you. Or type it yourself.' : 'Describe the business, its products and services, delivery, areas covered, policies…'}">${esc(k.profile)}</textarea></div>
            <div class="field"><label for="kFaqs">Common questions &amp; answers</label><textarea id="kFaqs" rows="6" placeholder="Q: Do you deliver?&#10;A: Yes, free over £50 within Leeds.">${esc(k.faqs)}</textarea></div>
          </section>

          <section class="card" id="s-prices">
            <div class="card-head" style="margin-bottom:4px"><h2>4. Prices</h2><span class="muted" id="priceCount"></span></div>
            <p class="lead">So replies can answer "how much are 500 business cards?" straight away. Replies only ever quote prices from this list or the website.</p>
            <div id="suggested"></div>
            <table class="prices"><thead><tr><th>Product or service</th><th>Price</th><th>Notes (quantity, options…)</th><th></th></tr></thead>
              <tbody id="priceRows">${(k.prices.length ? k.prices : [{}]).map(priceRow).join('')}</tbody></table>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
              <button type="button" id="addRow">+ Add item</button>
              <button type="button" id="pasteBtn">Paste from a spreadsheet</button>
            </div>
            <div class="hidden" id="pasteWrap" style="margin-top:10px">
              <textarea id="pasteBox" rows="5" placeholder="Copy rows from Excel or Google Sheets and paste here: product, price, notes"></textarea>
              <button type="button" id="pasteAdd" style="margin-top:6px">Add these rows</button>
            </div>
          </section>

          <section class="card" id="s-auto">
            <h2>5. Autopilot</h2>
            <p class="lead">Take the repetitive emails off your plate. Start with drafts, then switch to automatic once the drafts look right.</p>

            <div class="auto-card">
              <h3>Reply to new enquiries</h3>
              <p>A reply to every new enquiry, answering their question using the business's knowledge and prices.</p>
              <div class="inline">${modeRadios('rMode', au.reply.mode)}</div>
              <div class="auto-body" id="rBody">
                <div class="inline">
                  <span class="ink-2">Who gets it:</span>
                  <label><input type="radio" name="rWho" value="all" ${au.reply.who === 'all' ? 'checked' : ''}> Every new enquiry</label>
                  <label><input type="radio" name="rWho" value="no-phone" ${au.reply.who === 'no-phone' ? 'checked' : ''}> Only people who didn't leave a phone number</label>
                </div>
                <div class="inline">
                  <span class="ink-2">Written:</span>
                  <label><input type="radio" name="rWriter" value="ai" ${au.reply.writer === 'ai' ? 'checked' : ''}> By AI, answering their question</label>
                  <label><input type="radio" name="rWriter" value="template" ${au.reply.writer === 'template' ? 'checked' : ''}> From my template</label>
                </div>
                <label class="chk field"><input type="checkbox" id="rAskPhone" ${au.reply.askPhone ? 'checked' : ''}> If they didn't leave a phone number, ask for one (or invite them to call)</label>
                <div class="field" id="rPhoneAskWrap"><label for="rPhoneAsk">How to ask for their number</label><textarea id="rPhoneAsk" rows="2">${esc(au.reply.phoneAsk)}</textarea></div>
                <div class="field" id="rTplWrap"><label for="rTpl">Template</label><textarea id="rTpl" rows="7">${esc(au.reply.template)}</textarea>
                  <div class="vars">Fills in: <code>{first_name}</code> <code>{business_name}</code> <code>{business_phone}</code> <code>{phone_ask}</code> <code>{signature}</code>. Also used if the AI is ever unavailable.</div></div>
                <div class="field" style="max-width:260px" id="rDelayWrap"><label for="rDelay">Wait before sending (minutes)</label><input id="rDelay" type="number" min="0" value="${au.reply.delayMinutes}"><div class="hint">A short pause feels more natural.</div></div>
              </div>
            </div>

            <div class="auto-card">
              <h3>Chase for a phone number</h3>
              <p>For customers who didn't leave a phone number and haven't replied to your first email. Each chaser mentions when they got in touch ("yesterday", "on Monday") so it reads naturally. Stops as soon as they reply or give a number. These customers get this instead of the normal follow-ups below.</p>
              <div class="inline">${modeRadios('pMode', au.phoneChase.mode)}</div>
              <div class="auto-body" id="pBody">
                <div class="two">
                  <div class="field"><label for="pDays">Send chasers after (days)</label><input id="pDays" value="${esc((au.phoneChase.days || []).join(', '))}"><div class="hint">Days after the previous email. "1, 1" = the next day, then the day after that.</div></div>
                  <div class="field"><label for="pAt">Send at</label><input id="pAt" type="time" value="${esc(au.phoneChase.sendAt)}"><div class="hint">In the business's time zone.</div></div>
                </div>
                <label class="chk field"><input type="checkbox" id="pWeek" ${au.phoneChase.weekLater ? 'checked' : ''}> Send one more a week later</label>
                <div class="help" id="pSummary" style="background:var(--cold-wash);color:var(--cold-ink);margin:0 0 12px"></div>
                <div class="inline">
                  <span class="ink-2">Written:</span>
                  <label><input type="radio" name="pWriter" value="ai" ${au.phoneChase.writer === 'ai' ? 'checked' : ''}> By AI, based on the conversation</label>
                  <label><input type="radio" name="pWriter" value="template" ${au.phoneChase.writer === 'template' ? 'checked' : ''}> From my templates</label>
                </div>
                <div class="field" id="pTplWrap"><label for="pTpl">Chaser templates, in order (separate each one with a line containing ---)</label><textarea id="pTpl" rows="9">${esc((au.phoneChase.templates || []).join('\n---\n'))}</textarea>
                  <div class="vars"><code>{enquiry_day}</code> becomes "yesterday", "on Monday" or "on Monday 6 October". Also: <code>{first_name}</code> <code>{business_phone}</code> <code>{signature}</code>.</div></div>
              </div>
            </div>

            <div class="auto-card">
              <h3>Follow up when they go quiet</h3>
              <p>If the customer hasn't replied, check in. Stops as soon as they reply, or when the enquiry is marked won or lost.</p>
              <div class="inline">${modeRadios('fMode', au.followUp.mode)}</div>
              <div class="auto-body" id="fBody">
                <div class="two">
                  <div class="field"><label for="fDays">Follow up after (days)</label><input id="fDays" value="${esc((au.followUp.days || []).join(', '))}"><div class="hint">e.g. "3, 7" = after 3 days of silence, then 7 days after that.</div></div>
                  <div class="field"><label for="fAt">Send at</label><input id="fAt" type="time" value="${esc(au.followUp.sendAt)}"><div class="hint">In the business's time zone.</div></div>
                </div>
                <div class="inline">
                  <span class="ink-2">Written:</span>
                  <label><input type="radio" name="fWriter" value="ai" ${au.followUp.writer === 'ai' ? 'checked' : ''}> By AI, based on the conversation</label>
                  <label><input type="radio" name="fWriter" value="template" ${au.followUp.writer === 'template' ? 'checked' : ''}> From my templates</label>
                </div>
                <div class="field" id="fTplWrap"><label for="fTpl">Follow-up templates (separate each one with a line containing ---)</label><textarea id="fTpl" rows="8">${esc((au.followUp.templates || []).join('\n---\n'))}</textarea></div>
              </div>
            </div>

            <div class="auto-card">
              <h3>Hot lead alerts</h3>
              <p>Get an email the moment a hot enquiry lands, with a one-line summary and a link straight to it.</p>
              <label class="chk field"><input type="checkbox" id="alOn" ${au.alerts.enabled ? 'checked' : ''}> Email me about new enquiries</label>
              <div class="two">
                <div class="field"><label for="alEmail">Send alerts to</label><input id="alEmail" type="email" value="${esc(au.alerts.email)}" placeholder="owner@gmail.com"></div>
                <div class="inline" style="align-self:center"><label><input type="checkbox" id="alHot" ${au.alerts.onlyHot ? 'checked' : ''}> Only hot leads</label></div>
              </div>
            </div>

            <div class="auto-card">
              <h3>AI sorting</h3>
              <p>AI reads each enquiry: writes a one-line summary, picks out what they want, the deadline and budget, files junk away, and judges hot, warm or cold.</p>
              <label class="chk"><input type="checkbox" id="aiSort" ${au.ai.enabled ? 'checked' : ''}> Let AI read and sort enquiries ${aiOn ? '' : '<span class="muted">(needs AI to be switched on)</span>'}</label>
            </div>
          </section>

          <section class="card" id="s-test">
            <h2>6. Try it out</h2>
            <p class="lead">Type an enquiry as a customer would and see the reply the autopilot would write. Your changes are saved first.</p>
            <div class="field"><label for="tMsg">Customer's email</label><textarea id="tMsg" rows="4">Hi, how much would 500 business cards be? Need them by Friday if possible.</textarea></div>
            <div class="inline"><label><input type="checkbox" id="tPhone"> They included a phone number</label></div>
            <button type="button" id="tRun">Write a test reply</button>
            ${aiOffNote}
            <div id="tOut"></div>
          </section>

          <section class="card" id="s-scoring">
            <h2>Lead scoring</h2>
            <p class="lead">${aiOn && au.ai.enabled ? 'AI judges hot, warm and cold. The rules below are the backup and are shown as signals.' : 'Every enquiry gets a score out of 100 from what it says. These rules decide where hot, warm and cold begin.'} Saving re-scores existing enquiries.</p>
            <div class="auto-card" style="border-left:4px solid var(--hot)">
              <h3><span style="display:inline-block;width:16px;height:16px;color:var(--hot);vertical-align:-2px">${ICONS.hot}</span> Always-hot words &amp; phrases</h3>
              <p>If an email contains enough of these, it goes straight into Hot — whatever else it says.</p>
              <div class="two">
                <div class="field"><label for="hotTerms">Words and phrases (one per line)</label><textarea id="hotTerms" rows="5" placeholder="price&#10;quote&#10;deposit&#10;book in&#10;this week">${esc(lines(sc.hotTerms))}</textarea></div>
                <div class="field"><label for="hotMin">How many must appear</label>
                  <select id="hotMin">${[1, 2, 3].map((x) => `<option value="${x}" ${Number(sc.hotMinMatches) === x ? 'selected' : ''}>${x === 1 ? 'Any 1' : `Any ${x} different ones`}</option>`).join('')}</select>
                  <div class="hint">e.g. with 2: "price" and "this week" in the same email = Hot. A word inside a longer phrase on the list only counts once.</div>
                </div>
              </div>
            </div>
            <div class="three">
              <div class="field"><label for="hotT">Hot from score</label><input id="hotT" type="number" min="1" max="100" value="${sc.hotThreshold}"></div>
              <div class="field"><label for="warmT">Warm from score</label><input id="warmT" type="number" min="0" max="100" value="${sc.warmThreshold}"></div>
              <div class="field"><label for="minBudget">Minimum budget</label><input id="minBudget" type="number" min="0" value="${sc.minBudget}"><div class="hint">Lower budgets reduce the score. 0 = off.</div></div>
            </div>
            <div class="field"><div class="thresholds" id="thBar"></div><div class="hint" id="thHint"></div></div>
            <div class="field" style="max-width:120px"><label for="currency">Currency symbol</label><input id="currency" value="${esc(sc.currency)}" maxlength="3"></div>
            <details><summary style="cursor:pointer" class="muted">Word lists</summary>
              <div class="two" style="margin-top:12px">
                ${LIST_FIELDS.map(([key, label, hint]) => `<div class="field"><label for="l_${key}">${label}</label><textarea id="l_${key}" rows="5">${esc(lines(sc[key]))}</textarea><div class="hint">${hint}. One per line.</div></div>`).join('')}
              </div>
            </details>
          </section>

          <section class="card" id="s-basics">
            <h2>Dashboard &amp; login</h2>
            <p class="lead">How the dashboard looks and how it's opened.</p>
            <div class="two">
              <div class="field"><label for="name">Business name</label><input id="name" value="${esc(b.name)}" required></div>
              <div class="field"><label for="slug">Dashboard address</label>
                ${admin ? `<input id="slug" value="${esc(b.slug)}">` : `<input id="slug" value="${esc(b.slug)}" disabled>`}
                <div class="hint">${esc(location.origin)}/b/<b>${esc(b.slug)}</b></div></div>
              <div class="field"><label for="color">Brand colour</label><input id="color" type="color" value="${esc(b.brandColor)}" style="height:38px;padding:3px"></div>
              <div class="field"><label for="code">New access code</label>
                <div style="display:flex;gap:6px"><input id="code" placeholder="${b.hasAccessCode ? 'Leave blank to keep the current code' : 'Set a code'}"><button type="button" id="genCode">Generate</button></div>
              </div>
              <div class="field"><label for="target">Reply target (hours)</label><input id="target" type="number" min="0.25" step="0.25" value="${s.responseTargetHours}"><div class="hint">Enquiries waiting longer are flagged as overdue.</div></div>
            </div>
          </section>

          <section class="card" id="s-forward">
            <h2>Web forms &amp; forwarding</h2>
            <p class="lead">Website contact forms (and forwarding services like Zapier or Postmark) can post enquiries straight in, no mailbox needed.</p>
            <div class="field"><label>Inbound address</label><pre id="hookUrl">${esc(hook)}</pre>
              <div style="display:flex;gap:8px"><button type="button" id="copyHook">Copy</button><button type="button" id="rotate">Generate new address</button></div>
            </div>
            <details><summary style="cursor:pointer">Website contact form example</summary>
<pre>&lt;form action="${esc(hook)}" method="post"&gt;
  &lt;input name="name" placeholder="Your name"&gt;
  &lt;input name="email" type="email" required&gt;
  &lt;input name="phone"&gt;
  &lt;textarea name="message"&gt;&lt;/textarea&gt;
  &lt;input type="hidden" name="_redirect" value="https://your-site.co.uk/thank-you"&gt;
  &lt;button&gt;Send&lt;/button&gt;
&lt;/form&gt;</pre></details>
          </section>

          ${admin ? `<section class="card" id="s-data">
            <h2>Data</h2>
            <p class="lead">Sample data is handy for demos. Clear it before connecting the real mailbox.</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" id="demoBtn">Load sample enquiries</button>
              <button type="button" id="clearBtn">Clear all enquiries</button>
              <button type="button" class="danger" id="deleteBtn">Delete business</button>
            </div>
          </section>` : ''}

          <div class="savebar">
            <span class="err" id="sErr" style="margin:auto auto auto 0"></span>
            <button type="submit" class="primary">Save changes</button>
          </div>
        </div>
      </form>`;

    wire(b, opts);
  }

  function wire(b, opts) {
    const s = b.settings;
    const call = opts.call;
    const base = opts.base;
    const aiOn = Boolean(opts.aiConfigured);
    updatePriceCount();
    $$('[data-open-ai]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); opts.onOpenAI?.(); }));

    // Show only what's relevant to the chosen options.
    const sync = () => {
      $('#rBody').classList.toggle('hidden', val('rMode') === 'off');
      $('#pBody').classList.toggle('hidden', val('pMode') === 'off');
      $('#fBody').classList.toggle('hidden', val('fMode') === 'off');
      $('#rTplWrap').style.opacity = val('rWriter') === 'template' ? 1 : 0.6;
      $('#rPhoneAskWrap').classList.toggle('hidden', !$('#rAskPhone').checked || val('rWriter') === 'ai');
      $('#rDelayWrap').classList.toggle('hidden', val('rMode') !== 'auto');
      $('#pTplWrap').style.opacity = val('pWriter') === 'template' ? 1 : 0.6;
      $('#fTplWrap').style.opacity = val('fWriter') === 'template' ? 1 : 0.6;
      $('#kPagesWrap').classList.toggle('hidden', val('kMode') !== 'pages');
      $('#kMaxWrap').classList.toggle('hidden', val('kMode') !== 'site');
      $('#pSummary').textContent = chaseSummary(numbers($('#pDays').value), $('#pWeek').checked);
    };
    $('#sf').addEventListener('change', sync);
    $('#pDays').addEventListener('input', sync);
    sync();

    const drawThresholds = () => {
      const hot = Number($('#hotT').value) || 0;
      const warm = Number($('#warmT').value) || 0;
      $('#thBar').innerHTML = `<span style="flex:${Math.max(0, warm)};background:var(--cold)"></span><span style="flex:${Math.max(0, hot - warm)};background:var(--warm)"></span><span style="flex:${Math.max(0, 100 - hot)};background:var(--hot)"></span>`;
      $('#thHint').textContent = `Cold 0–${Math.max(0, warm - 1)} · Warm ${warm}–${Math.max(warm, hot - 1)} · Hot ${hot}–100`;
    };
    drawThresholds();
    ['#hotT', '#warmT'].forEach((sel) => $(sel).addEventListener('input', drawThresholds));

    $$('[data-jump]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); $(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth' }); }));

    // --- Mailbox
    const wireMailStatus = () => {
      $('#changeMail')?.addEventListener('click', () => { $('#mailConnect').classList.remove('hidden'); $('#mPass').focus(); });
      $('#syncBtn')?.addEventListener('click', async (ev) => {
        ev.target.disabled = true; ev.target.textContent = 'Checking…';
        try {
          const r = await call(`${base}/sync`, { method: 'POST' });
          toast(`${r.created || 0} new enquiries, ${r.appended || 0} follow-ups, ${r.replies || 0} replies found`);
        } catch (err) { toast(err.message); }
        const fresh = await call(base);
        $('#mailStatus').innerHTML = inboxStatus(fresh);
        wireMailStatus();
      });
    };
    wireMailStatus();

    $('#mConnect').addEventListener('click', async () => {
      const btn = $('#mConnect');
      const out = $('#mResult');
      btn.disabled = true; btn.textContent = 'Connecting… (up to a minute)';
      out.innerHTML = '<div class="result muted">Looking up the mail servers and signing in…</div>';
      try {
        const res = await fetch(`${base}/connect-email`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ email: $('#mEmail').value, password: $('#mPass').value }),
        });
        const r = await res.json();
        const steps = (r.steps || []).length ? `<ul class="steps">${r.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
        if (!res.ok || !r.ok) {
          out.innerHTML = `<div class="result status-critical">${ICONS.alert} ${esc(r.error || 'Could not connect')}</div>${r.help ? `<div class="help">${esc(r.help)}</div>` : ''}${steps}`;
          return;
        }
        out.innerHTML = '';
        $('#mPass').value = '';
        $('#mailConnect').classList.add('hidden');
        const fresh = await call(base);
        $('#mailStatus').innerHTML = `${inboxStatus(fresh)}${steps}<div class="result ok">${ICONS.check} Connected to ${esc(r.providerName)}. Recent emails are being imported now (no automatic replies are sent to old emails).</div>`;
        wireMailStatus();
        $('#ibHost').value = r.inbox.host; $('#ibPort').value = r.inbox.port; $('#ibUser').value = r.inbox.user;
        $('#smHost').value = r.inbox.smtpHost; $('#smPort').value = r.inbox.smtpPort; $('#ibSent').value = r.inbox.sentFolder;
        $('#ibSecure').checked = r.inbox.secure; $('#smSecure').checked = r.inbox.smtpSecure; $('#ibEnabled').checked = true; $('#ibPass').value = '********';
      } catch (err) {
        out.innerHTML = `<div class="result status-critical">${esc(err.message)}</div>`;
      } finally {
        btn.disabled = false; btn.textContent = 'Connect mailbox';
      }
    });

    $('#testBtn').addEventListener('click', async () => {
      const out = $('#ibResult');
      out.innerHTML = '<span class="muted">Connecting…</span>';
      try {
        const r = await call(`${base}/test-inbox`, { method: 'POST', body: { inbox: inboxValues() } });
        out.innerHTML = `<span class="ok">${ICONS.check} Connected.</span> <span class="muted">Folders: ${esc(r.folders.slice(0, 12).join(', '))}${r.folders.length > 12 ? '…' : ''}</span>`;
      } catch (err) { out.innerHTML = `<span class="status-critical">${ICONS.alert} ${esc(err.message)}</span>`; }
    });

    // --- Website knowledge
    $('#kRead').addEventListener('click', async () => {
      const btn = $('#kRead');
      const prog = $('#kProgress');
      btn.disabled = true; btn.textContent = 'Reading…';
      prog.innerHTML = '<div class="log" id="kLog">Starting…</div>';
      try {
        const { jobId } = await call(`${base}/website/read`, {
          method: 'POST',
          body: { mode: val('kMode'), website: $('#kSite').value.trim(), pages: fromLines($('#kPages').value), maxPages: Number($('#kMax').value) || 20 },
        });
        let job;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1200));
          job = await call(`${base}/jobs/${jobId}`);
          $('#kLog').innerHTML = job.log.slice(-40).map(esc).join('<br>');
          $('#kLog').scrollTop = 1e6;
          if (job.status !== 'running') break;
        }
        if (job.status === 'error') throw new Error(job.error);
        const r = job.result;
        if (r.aiUsed) {
          $('#kProfile').value = r.knowledge.profile;
          if (!$('#kFaqs').value.trim()) $('#kFaqs').value = r.knowledge.faqs;
          if (!readPrices().length) addPrices(r.knowledge.prices);
        }
        if (r.suggestedPrices?.length) {
          $('#suggested').innerHTML = `<div class="banner" style="background:var(--cold-wash);color:var(--cold-ink)">Found ${r.suggestedPrices.length} prices on the website. <button type="button" id="addSuggested" style="margin-left:auto">Add any new ones</button></div>`;
          $('#addSuggested').addEventListener('click', () => { addPrices(r.suggestedPrices); $('#suggested').innerHTML = ''; toast('Prices added — remember to save'); });
        }
        prog.innerHTML = `<div class="result ok">${ICONS.check} Read ${r.pages.length} page${r.pages.length === 1 ? '' : 's'}${r.aiUsed ? ' and wrote the business profile below. Check it over and edit anything that\'s wrong.' : '. With AI switched on, the profile is written automatically — or write it below.'}</div>
          <details style="margin-top:6px"><summary class="muted" style="cursor:pointer">Pages read</summary><ul class="steps">${r.pages.map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title || p.url)}</a> <span class="muted">${esc(p.url)}</span></li>`).join('')}</ul>
          ${r.errors.length ? `<div class="muted" style="font-size:12px;margin-top:6px">Skipped: ${r.errors.map(esc).join('; ')}</div>` : ''}</details>`;
        $('#kBuilt').textContent = 'Just now';
      } catch (err) {
        prog.innerHTML = `<div class="result status-critical">${ICONS.alert} ${esc(err.message)}</div>`;
      } finally {
        btn.disabled = false; btn.textContent = 'Read website';
      }
    });

    // --- Prices
    const rows = $('#priceRows');
    rows.addEventListener('click', (ev) => { if (ev.target.closest('[data-del]')) { ev.target.closest('tr').remove(); if (!rows.children.length) rows.insertAdjacentHTML('beforeend', priceRow()); updatePriceCount(); } });
    rows.addEventListener('input', updatePriceCount);
    $('#addRow').addEventListener('click', () => { rows.insertAdjacentHTML('beforeend', priceRow()); rows.lastElementChild.querySelector('input').focus(); });
    $('#pasteBtn').addEventListener('click', () => { $('#pasteWrap').classList.toggle('hidden'); $('#pasteBox').focus(); });
    $('#pasteAdd').addEventListener('click', () => {
      const parsed = $('#pasteBox').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const cells = l.includes('\t') ? l.split('\t') : l.split(/\s*[,;|]\s*/);
        return { item: (cells[0] || '').trim(), price: (cells[1] || '').trim(), notes: cells.slice(2).join(', ').trim() };
      }).filter((p) => p.item);
      addPrices(parsed);
      $('#pasteBox').value = '';
      $('#pasteWrap').classList.add('hidden');
      toast(`Added ${parsed.length} rows — remember to save`);
    });

    // --- Test reply
    $('#tRun').addEventListener('click', async () => {
      const out = $('#tOut');
      const btn = $('#tRun');
      if (!aiOn) {
        const vars = { first_name: 'Alex', business_name: $('#name').value, business_phone: $('#iPhone').value || 'us', signature: $('#iSig').value || `The ${$('#name').value} team` };
        vars.phone_ask = $('#rAskPhone').checked && !$('#tPhone').checked ? fillVars($('#rPhoneAsk').value, vars) : '';
        out.innerHTML = `<div class="test-out">${esc(fillVars($('#rTpl').value, vars))}</div>`;
        return;
      }
      btn.disabled = true; btn.textContent = 'Writing…';
      out.innerHTML = '';
      try {
        await save(false);
        const d = await call(`${base}/test-reply`, { method: 'POST', body: { message: $('#tMsg').value, hasPhone: $('#tPhone').checked } });
        out.innerHTML = `<div class="test-out"><b>${esc(d.subject)}</b>\n\n${esc(d.body)}</div>`;
      } catch (err) {
        out.innerHTML = `<div class="result status-critical">${esc(err.message)}</div>`;
      } finally { btn.disabled = false; btn.textContent = 'Write a test reply'; }
    });

    // --- Basics, forwarding, data
    $('#genCode').addEventListener('click', () => {
      const words = 'amber,birch,cedar,delta,ember,fable,grove,harbor,ivory,juniper,kestrel,lumen,maple,north,orchid,pebble,quartz,river,sage,tidal'.split(',');
      const r = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
      $('#code').value = `${words[r(words.length)]}-${words[r(words.length)]}-${100 + r(900)}`;
    });
    $('#copyHook').addEventListener('click', () => { navigator.clipboard?.writeText($('#hookUrl').textContent); toast('Copied'); });
    $('#rotate').addEventListener('click', async () => {
      if (!confirm('Anything using the current address (forwarding rules, website forms) will stop working until updated. Continue?')) return;
      const r = await call(`${base}/rotate-token`, { method: 'POST' });
      $('#hookUrl').textContent = `${location.origin}/api/inbound/${r.inboundToken}`;
      toast('New address created');
    });
    opts.wireData?.(b);

    function inboxValues() {
      return {
        enabled: $('#ibEnabled').checked, host: $('#ibHost').value.trim(), port: Number($('#ibPort').value) || 993,
        secure: $('#ibSecure').checked, user: $('#ibUser').value.trim(), password: $('#ibPass').value,
        smtpHost: $('#smHost').value.trim(), smtpPort: Number($('#smPort').value) || 465, smtpSecure: $('#smSecure').checked,
        folder: $('#ibFolder').value.trim() || 'INBOX', sentFolder: $('#ibSent').value.trim(), pollMinutes: Number($('#ibPoll').value) || 5,
        email: s.inbox.email || $('#ibUser').value.trim(),
      };
    }

    const templatesFrom = (sel) => $(sel).value.split(/\n-{3,}\n/).map((t) => t.trim()).filter(Boolean);

    async function save(rescore = true) {
      const body = {
        name: $('#name').value, brandColor: $('#color').value, rescore,
        settings: {
          responseTargetHours: Number($('#target').value),
          inbox: inboxValues(),
          info: {
            phone: $('#iPhone').value.trim(), hours: $('#iHours').value.trim(), tone: $('#iTone').value, timezone: $('#iTz').value,
            signature: $('#iSig').value.trim(), extraInstructions: $('#iExtra').value.trim(), website: $('#kSite').value.trim(),
          },
          knowledge: {
            crawlMode: val('kMode'), pages: fromLines($('#kPages').value), maxPages: Number($('#kMax').value) || 20,
            profile: $('#kProfile').value.trim(), faqs: $('#kFaqs').value.trim(), prices: readPrices(),
          },
          automations: {
            ai: { enabled: $('#aiSort').checked },
            reply: {
              mode: val('rMode'), who: val('rWho'), writer: val('rWriter'), askPhone: $('#rAskPhone').checked,
              phoneAsk: $('#rPhoneAsk').value.trim(), template: $('#rTpl').value.trim(), delayMinutes: Number($('#rDelay').value) || 0,
            },
            phoneChase: {
              mode: val('pMode'), writer: val('pWriter'), sendAt: $('#pAt').value || '09:30',
              days: numbers($('#pDays').value), weekLater: $('#pWeek').checked, templates: templatesFrom('#pTpl'),
            },
            followUp: {
              mode: val('fMode'), writer: val('fWriter'), sendAt: $('#fAt').value || '09:30',
              days: numbers($('#fDays').value), templates: templatesFrom('#fTpl'),
            },
            alerts: { enabled: $('#alOn').checked, email: $('#alEmail').value.trim(), onlyHot: $('#alHot').checked },
          },
          scoring: {
            hotTerms: fromLines($('#hotTerms').value), hotMinMatches: Number($('#hotMin').value) || 2,
            hotThreshold: Number($('#hotT').value), warmThreshold: Number($('#warmT').value),
            minBudget: Number($('#minBudget').value) || 0, currency: $('#currency').value,
            ...Object.fromEntries(LIST_FIELDS.map(([key]) => [key, fromLines($(`#l_${key}`).value)])),
          },
        },
      };
      if (opts.admin) body.slug = $('#slug').value;
      const code = $('#code').value.trim();
      if (code) body.accessCode = code;
      const updated = await call(base, { method: 'PUT', body });
      if (code) { opts.onCodeChanged?.(updated.name, updated.slug, code); $('#code').value = ''; }
      return updated;
    }

    $('#sf').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      $('#sErr').textContent = '';
      if (Number($('#warmT').value) >= Number($('#hotT').value)) { $('#sErr').textContent = 'Warm must start below hot.'; return; }
      if ($('#alOn').checked && !$('#alEmail').value.trim()) { $('#sErr').textContent = 'Add an email address for alerts.'; return; }
      if (val('pMode') !== 'off' && !numbers($('#pDays').value).length && !$('#pWeek').checked) { $('#sErr').textContent = 'Add the days for the phone-number chasers.'; return; }
      try {
        const updated = await save();
        toast('Saved');
        opts.onSaved?.(updated);
      } catch (err) { $('#sErr').textContent = err.message; }
    });
  }

  return { render, chaseSummary };
})();
