// Site Audit app: start an audit, follow it step by step, open the result and past reports.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

const band = (v) => (v == null ? 'na' : v >= 90 ? 'good' : v >= 50 ? 'fair' : 'poor');
const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const pathOf = (url) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };
const dateText = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const duration = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

// ---------------------------------------------------------------- views
const VIEWS = ['form', 'run', 'done', 'failed'];
let currentView = null;
function show(view) {
  if (view === currentView) return;
  currentView = view;
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  if (!reduceMotion) $(`#view-${view}`).animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
}

// ---------------------------------------------------------------- progress
// The audit prints one line per stage; each maps to a step in the list.
const STEP_WEIGHT = { site: 5, crawl: 35, links: 12, lh: 30, report: 4, pdf: 14 };
let run = null;   // { steps: {id: 'wait'|'active'|'done'}, crawl: [i, n], lh: [i, n], ... }

function resetRun(job) {
  run = { steps: {}, crawl: [0, job.pages], lh: [0, job.lighthouse], lhOn: job.lighthouse > 0, pdfOn: job.pdf, started: job.started };
  for (const li of document.querySelectorAll('#steps li')) {
    run.steps[li.dataset.step] = 'wait';
    li.className = '';
  }
  $('#steps [data-step="lh"]').hidden = !run.lhOn;
  $('#steps [data-step="pdf"]').hidden = !run.pdfOn;
  $('#steps [data-step="crawl"] .detail').textContent = `Up to ${plural(job.pages, 'page')}`;
  $('#steps [data-step="links"] .detail').textContent = '';
  $('#steps [data-step="report"] .detail').textContent = '';
  $('#log').textContent = '';
  $('#run-host').textContent = hostOf(job.url);
  document.title = `Checking ${hostOf(job.url)} · Site Audit`;
  setProgress();
}

function activate(id, detail) {
  const order = Object.keys(STEP_WEIGHT);
  for (const s of order.slice(0, order.indexOf(id))) if (run.steps[s] !== 'done') run.steps[s] = 'done';
  run.steps[id] = 'active';
  const li = $(`#steps [data-step="${id}"]`);
  if (detail != null) li.querySelector('.detail').textContent = detail;
  paintSteps();
}

let pulse = null;
function paintSteps() {
  for (const li of document.querySelectorAll('#steps li')) li.className = run.steps[li.dataset.step] === 'wait' ? '' : run.steps[li.dataset.step];
  // A soft pulse on the step that's working (skipped for reduced motion)
  const dot = $('#steps li.active .dot');
  if (pulse?.dot !== dot) {
    pulse?.anim.cancel();
    pulse = dot && !reduceMotion
      ? { dot, anim: dot.animate([{ boxShadow: '0 0 0 2px #FBEBDB' }, { boxShadow: '0 0 0 7px #FBEBDB' }, { boxShadow: '0 0 0 2px #FBEBDB' }], { duration: 1400, iterations: Infinity, easing: 'ease-in-out' }) }
      : null;
  }
  setProgress();
}

function setProgress() {
  let total = 0;
  let got = 0;
  for (const [id, w] of Object.entries(STEP_WEIGHT)) {
    if ((id === 'lh' && !run.lhOn) || (id === 'pdf' && !run.pdfOn)) continue;
    total += w;
    const st = run.steps[id];
    if (st === 'done') got += w;
    else if (st === 'active') {
      const frac = id === 'crawl' ? run.crawl[0] / Math.max(1, run.crawl[1])
        : id === 'lh' ? (run.lh[0] - 0.5) / Math.max(1, run.lh[1]) : 0.4;
      got += w * Math.min(0.95, Math.max(0.05, frac));
    }
  }
  const pct = Math.round((got / total) * 100);
  const fill = $('#progress-fill');
  const from = fill.style.width || '0%';
  fill.style.width = `${pct}%`;
  $('#progress').setAttribute('aria-valuenow', String(pct));
  if (!reduceMotion && from !== fill.style.width) fill.animate([{ width: from }, { width: `${pct}%` }], { duration: 400, easing: 'ease-out' });
}

