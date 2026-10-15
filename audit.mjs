#!/usr/bin/env node
// site-audit: check a small-business website and write a plain-language report (HTML + PDF).
//
//   node audit.mjs https://example.com
//   node audit.mjs example.com --pages 20 --lighthouse 3 --out reports/example
//
// Options:
//   --pages N        pages to crawl (default 10)
//   --lighthouse N   pages to run Lighthouse on, homepage first, then a contact page (default 2; 0 skips it)
//   --brand FILE     brand file for the report's header and closing note (default brand.json beside this script)
//   --out DIR        where to write the report (default reports/<site>-<date> beside this script)
//   --no-pdf         skip the PDF
//   --json           also save the raw data as data.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import * as chromeLauncher from 'chrome-launcher';
import { audit } from './lib/audit.mjs';
import { renderReport } from './lib/report.mjs';
import { AREAS } from './lib/findings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { pages: 10, lighthouse: 2, brand: join(HERE, 'brand.json'), out: null, pdf: true, json: false, url: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--pages') opts.pages = Math.max(1, parseInt(next(), 10) || 10);
    else if (a === '--lighthouse') opts.lighthouse = Math.max(0, parseInt(next(), 10) || 0);
    else if (a === '--brand') opts.brand = resolve(next());
    else if (a === '--out') opts.out = resolve(next());
    else if (a === '--no-pdf') opts.pdf = false;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (!a.startsWith('-') && !opts.url) opts.url = a;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

export async function writePdf(htmlPath, pdfPath) {
  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--disable-gpu', '--no-first-run'] });
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.disconnect();
    await chrome.kill();
  }
}

export const normalizeUrl = (s) => (/^https?:\/\//i.test(s.trim()) ? s.trim() : `https://${s.trim()}`);

// Audit a site and write report.html, report.pdf and summary.json (what the app's report list shows)
export async function runAudit({ url, pages = 10, lighthouse = 2, brand = join(HERE, 'brand.json'), out = null, pdf = true, json = false }, log = () => {}) {
  const brandData = JSON.parse(readFileSync(brand, 'utf8'));
  const data = await audit(url, { maxPages: pages, lighthousePages: lighthouse, log });

  log('Writing the report');
  const dir = out ?? join(HERE, 'reports', `${data.host}-${data.started.slice(0, 10)}`);
  mkdirSync(dir, { recursive: true });
  const html = join(dir, 'report.html');
  writeFileSync(html, renderReport(data, brandData));
  if (json) writeFileSync(join(dir, 'data.json'), JSON.stringify({ ...data, shots: undefined }, null, 2));
  if (pdf) {
    log('Writing the PDF');
    await writePdf(html, join(dir, 'report.pdf'));
  }

  const f = data.findings;
  const n = (s) => f.issues.filter((i) => i.severity === s).length;
  const summary = {
    url: data.url, host: data.host, started: data.started, pages: data.pages.length,
    score: f.overall, grade: f.grade, counts: { high: n('high'), medium: n('medium'), low: n('low') },
    pdf, seconds: Math.round((Date.now() - Date.parse(data.started)) / 1000),
    issues: f.issues.map((i) => ({ severity: i.severity, area: AREAS.find((a) => a.id === i.area)?.name ?? i.area, title: i.title })),
  };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return { data, dir, html, pdf: pdf ? join(dir, 'report.pdf') : null, summary };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (opts.help || !opts.url) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(opts.help ? 0 : 2);
  }
  const url = normalizeUrl(opts.url);
  try { new URL(url); } catch { console.error(`not a web address: ${opts.url}`); process.exit(2); }

  console.log(`Auditing ${url}`);
  const r = await runAudit({ ...opts, url }, (m) => console.log(m));
  const { summary: s, data } = r;
  console.log(`\nScore ${s.score}/100 (grade ${s.grade}): ${s.counts.high} to fix first, ${s.counts.medium} to fix soon, ${s.counts.low} nice to have`);
  for (const i of data.findings.issues) console.log(`  [${i.severity}] ${i.title}`);
  console.log(`\nReport: ${r.html}${r.pdf ? `\nPDF:    ${r.pdf}` : ''}`);
  console.log(`Done in ${s.seconds} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`site-audit failed: ${e.message}`);
    process.exit(1);
  });
}
