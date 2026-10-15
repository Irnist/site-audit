// Visit the homepage and up to maxPages-1 more same-site pages (shallow pages first; menu links, then body
// links, then the sitemap). Each page loads twice: once at desktop size for its content and once on an
// emulated phone for the sideways-scroll check. The homepage also gets a screenshot of each.
import { load } from './browser.mjs';

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|docx?|xlsx?|pptx?|csv|txt|xml|mp4|mov|webm|mp3|wav)$/i;

const bareHost = (h) => h.replace(/^www\./i, '').toLowerCase();
export const sameSite = (a, b) => bareHost(a.hostname) === bareHost(b.hostname);

// One key per page: scheme-less host + path, no query, hash or trailing slash
export function pageKey(url) {
  const u = new URL(url);
  return bareHost(u.hostname) + (u.pathname.replace(/\/index\.(html?|php)$/i, '/').replace(/\/+$/, '') || '/');
}

export function pathOf(url) {
  const u = new URL(url);
  return (u.pathname + u.search) || '/';
}

// Runs in the page
function collect() {
  const q = (s) => document.querySelector(s);
  const meta = (n) => q(`meta[name="${n}" i]`)?.getAttribute('content')?.trim() ?? null;
  const prop = (p) => q(`meta[property="${p}" i]`)?.getAttribute('content')?.trim() ?? null;

  const types = new Set();
  let ldErrors = 0;
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const t = n['@type'];
    for (const x of Array.isArray(t) ? t : t ? [t] : []) types.add(String(x));
    if (n['@graph']) walk(n['@graph']);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json" i]')) {
    try { walk(JSON.parse(s.textContent)); } catch { ldErrors++; }
  }
  // Microdata counts too (older themes)
  for (const el of document.querySelectorAll('[itemtype]')) {
    const t = el.getAttribute('itemtype').split('/').pop();
    if (t) types.add(t);
  }

  const links = [...document.querySelectorAll('a[href]')].map((a) => ({
    href: a.href,
    raw: a.getAttribute('href').trim(),
    text: (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    nav: !!a.closest('header, nav, footer, [role="navigation"]'),
  }));
  const imgs = [...document.images].map((i) => ({ src: i.currentSrc || i.src, alt: i.getAttribute('alt') }));

  const text = document.body?.innerText ?? '';
  const footerText = [...document.querySelectorAll('footer, [role="contentinfo"]')].map((f) => f.innerText).join('\n')
    || text.slice(-2500);
  const years = [...footerText.matchAll(/(?:©|&copy;|\(c\)|copyright)[^\d\n]{0,40}((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi)]
    .map((m) => Number(m[2] || m[1]));
  // Phone numbers as people write them: 10-15 digits with separators, brackets or a leading +
  const phones = [...new Set((text.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)\s?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b/g) || [])
    .map((s) => s.trim())
    .filter((s) => { const d = s.replace(/\D/g, ''); return d.length >= 10 && d.length <= 15; }))].slice(0, 5);

  return {
    title: document.title.trim(),
    description: meta('description'),
    robots: meta('robots'),
    viewport: meta('viewport'),
    canonical: q('link[rel="canonical" i]')?.href ?? null,
    lang: document.documentElement.getAttribute('lang'),
    ogImage: prop('og:image'),
    favicon: !!q('link[rel~="icon" i]'),
    h1s: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim().replace(/\s+/g, ' ')),
    schemaTypes: [...types],
    ldErrors,
    links,
    imgs,
    tel: links.filter((l) => /^tel:/i.test(l.raw)).length,
    mailto: links.filter((l) => /^mailto:/i.test(l.raw)).length,
    phones,
    forms: [...document.forms].map((f) => ({
      action: f.getAttribute('action') || '',
      fields: [...f.elements].filter((e) => !['hidden', 'submit', 'button'].includes(e.type)).length,
    })),
    copyrightYear: years.length ? Math.max(...years) : null,
    words: text.split(/\s+/).filter(Boolean).length,
  };
}