function onLine(line) {
  const log = $('#log');
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent += line + '\n';
  if (atEnd) log.scrollTop = log.scrollHeight;
  if (!run) return;
  let m;
  if (/^Checking site-wide files/.test(line)) activate('site');
  else if ((m = line.match(/^Crawling up to (\d+) pages/))) { run.crawl = [0, +m[1]]; activate('crawl'); }
  else if ((m = line.match(/^\s+page (\d+)\/(\d+): (.+)$/))) { run.crawl = [+m[1], +m[2]]; activate('crawl', `Page ${m[1]} of up to ${m[2]}: ${pathOf(m[3])}`); }
  else if ((m = line.match(/^\s+checking (\d+) links and images/))) activate('links', `${plural(+m[1], 'link or image', 'links and images')}`);
  else if ((m = line.match(/^Lighthouse \(mobile\): (.+)$/))) { run.lh[0]++; activate('lh', `Page ${run.lh[0]} of ${run.lh[1]}: ${pathOf(m[1])}`); }
  else if (/^Writing the report/.test(line)) activate('report');
  else if (/^Writing the PDF/.test(line)) activate('pdf');
}

let ticker = null;
function startTicker(started) {
  clearInterval(ticker);
  const tick = () => { $('#elapsed').textContent = clock(Date.now() - started); };
  tick();
  ticker = setInterval(tick, 1000);
}

