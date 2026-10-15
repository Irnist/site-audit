#!/usr/bin/env node
// site-audit app: a small window for running audits and opening past reports.
//
//   node app.mjs              opens the app in a Chrome app window (or your default browser)
//   node app.mjs --no-open    just starts it and prints the address
//   node app.mjs --port N     use another port (default 4517)
//
// Each audit runs as its own `node audit.mjs` process, so Cancel can stop it and its Chrome cleanly.
// The app closes itself a little while after its last window closes, unless an audit is still running.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chromeLauncher from 'chrome-launcher';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, 'ui');
const FONTS = join(HERE, 'assets', 'fonts');
const REPORTS = join(HERE, 'reports');
const BRAND = join(HERE, 'brand.json');
const APP_ID = 'site-audit-app';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const portArg = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 4517;
const IDLE_MS = 20000;

// ------------------------------------------------------------------ state of the current (or last) audit
let job = { status: 'idle' };   // idle | running | done | failed | cancelled
let child = null;
const clients = new Set();

const send = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
};

function startAudit({ url, pages, lighthouse, pdf }) {
  const argv = [join(HERE, 'audit.mjs'), url, '--pages', String(pages), '--lighthouse', String(lighthouse)];
  if (!pdf) argv.push('--no-pdf');
  const id = Date.now();
  job = { id, status: 'running', url, pages, lighthouse, pdf, started: id, lines: [] };
  send('state', job);
  const proc = spawn(process.execPath, argv, { cwd: HERE, windowsHide: true });
  child = proc;
  let reportDir = null;
  let lastError = '';
  // A cancelled run can still be printing while the next one starts: only the current run updates the state
  const current = () => job.id === id && job.status === 'running';
  const onLine = (line, isErr) => {
    if (!line.trim() || !current()) return;
    const m = line.match(/^Report: (.+)$/);
    if (m) reportDir = dirname(m[1].trim());
    if (isErr) lastError = line.replace(/^site-audit failed: /, '');
    job.lines.push(line);
    if (job.lines.length > 400) job.lines.shift();
    send('line', line);
  };
  for (const [stream, isErr] of [[proc.stdout, false], [proc.stderr, true]]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const p of parts) onLine(p, isErr);
    });
    stream.on('end', () => buf && onLine(buf, isErr));
  }
  proc.on('close', (code) => {
    if (child === proc) child = null;
    if (!current()) return;
    if (code === 0 && reportDir) {
      job = { ...job, status: 'done', summary: readSummary(reportDir) };
    } else {
      job = { ...job, status: 'failed', error: lastError || `the audit stopped (exit code ${code})` };
    }
    job.ended = Date.now();
    send('state', job);
    idleCheck();
  });
}

function cancelAudit() {
  if (!child) return;
  job = { ...job, status: 'cancelled', ended: Date.now() };
  // Stop the audit and the Chrome it started
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
  send('state', job);
}

// ------------------------------------------------------------------ past reports
function readSummary(dir) {
  const folder = relative(REPORTS, dir).split(sep).join('/');
  const file = join(dir, 'summary.json');
  let s = {};
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { /* an older report without one */ }
  return {
    folder,
    host: s.host ?? folder.replace(/-\d{4}-\d{2}-\d{2}$/, ''),
    started: s.started ?? statSync(join(dir, 'report.html')).mtime.toISOString(),
    score: s.score ?? null, grade: s.grade ?? null, counts: s.counts ?? null, pages: s.pages ?? null, issues: s.issues ?? [],
    hasPdf: existsSync(join(dir, 'report.pdf')),
  };
}

function listReports() {
  if (!existsSync(REPORTS)) return [];
  return readdirSync(REPORTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(REPORTS, d.name, 'report.html')))
    .map((d) => readSummary(join(REPORTS, d.name)))
    .sort((a, b) => b.started.localeCompare(a.started));
}