// Runs in the page at phone width: is anything wider than the screen?
function sideways() {
  const w = document.documentElement.clientWidth;
  const sw = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
  if (sw <= w + 1) return null;
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    const t = (el.innerText || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 40).trim();
    return t ? `${s} ("${t}")` : s;
  };
  // The outermost visible elements that stick out past the right edge. Invisible ones (a page builder's
  // hidden sticky-header spacer, say) still widen the page but show nothing to cut off.
  const seen = (el) => el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true;
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= w + 1 || getComputedStyle(el).position === 'fixed' || !seen(el)) continue;
    if (out.some((o) => o.el.contains(el))) continue;
    out.push({ el, right: Math.round(r.right) });
    if (out.length >= 3) break;
  }
  // The site clips what sticks out (overflow-x: hidden/clip) and nothing visible does: the page fits
  const clipped = [document.documentElement, document.body].some((el) => /hidden|clip/.test(getComputedStyle(el).overflowX));
  if (clipped && !out.length) return null;
  return { width: w, scrollWidth: sw, offenders: out.map((o) => `${name(o.el)} reaches ${o.right}px`) };
}

export async function crawl(session, startUrl, { maxPages = 10, extraUrls = [], log = () => {} } = {}) {
  const desk = await session.tab('desktop');
  const phone = await session.tab('phone');
  const start = new URL(startUrl);
  const queue = [{ href: startUrl, depth: -1, tier: 0, order: -1 }];
  const queued = new Set([pageKey(startUrl)]);
  const done = new Set();
  const pages = [];
  const failed = [];
  const shots = {};

  const enqueue = (href) => {
    let u;
    try { u = new URL(href); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u, start) || SKIP_EXT.test(u.pathname)) return;
    u.hash = '';
    const k = pageKey(u.href);
    if (queued.has(k)) return;
    queued.add(k);
    queue.push({ href: u.href, depth: u.pathname.split('/').filter(Boolean).length, tier, order: order++ });
  };
  // Next page: the shallowest first (About, Contact and Services before each single service), then
  // menu links before links in the page body, then sitemap-only pages, in the order they were found
  let order = 0;
  let tier = 0;
  const next = () => {
    queue.sort((a, b) => a.depth - b.depth || a.tier - b.tier || a.order - b.order);
    return queue.shift().href;
  };

  while (queue.length && pages.length < maxPages) {
    const url = next();
    log(`  page ${pages.length + 1}/${maxPages}: ${url}`);
    // The homepage gets time to settle for its screenshots; other pages only need their content
    const isHome = pages.length === 0;
    const nav = await load(desk, url, isHome ? {} : { settle: 400, idle: 3000 });
    if (nav.error && !nav.error.startsWith('timed out')) {
      failed.push({ url, status: nav.status, error: nav.error });
      continue;
    }
    if (nav.status >= 400) {
      failed.push({ url, status: nav.status, error: `HTTP ${nav.status}` });
      continue;
    }
    const final = new URL(nav.finalUrl);
    if (!sameSite(final, start)) continue;  // redirected off-site
    const key = pageKey(nav.finalUrl);
    if (done.has(key)) continue;            // a redirect to a page already checked
    done.add(key);
    queued.add(key);

    const data = await desk.evaluate(collect);
    if (isHome) {
      shots.desktop = await desk.screenshot({ type: 'jpeg', quality: 72, encoding: 'base64' });
    }

    await load(phone, nav.finalUrl, isHome ? {} : { settle: 400, idle: 3000 });
    const overflow = await phone.evaluate(sideways).catch(() => null);
    if (isHome) {
      shots.phone = await phone.screenshot({ type: 'jpeg', quality: 72, encoding: 'base64' });
    }

    pages.push({ url: nav.finalUrl, path: pathOf(nav.finalUrl), status: nav.status, slow: !!nav.error, robotsHeader: nav.robotsHeader, ...data, overflow });

    const links = data.links.filter((l) => /^https?:/i.test(l.href));
    for (const l of links) {
      tier = l.nav ? 0 : 1;
      enqueue(l.href);
    }
    if (isHome) {
      tier = 2;
      for (const u of extraUrls) enqueue(u);
    }
  }

  await desk.close();
  await phone.close();
  return { pages, failed, shots };
}
