// Gather everything about a site: site-wide files, a crawl, link and image checks, and Lighthouse.
import { openBrowser } from './browser.mjs';
import { crawl, pageKey } from './crawl.mjs';
import { runLighthouse } from './lighthouse.mjs';
import { checkUrls, siteChecks } from './net.mjs';
import { buildFindings } from './findings.mjs';

export async function audit(startUrl, { maxPages = 10, lighthousePages = 2, log = () => {} } = {}) {
  const started = new Date();
  log('Checking site-wide files (HTTPS, robots.txt, sitemap)');
  const site = await siteChecks(startUrl);

  const session = await openBrowser();
  try {
    log(`Crawling up to ${maxPages} pages`);
    const { pages, failed, shots } = await crawl(session, startUrl, { maxPages, extraUrls: site.sitemap.urls, log });
    if (!pages.length) throw new Error(`could not load ${startUrl}: ${failed[0]?.error ?? 'no response'}`);

    // Every link and image on the checked pages, minus the pages the crawl already loaded
    const visited = new Set([...pages.map((p) => pageKey(p.url)), ...failed.map((f) => pageKey(f.url))]);
    const foundOn = new Map();  // url -> { kind, pages: Set<path> }
    const note = (url, kind, page) => {
      if (!foundOn.has(url)) foundOn.set(url, { kind, pages: new Set() });
      foundOn.get(url).pages.add(page.path);
    };
    for (const p of pages) {
      for (const l of p.links) if (/^https?:/i.test(l.href)) note(l.href.split('#')[0], 'link', p);
      for (const i of p.imgs) if (/^https?:/i.test(i.src)) note(i.src, 'image', p);
    }
    const toCheck = new Set([...foundOn.keys()].filter((u) => {
      try { return !visited.has(pageKey(u)) || foundOn.get(u).kind === 'image'; } catch { return false; }
    }));
    const { results, skipped } = await checkUrls(toCheck, { log });
    // Pages the crawl couldn't load count as broken links from wherever they were linked
    for (const f of failed) {
      const key = pageKey(f.url);
      const linkedFrom = pages.filter((p) => p.links.some((l) => { try { return pageKey(l.href) === key; } catch { return false; } }));
      if (!foundOn.has(f.url)) foundOn.set(f.url, { kind: 'link', pages: new Set(linkedFrom.map((p) => p.path)) });
      results.set(f.url, { status: f.status, error: f.error, verdict: f.status === 404 || f.status === 410 || f.status >= 500 ? 'broken' : 'unverified' });
    }
    const links = [...results].map(([url, r]) => ({ url, ...r, kind: foundOn.get(url)?.kind ?? 'link', pages: [...(foundOn.get(url)?.pages ?? [])] }));

    // Lighthouse: the homepage, then the contact page if there is one, then the next pages crawled
    const lhTargets = [pages[0]];
    const contact = pages.slice(1).find((p) => /contact|quote|book|appointment/i.test(p.path));
    if (contact) lhTargets.push(contact);
    for (const p of pages.slice(1)) if (lhTargets.length < lighthousePages && !lhTargets.includes(p)) lhTargets.push(p);
    const lighthouse = [];
    for (const p of lhTargets.slice(0, lighthousePages)) {
      log(`Lighthouse (mobile): ${p.url}`);
      const r = await runLighthouse(p.url, session.port);
      lighthouse.push({ ...r, path: p.path });
      if (r.error) log(`  Lighthouse failed: ${r.error}`);
    }

    const data = {
      url: startUrl,
      host: new URL(pages[0].url).hostname.replace(/^www\./, ''),
      started: started.toISOString(),
      seconds: Math.round((Date.now() - started) / 1000),
      site,
      pages,
      failed,
      links,
      linksSkipped: skipped,
      lighthouse,
      shots,
    };
    data.findings = buildFindings(data);
    return data;
  } finally {
    await session.close();
  }
}
