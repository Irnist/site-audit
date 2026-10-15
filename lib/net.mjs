// Plain HTTP checks: site-wide files (HTTPS redirect, robots.txt, sitemap) and every link and image found.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function get(url, { method = 'GET', timeout = 12000 } = {}) {
  try {
    const r = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    return { status: r.status, url: r.url, res: r };
  } catch (e) {
    const code = e.cause?.code || (e.name === 'TimeoutError' ? 'TIMEOUT' : e.name);
    return { status: 0, url, error: code };
  }
}

async function text(url) {
  const r = await get(url);
  if (r.status !== 200) return { status: r.status, body: '' };
  return { status: 200, body: await r.res.text().catch(() => '') };
}

const isLocal = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

export async function siteChecks(startUrl) {
  const start = new URL(startUrl);
  const out = { local: isLocal(start.hostname), https: start.protocol === 'https:', httpRedirects: null };

  // Does the plain http:// address forward to https://?
  if (!out.local) {
    if (out.https) {
      const r = await get(`http://${start.host}${start.pathname}`);
      out.httpRedirects = r.status ? r.url.startsWith('https:') : null;
    } else {
      const r = await get(`https://${start.host}${start.pathname}`);
      out.httpsAvailable = r.status > 0 && r.status < 400;
    }
  }

  // robots.txt: present? blocks everything for every crawler? which sitemaps does it name?
  const robots = await text(new URL('/robots.txt', start).href);
  out.robots = { found: robots.status === 200 && !/<html/i.test(robots.body), blocksAll: false, sitemaps: [] };
  if (out.robots.found) {
    let agents = [];
    let inRules = false;
    for (const raw of robots.body.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
      if (!m) continue;
      const field = m[1].toLowerCase();
      const value = m[2].trim();
      if (field === 'sitemap') {
        try { out.robots.sitemaps.push(new URL(value, start).href); } catch { /* not an address */ }
        continue;
      }
      if (field === 'user-agent') {
        if (inRules) { agents = []; inRules = false; }
        agents.push(value);
      } else {
        inRules = true;
        if (field === 'disallow' && value === '/' && agents.includes('*')) out.robots.blocksAll = true;
      }
    }
  }

  // Sitemap: the ones robots.txt names, else the usual addresses. Keep its page URLs to help the crawl.
  const candidates = [...out.robots.sitemaps, ...['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'].map((p) => new URL(p, start).href)];
  out.sitemap = { found: false, url: null, urls: [] };
  for (const url of candidates) {
    const r = await text(url);
    if (r.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(r.body)) continue;
    out.sitemap = { found: true, url, urls: [] };
    let locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    if (/<sitemapindex\b/i.test(r.body) && locs.length) {
      const child = await text(locs[0]);
      locs = [...child.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    }
    out.sitemap.urls = locs.slice(0, 200);
    break;
  }
  return out;
}

// Check each URL (HEAD, then GET when HEAD is refused or fails), 8 at a time
export async function checkUrls(urls, { limit = 400, log = () => {} } = {}) {
  const list = [...urls].slice(0, limit);
  const results = new Map();
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const url = list[i++];
      let r = await get(url, { method: 'HEAD' });
      if (r.status === 0 || r.status >= 400) {
        const g = await get(url);
        g.res?.body?.cancel().catch(() => {});
        r = g;
      }
      results.set(url, { status: r.status, error: r.error ?? null, verdict: verdict(r) });
    }
  }
  if (list.length) log(`  checking ${list.length} links and images`);
  await Promise.all(Array.from({ length: 8 }, worker));
  return { results, skipped: Math.max(0, urls.size - list.length) };
}

// broken: the page or file is gone. unverified: the server refused an automated check (social sites do).
function verdict(r) {
  if (r.status === 0) return ['ENOTFOUND', 'ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'].includes(r.error) ? 'broken' : 'unverified';
  // (LinkedIn answers bots with a made-up 999, so only real 5xx codes count as server errors)
  if (r.status === 404 || r.status === 410 || (r.status >= 500 && r.status <= 599)) return 'broken';
  if (r.status >= 400) return 'unverified';
  return 'ok';
}
