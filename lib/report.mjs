// The client-facing report: one self-contained HTML file (fonts and screenshots embedded) that also prints
// cleanly to A4, which is how the PDF is made.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, SEVERITY } from './findings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const font = (file) => readFileSync(join(ROOT, 'assets', 'fonts', file)).toString('base64');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const areaName = Object.fromEntries(AREAS.map((a) => [a.id, a.name]));
const band = (v) => (v == null ? 'na' : v >= 90 ? 'good' : v >= 50 ? 'fair' : 'poor');
const bandWord = { good: 'Good', fair: 'Needs work', poor: 'Poor', na: 'Not tested' };
const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;

function ring(score, grade) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const off = c * (1 - score / 100);
  return `<svg class="ring" viewBox="0 0 128 128" role="img" aria-label="Overall score ${score} out of 100, grade ${grade}">
    <circle cx="64" cy="64" r="${r}" class="ring-track"/>
    <circle cx="64" cy="64" r="${r}" class="ring-fill ${band(score)}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 64 64)"/>
    <text x="64" y="62" class="ring-grade">${grade}</text>
    <text x="64" y="86" class="ring-score">${score}/100</text>
  </svg>`;
}

function finding(f) {
  const ev = [...f.evidence];
  const lead = ev[0]?.endsWith(':') ? ev.shift() : null;
  const where = f.where.length
    ? `<p class="where"><span class="k">Where</span> ${f.where.slice(0, 8).map((p) => `<code>${esc(p)}</code>`).join(' ')}${f.where.length > 8 ? ` <span class="more">and ${f.where.length - 8} more</span>` : ''}</p>`
    : '';
  const evidence = ev.length
    ? `<div class="evidence">${lead ? `<p>${esc(lead)}</p>` : ''}<ul>${ev.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  return `<article class="finding sev-${f.severity}">
    <p class="tags"><span class="sev">${SEVERITY[f.severity].label}</span><span class="area">${esc(areaName[f.area])}</span></p>
    <h3>${esc(f.title)}</h3>
    <p class="why">${esc(f.why)}</p>
    <p class="fix"><span class="k">How to fix</span> ${esc(f.fix)}</p>
    ${where}${evidence}
  </article>`;
}

export function renderReport(d, brand) {
  const { issues, passes, scores, overall, grade } = d.findings;
  const date = new Date(d.started).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  const count = (sev) => issues.filter((f) => f.severity === sev).length;
  const lh = d.lighthouse.filter((r) => !r.error);
  const okLinks = d.links.filter((l) => l.verdict === 'ok').length;
  const unverified = d.links.filter((l) => l.verdict === 'unverified');

  const counts = ['high', 'medium', 'low'].filter((s) => count(s)).map((s) => `${count(s)} to ${s === 'high' ? 'fix first' : s === 'medium' ? 'fix soon' : 'consider'}`);
  const summary = issues.length
    ? `We found ${plural(issues.length, 'thing')} to improve: ${counts.join(', ')}.`
    : 'We found nothing that needs fixing. The site is in excellent shape.';
  const method = `We checked ${plural(d.pages.length, 'page')} of ${esc(d.host)} on ${date}${lh.length ? `, ran Google Lighthouse on ${plural(lh.length, 'of them', 'of them')} as a phone on a 4G connection,` : ''} and tested ${plural(okLinks + unverified.length + d.links.filter((l) => l.verdict === 'broken').length, 'link and image', 'links and images')}.`;

  const areaRows = AREAS.map((a) => {
    const v = scores[a.id];
    return `<li><span class="an">${a.name}</span><span class="bar"><span class="${band(v)}" style="width:${v ?? 0}%"></span></span><span class="av">${v ?? '–'}</span><span class="aw ${band(v)}">${bandWord[band(v)]}</span></li>`;
  }).join('');

  const groups = ['high', 'medium', 'low'].map((sev) => {
    const list = issues.filter((f) => f.severity === sev);
    if (!list.length) return '';
    const intro = {
      high: 'These cost you visitors, calls or Google rankings right now.',
      medium: 'Worth fixing in the next round of updates.',
      low: 'Small polish that adds up.',
    }[sev];
    return `<section class="group"><h2>${SEVERITY[sev].label} <span class="n">${list.length}</span></h2><p class="lede">${intro}</p>${list.map(finding).join('')}</section>`;
  }).join('');

  const passList = AREAS.map((a) => {
    const list = passes.filter((p) => p.area === a.id);
    if (!list.length) return '';
    return `<div class="pass-area"><h3>${a.name}</h3><ul>${list.map((p) => `<li>${esc(p.text)}</li>`).join('')}</ul></div>`;
  }).join('');

  const lhTable = lh.length ? `<section class="block">
    <h2>Google Lighthouse, on a phone</h2>
    <p class="lede">Lighthouse is Google's own testing tool. Scores run from 0 to 100; 90 and up is good. It simulates a mid-range phone on a slow 4G connection, so real visitors on Wi-Fi will usually see faster loads.</p>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Page</th><th scope="col">Performance</th><th scope="col">Accessibility</th><th scope="col">Best practices</th><th scope="col">SEO</th><th scope="col">Main content shown</th><th scope="col">Layout shift</th><th scope="col">Frozen</th></tr></thead>
      <tbody>${lh.map((r) => `<tr><th scope="row"><code>${esc(r.path)}</code></th>${['performance', 'accessibility', 'best-practices', 'seo'].map((c) => `<td><span class="pill ${band(r.scores[c])}">${r.scores[c] ?? '–'}</span></td>`).join('')}<td>${r.vitals.lcp != null ? (r.vitals.lcp / 1000).toFixed(1) + ' s' : '–'}</td><td>${r.vitals.cls != null ? r.vitals.cls.toFixed(2) : '–'}</td><td>${r.vitals.tbt != null ? Math.round(r.vitals.tbt) + ' ms' : '–'}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="note">Google's targets: main content shown in under 2.5 s, layout shift under 0.1, and the page frozen for under 200 ms.</p>
  </section>` : '';

  const shots = d.shots.desktop ? `<section class="block shots">
    <h2>How the homepage looks today</h2>
    <div class="shot-row">
      <figure class="desk"><div class="frame"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="addr">${esc(d.host)}</span></div><img src="data:image/jpeg;base64,${d.shots.desktop}" alt="The homepage of ${esc(d.host)} on a desktop screen"><figcaption>Desktop, 1440 px wide</figcaption></figure>
      ${d.shots.phone ? `<figure class="phone"><img src="data:image/jpeg;base64,${d.shots.phone}" alt="The homepage of ${esc(d.host)} on a phone"><figcaption>Phone, 390 px wide</figcaption></figure>` : ''}
    </div>
  </section>` : '';

  const pagesList = `<section class="block">
    <h2>What we checked</h2>
    <p class="lede">${method}</p>
    <ul class="pages">${d.pages.map((p) => `<li><code>${esc(p.path)}</code> <span>${esc(p.title || '(no title)')}</span></li>`).join('')}</ul>
    ${unverified.length ? `<p class="note">${plural(unverified.length, 'link')} couldn't be verified because ${unverified.length === 1 ? 'that site blocks' : 'those sites block'} automated checks (social networks usually do): ${unverified.slice(0, 5).map((l) => `<code>${esc(l.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}</code>`).join(' ')}. Open them by hand to be sure.</p>` : ''}
    ${d.failed.length ? `<p class="note">${plural(d.failed.length, 'page')} couldn't be loaded and ${d.failed.length === 1 ? 'is' : 'are'} counted in the broken links above.</p>` : ''}
  </section>`;

  const contact = [
    brand.email && `<a href="mailto:${esc(brand.email)}">${esc(brand.email)}</a>`,
    brand.website && `<a href="${esc(brand.website)}">${esc(brand.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`,
  ].filter(Boolean).join('<span aria-hidden="true"> · </span>');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Website audit: ${esc(d.host)}</title>
<meta name="description" content="Website audit of ${esc(d.host)}, ${date}: ${esc(summary)}">
<meta name="robots" content="noindex">
<style>
@font-face { font-family: "Archivo"; src: url(data:font/woff2;base64,${font('archivo.woff2')}) format("woff2"); font-weight: 400 700; font-display: swap; }
@font-face { font-family: "Cormorant"; src: url(data:font/woff2;base64,${font('cormorant.woff2')}) format("woff2"); font-weight: 500 700; font-display: swap; }
:root {
  color-scheme: light;
  --font: "Archivo", system-ui, -apple-system, "Segoe UI", sans-serif;
  --display: "Cormorant", Georgia, "Times New Roman", serif;
  --paper: #FBF8F3; --card: #FFFFFF; --ink: #1C1C1D; --text: #34322E; --muted: #625C53; --line: #E4DCCF;
  --night: #1C1C1D; --night-2: #262627; --cream: #EFE7DA; --cream-2: #CFC8BD;
  --accent: ${esc(brand.accent || '#F2963A')}; --accent-ink: #94500F;
  --good: #2C6E3F; --fair: #94500F; --poor: #B42318;
  --good-bar: #3D8B54; --fair-bar: #E08A2E; --poor-bar: #D2452F;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--text); font: 400 16px/1.6 var(--font); }
.wrap { max-width: 54rem; margin-inline: auto; padding-inline: 16px; }
h1, h2, h3 { color: var(--ink); margin: 0; }
h2 { font: 600 2rem/1.1 var(--display); margin-bottom: .4rem; }
h3 { font-size: 1.08rem; line-height: 1.35; font-weight: 700; }
code { font: .82em/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace; background: #F1EBE1; color: var(--ink); padding: .1em .4em; border-radius: 3px; overflow-wrap: anywhere; }
a { color: var(--accent-ink); }
.lede { margin: 0 0 1.4rem; color: var(--muted); max-width: 44rem; }
.note { font-size: .88rem; color: var(--muted); }

/* cover */
.cover { background: var(--night); color: var(--cream-2); padding: 28px 0 40px; }
.brandline { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: .78rem; letter-spacing: .14em; text-transform: uppercase; }
.brandline .who { display: inline-flex; align-items: center; gap: 10px; color: var(--cream); font-weight: 700; }
.mono { flex: none; display: inline-grid; place-items: center; width: 34px; height: 34px; border: 1.5px solid var(--accent); border-radius: 4px; color: var(--accent); font: 600 1.05rem/1 var(--display); letter-spacing: 0; }
.cover h1 { font: 600 clamp(2.6rem, 8vw, 4.2rem)/1.05 var(--display); color: var(--cream); margin: 2.2rem 0 .3rem; }
.cover h1 span { color: var(--accent); }
.cover .host { font-size: clamp(1.1rem, 3.2vw, 1.4rem); color: var(--cream); margin: 0; overflow-wrap: anywhere; }
.cover .date { color: var(--cream-2); margin: .2rem 0 0; font-size: .95rem; }
.verdict { display: grid; grid-template-columns: auto 1fr; gap: 28px 36px; align-items: center; margin-top: 2.2rem; padding-top: 2rem; border-top: 1px solid #3A3A3C; }
.ring { width: 136px; height: 136px; }
.ring-track { fill: none; stroke: #3A3A3C; stroke-width: 10; }
.ring-fill { fill: none; stroke-width: 10; stroke-linecap: round; }
.ring-fill.good { stroke: #5FBF7A; } .ring-fill.fair { stroke: var(--accent); } .ring-fill.poor { stroke: #F07560; }
.ring-grade { fill: var(--cream); font: 600 46px/1 var(--display); text-anchor: middle; }
.ring-score { fill: var(--cream-2); font: 600 13px/1 var(--font); text-anchor: middle; }
.verdict .sum { color: var(--cream); font-size: 1.12rem; margin: 0 0 .5rem; }
.verdict .method { margin: 0; font-size: .92rem; }
.areas { grid-column: 1 / -1; justify-self: stretch; list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.areas li { display: grid; grid-template-columns: 9.5rem 1fr 2.2rem 6.2rem; align-items: center; gap: 12px; }
.areas .an { color: var(--cream); font-weight: 600; }
.areas .bar { height: 8px; background: #3A3A3C; border-radius: 4px; overflow: hidden; }
.areas .bar span { display: block; height: 100%; border-radius: 4px; }
.areas .bar .good { background: #5FBF7A; } .areas .bar .fair { background: var(--accent); } .areas .bar .poor { background: #F07560; }
.areas .av { color: var(--cream); font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
.areas .aw { font-size: .82rem; white-space: nowrap; }
.areas .aw.good { color: #8FD6A3; } .areas .aw.fair { color: var(--accent); } .areas .aw.poor { color: #F79A88; } .areas .aw.na { color: var(--cream-2); }

/* sections */
main { padding: 8px 0 48px; }
.block, .group { margin-top: 48px; }
.group h2 .n { display: inline-grid; place-items: center; min-width: 2rem; height: 2rem; margin-left: .3rem; padding: 0 .5rem; border-radius: 1rem; background: var(--ink); color: var(--paper); font: 700 .95rem/1 var(--font); vertical-align: middle; }
.finding { background: var(--card); border: 1px solid var(--line); border-left: 5px solid var(--muted); border-radius: 4px; padding: 18px 20px; margin-top: 14px; break-inside: avoid; }
.finding.sev-high { border-left-color: var(--poor); } .finding.sev-medium { border-left-color: var(--fair-bar); }
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 .5rem; font-size: .74rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.sev { color: var(--muted); white-space: nowrap; }
.sev-high .sev { color: var(--poor); } .sev-medium .sev { color: var(--fair); }
.area { color: var(--muted); font-weight: 600; white-space: nowrap; }
.area::before { content: "·"; margin-right: 8px; }
.finding p { margin: .45rem 0 0; }
.why { color: var(--text); }
.k { display: inline; font-weight: 700; color: var(--ink); margin-right: .25rem; }
.where code { display: inline-block; margin: 2px 0; }
.more { color: var(--muted); font-size: .88rem; }
.evidence { margin-top: .7rem; padding: 10px 14px; background: #F6F1E8; border-radius: 3px; font-size: .86rem; color: var(--text); }
.evidence p { margin: 0 0 .2rem; font-weight: 600; }
.evidence ul { margin: 0; padding-left: 1.1rem; }
.evidence li { overflow-wrap: anywhere; }

.passes { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 14px 28px; }
.pass-area h3 { font-size: .8rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: .4rem; }
.pass-area ul { list-style: none; margin: 0; padding: 0; }
.pass-area li { position: relative; padding-left: 1.6rem; margin-bottom: .45rem; }
.pass-area li::before { content: ""; position: absolute; left: .15rem; top: .45em; width: .45rem; height: .8rem; border: solid var(--good); border-width: 0 2.5px 2.5px 0; transform: rotate(45deg); }

.shot-row { display: grid; grid-template-columns: 1fr 13rem; gap: 24px; align-items: end; }
figure { margin: 0; }
figcaption { font-size: .82rem; color: var(--muted); margin-top: .5rem; }
.desk .frame { display: flex; align-items: center; gap: 12px; background: #E9E2D6; border: 1px solid var(--line); border-bottom: 0; border-radius: 6px 6px 0 0; padding: 8px 12px; }
.dots { display: inline-flex; gap: 5px; } .dots i { width: 9px; height: 9px; border-radius: 50%; background: #C9BFB0; }
.addr { flex: 1; font-size: .78rem; color: var(--muted); background: var(--card); border-radius: 3px; padding: 2px 10px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.desk img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 0 0 6px 6px; }
.phone img { display: block; width: 100%; height: auto; border: 8px solid var(--night); border-radius: 26px; }

.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 4px; background: var(--card); }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
thead th { font-size: .74rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
tbody tr:last-child > * { border-bottom: 0; }
.pill { display: inline-block; min-width: 2.4rem; text-align: center; padding: 2px 8px; border-radius: 1rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.pill.good { background: #E3F1E6; color: var(--good); } .pill.fair { background: #FBEBD9; color: var(--fair); } .pill.poor { background: #FBE4E0; color: var(--poor); } .pill.na { color: var(--muted); }

.pages { list-style: none; margin: 0; padding: 0; columns: 2 18rem; column-gap: 28px; }
.pages li { break-inside: avoid; margin-bottom: .5rem; font-size: .92rem; }
.pages span { color: var(--muted); }

.cta { background: var(--night); color: var(--cream-2); padding: 40px 0; }
.cta h2 { color: var(--cream); }
.cta p { max-width: 40rem; margin: .3rem 0 0; }
.cta .who { color: var(--cream); font-weight: 700; }
.cta a { color: var(--accent); font-weight: 600; }
.cta .links { margin-top: 1rem; font-size: 1.02rem; }
.colophon { padding-top: 14px; padding-bottom: 22px; font-size: .78rem; color: var(--muted); }

@media (max-width: 640px) {
  .verdict { grid-template-columns: 1fr; justify-items: start; gap: 20px; }
  .brandline .role { display: none; }
  .areas li { grid-template-columns: 7.2rem 1fr 2rem; }
  .areas .aw { display: none; }
  .shot-row { grid-template-columns: 1fr; }
  .phone { max-width: 13rem; }
  .finding { padding: 16px; }
}
@page { size: A4; margin: 14mm 0; }
@page :first { margin-top: 0; }
@media print {
  /* white paper, so the page margins don't show as strips */
  body { font-size: 10.5pt; background: #fff; }
  th, td { padding: 6px 7px; white-space: normal; font-size: 8.5pt; }
  thead th { font-size: 7pt; letter-spacing: .03em; }
  .cover, .cta, .finding, .pill, .areas .bar span, .evidence { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .block, .group { margin-top: 28px; }
  .shots, .cta, .pass-area { break-inside: avoid; }
  h2 { break-after: avoid; }
  .table-wrap { overflow: visible; }
  a { text-decoration: none; }
}
</style>
</head>
<body>
<header class="cover">
  <div class="wrap">
    <div class="brandline"><span class="who"><span class="mono">${esc(brand.monogram || '')}</span>${esc(brand.name)}</span><span class="role">${esc(brand.role || '')}</span></div>
    <h1>Website <span>audit</span></h1>
    <p class="host">${esc(d.host)}</p>
    <p class="date">${date}</p>
    <div class="verdict">
      ${ring(overall, grade)}
      <div><p class="sum">${esc(summary)}</p><p class="method">${method}</p></div>
      <ul class="areas" aria-label="Scores by area">${areaRows}</ul>
    </div>
  </div>
</header>
<main class="wrap">
  ${groups}
  ${passes.length ? `<section class="block"><h2>What's already working</h2><p class="lede">These checks passed. Keep them that way when the site changes.</p><div class="passes">${passList}</div></section>` : ''}
  ${shots}
  ${lhTable}
  ${pagesList}
</main>
<section class="cta">
  <div class="wrap">
    <h2>${esc(brand.ctaTitle || 'Want these fixed?')}</h2>
    <p>${esc(brand.ctaText || '')}</p>
    <p class="links"><span class="who">${esc(brand.name)}</span>${contact ? `<span aria-hidden="true"> · </span>${contact}` : ''}</p>
  </div>
</section>
<footer class="wrap colophon">Made with site-audit${lh[0] ? ` and Lighthouse ${esc(lh[0].version)}` : ''} on ${date}. Results are a snapshot: scores change as the site and its hosting change.</footer>
</body>
</html>
`;
}