// ---------------------------------------------------------------- result
function ring(score, grade) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 128 128" role="img" aria-label="Overall score ${score} out of 100, grade ${esc(grade)}">
    <circle cx="64" cy="64" r="${r}" class="ring-track"/>
    <circle cx="64" cy="64" r="${r}" class="ring-fill ${band(score)}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - score / 100)).toFixed(1)}" transform="rotate(-90 64 64)"/>
    <text x="64" y="64" class="ring-grade">${esc(grade)}</text>
    <text x="64" y="88" class="ring-score">${score}/100</text>
  </svg>`;
}

let doneFolder = null;
function showDone(job) {
  const s = job.summary;
  doneFolder = s.folder;
  $('#done-ring').innerHTML = s.score != null ? ring(s.score, s.grade) : '';
  $('#done-host').textContent = s.host;
  const c = s.counts;
  const total = c ? c.high + c.medium + c.low : 0;
  $('#done-summary').textContent = !c ? 'The report is ready.'
    : total ? `${plural(total, 'thing')} to improve: ${c.high} to fix first, ${c.medium} to fix soon, ${c.low} nice to have.`
    : 'Nothing to fix. Every check passed.';
  const secs = job.ended && job.started ? Math.round((job.ended - job.started) / 1000) : null;
  $('#done-meta').textContent = [s.pages != null && `${plural(s.pages, 'page')} checked`, secs && `in ${duration(secs)}`].filter(Boolean).join(' ');
  $('#done-pdf').hidden = !s.hasPdf;
  // The most urgent findings, as a preview of the report
  const SEV = { high: 'Fix first', medium: 'Fix soon', low: 'Nice to have' };
  const top = (s.issues ?? []).slice(0, 5);
  $('#done-top').hidden = !top.length;
  $('#done-list').innerHTML = top.map((i) => `<li><span class="sev ${esc(i.severity)}">${SEV[i.severity] ?? ''}</span><span class="t">${esc(i.title)}</span><span class="a">${esc(i.area)}</span></li>`).join('');
  const rest = (s.issues ?? []).length - top.length;
  $('#done-more').textContent = rest > 0 ? `And ${plural(rest, 'more thing')} in the report.` : '';
  document.title = `${s.host}: ${s.grade ?? 'done'} · Site Audit`;
  show('done');
  const fill = document.querySelector('#done-ring .ring-fill');
  if (fill && !reduceMotion) {
    const to = fill.getAttribute('stroke-dashoffset');
    fill.animate([{ strokeDashoffset: fill.getAttribute('stroke-dasharray') }, { strokeDashoffset: to }], { duration: 900, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
}

// ---------------------------------------------------------------- state from the app
let lastJob = { status: 'idle' };
function onState(job) {
  const prev = lastJob;
  lastJob = job;
  clearInterval(ticker);
  if (job.status === 'running') {
    if (prev.status !== 'running' || prev.started !== job.started || !run) {
      resetRun(job);
      for (const l of job.lines ?? []) onLine(l);
    }
    $('#cancel').disabled = false;
    startTicker(job.started);
    show('run');
    return;
  }
  run = null;
  pulse?.anim.cancel();
  pulse = null;
  document.title = 'Site Audit';
  if (job.status === 'done') { showDone(job); loadReports(); return; }
  if (job.status === 'failed') {
    $('#fail-message').textContent = friendlyError(job.error);
    $('#fail-log').textContent = (job.lines ?? []).join('\n');
    show('failed');
    return;
  }
  if (job.status === 'cancelled') {
    $('#url').value = job.url ?? $('#url').value;
    note('Audit cancelled.');
  }
  show('form');
}

function friendlyError(msg = '') {
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED/.test(msg)) return 'That address could not be found. Check the spelling, or try it with or without "www".';
  if (/ECONNREFUSED|ERR_CONNECTION/.test(msg)) return 'The site refused the connection. It may be down right now.';
  if (/timed? ?out/i.test(msg)) return 'The site took too long to answer. Try again in a few minutes.';
  if (/Chrome|chrome/.test(msg) && /find|install|launch/i.test(msg)) return 'Google Chrome is needed to run audits. Install it and try again.';
  return msg ? `It stopped with this message: ${msg}` : 'It stopped without saying why. "Show details" has the full log.';
}

function note(text) {
  $('#form-note').textContent = text;
  $('#form-note').hidden = !text;
}

// ---------------------------------------------------------------- past reports
async function loadReports() {
  let list = [];
  try { list = await api('/api/reports'); } catch { return; }
  $('#reports-empty').hidden = list.length > 0;
  $('#reports').innerHTML = list.map((r) => `
    <li>
      <span class="badge ${band(r.score)}" aria-hidden="true">${esc(r.grade ?? '?')}</span>
      <div>
        <strong>${esc(r.host)}</strong>
        <span class="when">${esc(dateText(r.started))}${r.score != null ? ` · ${r.score}/100` : ''}${r.counts ? ` · ${plural(r.counts.high + r.counts.medium + r.counts.low, 'issue')}` : ''}</span>
        <span class="row-actions">
          <button class="text-btn" type="button" data-folder="${esc(r.folder)}" data-what="report" aria-label="Open the ${esc(r.host)} report">Report</button>
          ${r.hasPdf ? `<button class="text-btn" type="button" data-folder="${esc(r.folder)}" data-what="pdf" aria-label="Open the ${esc(r.host)} PDF">PDF</button>` : ''}
          <button class="text-btn" type="button" data-folder="${esc(r.folder)}" data-what="folder" aria-label="Show the ${esc(r.host)} report folder">Folder</button>
          <button class="text-btn" type="button" data-rerun="${esc(r.host)}" aria-label="Check ${esc(r.host)} again">Run again</button>
        </span>
      </div>
    </li>`).join('');
}

async function openFile(folder, what) {
  try { await api('/api/open', { method: 'POST', body: { folder, what } }); }
  catch (e) { alertInline(e.message); }
}
function alertInline(msg) {
  note(`Couldn't open it: ${msg}`);
  show('form');
}

// ---------------------------------------------------------------- start / cancel
const prefs = (() => { try { return JSON.parse(localStorage.getItem('site-audit-options') || '{}'); } catch { return {}; } })();
if (prefs.pages) $('#pages').value = prefs.pages;
if (prefs.lighthouse != null) $('#lighthouse').value = prefs.lighthouse;
if (prefs.pdf != null) $('#pdf').checked = prefs.pdf;

