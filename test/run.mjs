// Tests: serve two small sites from test/fixtures and audit each one.
//   bad/   has a planted defect for every check that can run locally; each must be reported.
//   good/  does everything right; it must come back with no findings at all.
// Lighthouse is skipped (it needs a minute per page); pass --lighthouse to include it.
//
//   npm test
//   node test/run.mjs --lighthouse
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../lib/audit.mjs';
import { renderReport } from '../lib/report.mjs';
import { serve } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const lighthousePages = process.argv.includes('--lighthouse') ? 1 : 0;

const EXPECT_BAD = [
  'no-viewport', 'mobile-overflow', 'no-tap-to-call', 'noindex', 'duplicate-title', 'missing-description',
  'multiple-h1', 'no-local-schema', 'no-share-image', 'img-alt', 'no-lang', 'broken-internal', 'broken-external',
  'broken-images', 'mailto-form', 'old-copyright', 'no-favicon',
];

async function run(name) {
  const { server, origin } = await serve(join(HERE, 'fixtures', name));
  try {
    const data = await audit(`${origin}/`, { maxPages: 10, lighthousePages });
    renderReport(data, { name: 'Test', monogram: 'T' });  // must render without throwing
    return data;
  } finally {
    server.close();
  }
}

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

const bad = await run('bad');
const found = new Set(bad.findings.issues.map((f) => f.id));
check(bad.pages.length === 3, `bad: crawled ${bad.pages.length} of 3 pages`);
for (const id of EXPECT_BAD) check(found.has(id), `bad: reports ${id}`);
const extra = [...found].filter((id) => !EXPECT_BAD.includes(id) && !id.startsWith('lh-'));
check(!extra.length, `bad: nothing unexpected${extra.length ? ` (got ${extra.join(', ')})` : ''}`);

const good = await run('good');
check(good.pages.length === 2, `good: crawled ${good.pages.length} of 2 pages`);
const noise = good.findings.issues.map((f) => `${f.id} (${f.title})`);
check(!noise.length, `good: no findings${noise.length ? `, got: ${noise.join('; ')}` : ''}`);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
