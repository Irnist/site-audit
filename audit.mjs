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
  const url = /^https?:\/\//i.test(opts.url) ? opts.url : `https://${opts.url}`;
  try { new URL(url); } catch { console.error(`not a web address: ${opts.url}`); process.exit(2); }
  const brand = JSON.parse(readFileSync(opts.brand, 'utf8'));

  console.log(`Auditing ${url}`);
  const data = await audit(url, { maxPages: opts.pages, lighthousePages: opts.lighthouse, log: (m) => console.log(m) });

  const day = data.started.slice(0, 10);
  const out = opts.out ?? join(HERE, 'reports', `${data.host}-${day}`);
  mkdirSync(out, { recursive: true });
  const html = join(out, 'report.html');
  writeFileSync(html, renderReport(data, brand));
  if (opts.json) writeFileSync(join(out, 'data.json'), JSON.stringify({ ...data, shots: undefined }, null, 2));
  if (opts.pdf) {
    console.log('Writing the PDF');
    await writePdf(html, join(out, 'report.pdf'));
  }

  const f = data.findings;
  const n = (s) => f.issues.filter((i) => i.severity === s).length;
  console.log(`\nScore ${f.overall}/100 (grade ${f.grade}): ${n('high')} to fix first, ${n('medium')} to fix soon, ${n('low')} nice to have`);
  for (const i of f.issues) console.log(`  [${i.severity}] ${i.title}`);
  console.log(`\nReport: ${html}${opts.pdf ? `\nPDF:    ${join(out, 'report.pdf')}` : ''}`);
  console.log(`Done in ${Math.round((Date.now() - Date.parse(data.started)) / 1000)} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`site-audit failed: ${e.message}`);
    process.exit(1);
  });
}