$('#run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#form-error');
  const url = $('#url').value.trim();
  err.hidden = true;
  note('');
  if (!url) { err.textContent = 'Enter the website address first, like example.com.'; err.hidden = false; $('#url').focus(); return; }
  const opts = { pages: +$('#pages').value, lighthouse: +$('#lighthouse').value, pdf: $('#pdf').checked };
  try { localStorage.setItem('site-audit-options', JSON.stringify(opts)); } catch { /* private window */ }
  const btn = e.submitter ?? $('#run-form .btn.primary');
  btn.disabled = true;
  try {
    onState(await api('/api/run', { method: 'POST', body: { url, ...opts } }));
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#cancel').addEventListener('click', async () => {
  $('#cancel').disabled = true;
  try { onState(await api('/api/cancel', { method: 'POST' })); } catch { $('#cancel').disabled = false; }
});

async function backToForm(keepUrl) {
  try { await api('/api/reset', { method: 'POST' }); } catch { /* the state event still arrives */ }
  if (!keepUrl) $('#url').value = '';
  note('');
  show('form');
  $('#url').focus();
}
$('#again').addEventListener('click', () => backToForm(false));
$('#fail-back').addEventListener('click', () => backToForm(false));
$('#retry').addEventListener('click', async () => {
  $('#url').value = lastJob.url ?? '';
  await backToForm(true);
  $('#run-form').requestSubmit();
});

document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open && doneFolder) return openFile(doneFolder, open.dataset.open);
  const row = e.target.closest('[data-folder]');
  if (row) return openFile(row.dataset.folder, row.dataset.what);
  const rerun = e.target.closest('[data-rerun]');
  if (rerun) {
    if (lastJob.status === 'running') return;
    $('#url').value = rerun.dataset.rerun;
    backToForm(true);
  }
});

// ---------------------------------------------------------------- branding
const dialog = $('#brand-dialog');
const brandForm = $('#brand-form');
let brand = {};

function applyBrand(b) {
  brand = b;
  $('#mono').textContent = b.monogram || 'SA';
  if (/^#[0-9a-f]{6}$/i.test(b.accent ?? '')) document.documentElement.style.setProperty('--brand-accent', b.accent);
}

$('#open-brand').addEventListener('click', () => {
  for (const el of brandForm.elements) if (el.name && el.name in brand) el.value = brand[el.name] ?? '';
  $('#accent-picker').value = /^#[0-9a-f]{6}$/i.test(brand.accent ?? '') ? brand.accent : '#F2963A';
  $('#brand-error').hidden = true;
  dialog.showModal();
});
$('#accent-picker').addEventListener('input', (e) => { $('#accent').value = e.target.value.toUpperCase(); });
$('#accent').addEventListener('input', (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) $('#accent-picker').value = e.target.value; });
$('#brand-cancel').addEventListener('click', () => dialog.close());
brandForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries([...brandForm.elements].filter((el) => el.name).map((el) => [el.name, el.value]));
  try {
    applyBrand(await api('/api/brand', { method: 'PUT', body }));
    dialog.close();
  } catch (x) {
    $('#brand-error').textContent = x.message;
    $('#brand-error').hidden = false;
  }
});

// ---------------------------------------------------------------- live connection to the app
function connect() {
  const es = new EventSource('/api/events');
  let lostTimer = null;
  es.addEventListener('open', () => { clearTimeout(lostTimer); $('#offline').hidden = true; });
  es.addEventListener('state', (e) => onState(JSON.parse(e.data)));
  es.addEventListener('line', (e) => onLine(JSON.parse(e.data)));
  es.addEventListener('error', () => {
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => { if (es.readyState !== EventSource.OPEN) $('#offline').hidden = false; }, 4000);
  });
}

api('/api/brand').then(applyBrand).catch(() => {});
loadReports();
connect();
show('form');
$('#url').focus();