// Open a report file or its folder with the computer's own apps (browser, PDF viewer, file manager)
function openReport(folder, what) {
  const dir = resolve(REPORTS, folder);
  if (!dir.startsWith(REPORTS + sep) || !existsSync(dir)) throw new Error('no such report');
  const target = what === 'pdf' ? join(dir, 'report.pdf') : what === 'folder' ? dir : join(dir, 'report.html');
  if (!existsSync(target)) throw new Error('that file is missing');
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['explorer.exe', [target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
}

// ------------------------------------------------------------------ branding
const BRAND_FIELDS = ['name', 'monogram', 'role', 'website', 'email', 'accent', 'ctaTitle', 'ctaText'];

function saveBrand(input) {
  const brand = JSON.parse(readFileSync(BRAND, 'utf8'));
  for (const k of BRAND_FIELDS) if (typeof input[k] === 'string') brand[k] = input[k].trim();
  if (!/^#[0-9a-f]{6}$/i.test(brand.accent)) throw new Error('the accent colour must look like #F2963A');
  brand.monogram = brand.monogram.slice(0, 3);
  writeFileSync(BRAND, JSON.stringify(brand, null, 2) + '\n');
  return brand;
}

// ------------------------------------------------------------------ server
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function serveFile(res, root, name) {
  const file = resolve(root, name);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 100000) throw new Error('too large'); }
  return s ? JSON.parse(s) : {};
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  // Only the app's own page may call it: no other host names (DNS rebinding) and no other sites' pages
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return json(res, 403, { error: 'forbidden' });
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'forbidden' });
  try {
    if (req.method === 'GET' && pathname === '/') return serveFile(res, UI, 'index.html');
    if (req.method === 'GET' && pathname.startsWith('/ui/')) return serveFile(res, UI, pathname.slice(4));
    if (req.method === 'GET' && pathname.startsWith('/fonts/')) return serveFile(res, FONTS, pathname.slice(7));
    if (req.method === 'GET' && pathname === '/api/ping') return json(res, 200, { app: APP_ID });
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, job);
    if (req.method === 'GET' && pathname === '/api/reports') return json(res, 200, listReports());
    if (req.method === 'GET' && pathname === '/api/brand') return json(res, 200, JSON.parse(readFileSync(BRAND, 'utf8')));
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(job)}\n\n`);
      clients.add(res);
      req.on('close', () => { clients.delete(res); idleCheck(); });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/run') {
      if (job.status === 'running') return json(res, 409, { error: 'an audit is already running' });
      const b = await body(req);
      const url = String(b.url ?? '').trim();
      const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      let host = '';
      try { host = new URL(full).hostname; } catch { /* checked below */ }
      if (!url || !host.includes('.') && host !== 'localhost') return json(res, 400, { error: 'Enter a web address, like example.com' });
      const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? Math.round(+v) : d));
      startAudit({ url: full, pages: clamp(b.pages, 1, 100, 10), lighthouse: clamp(b.lighthouse, 0, 5, 2), pdf: b.pdf !== false });
      return json(res, 200, job);
    }
    if (req.method === 'POST' && pathname === '/api/cancel') { cancelAudit(); return json(res, 200, job); }
    if (req.method === 'POST' && pathname === '/api/reset') {
      if (job.status !== 'running') { job = { status: 'idle' }; send('state', job); }
      return json(res, 200, job);
    }
    if (req.method === 'POST' && pathname === '/api/open') {
      const b = await body(req);
      openReport(String(b.folder ?? ''), String(b.what ?? 'report'));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && pathname === '/api/brand') return json(res, 200, saveBrand(await body(req)));
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

// Close once no window has been open for a while and nothing is running
// (With --no-open it stays up until stopped.)
let idleTimer = null;
function idleCheck(wait = IDLE_MS) {
  clearTimeout(idleTimer);
  if (flag('--no-open') || clients.size || job.status === 'running') return;
  idleTimer = setTimeout(() => {
    if (!clients.size && job.status !== 'running') {
      console.log('No window open; closing the app.');
      process.exit(0);
    }
  }, wait);
}

// A frameless app window from the installed Chrome, with its own small profile so it remembers its size.
// Falls back to the default browser.
function openWindow(url) {
  if (flag('--no-open')) return;
  let chrome = null;
  try { chrome = chromeLauncher.Launcher.getFirstInstallation(); } catch { /* not installed */ }
  if (chrome) {
    spawn(chrome, [`--app=${url}`, `--user-data-dir=${join(tmpdir(), 'site-audit-app')}`, '--window-size=1180,860', '--no-first-run', '--no-default-browser-check'],
      { detached: true, stdio: 'ignore' }).unref();
  } else {
    const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, a, { detached: true, stdio: 'ignore' }).unref();
  }
}

async function alreadyRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).app === APP_ID;
  } catch { return false; }
}

if (await alreadyRunning(portArg)) {
  // The app is already open: just show another window
  console.log(`site-audit is already running at http://127.0.0.1:${portArg}/`);
  openWindow(`http://127.0.0.1:${portArg}/`);
} else {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') server.listen(0, '127.0.0.1');   // the port belongs to something else
    else throw e;
  });
  server.on('listening', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`site-audit app: ${url}\nLeave this window open while you use the app; it closes itself afterwards.`);
    openWindow(url);
    idleCheck(60000);   // time for the window to open
  });
  server.listen(portArg, '127.0.0.1');
}
