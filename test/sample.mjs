// Build examples/sample-report.html and .pdf from the "bad" test site, a made-up plumber, so the README can
// show a full report (Lighthouse included) without publishing an audit of a real business.
//
//   node test/sample.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePdf } from '../audit.mjs';
import { audit } from '../lib/audit.mjs';
import { renderReport } from '../lib/report.mjs';
import { serve } from './serve.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'examples');
const HOST = 'bad-example-plumbing.test';

const { server, origin } = await serve(join(ROOT, 'test', 'fixtures', 'bad'));
let data;
try {
  data = await audit(`${origin}/`, { maxPages: 10, lighthousePages: 2, log: console.log });
} finally {
  server.close();
}
// Show the made-up domain instead of the local test address
data.host = HOST;
const swap = (s) => (typeof s === 'string' ? s.replaceAll(origin.replace(/^https?:\/\//, ''), HOST).replaceAll(origin, `https://${HOST}`) : s);
for (const f of data.findings.issues) f.evidence = f.evidence.map(swap);
for (const l of data.links) l.url = swap(l.url);

mkdirSync(OUT, { recursive: true });
const brand = JSON.parse(readFileSync(join(ROOT, 'brand.json'), 'utf8'));
const html = join(OUT, 'sample-report.html');
writeFileSync(html, renderReport(data, brand));
await writePdf(html, join(OUT, 'sample-report.pdf'));
console.log(`wrote ${html} and sample-report.pdf (score ${data.findings.overall}, ${data.findings.issues.length} findings)`);
