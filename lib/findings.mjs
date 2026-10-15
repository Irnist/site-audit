// Turn the raw audit data into findings a business owner can act on: what's wrong, why it matters to them,
// and how to fix it, each with the pages it affects. Also scores five areas and the site overall.
import { sameSite } from './crawl.mjs';

export const AREAS = [
  { id: 'speed', name: 'Speed' },
  { id: 'mobile', name: 'Phones' },
  { id: 'search', name: 'Google search' },
  { id: 'access', name: 'Accessibility' },
  { id: 'trust', name: 'Trust & contact' },
];

export const SEVERITY = {
  high: { label: 'Fix first', penalty: 30, rank: 0 },
  medium: { label: 'Fix soon', penalty: 12, rank: 1 },
  low: { label: 'Nice to have', penalty: 4, rank: 2 },
};

const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
const be = (n, one, many) => (n === 1 ? one : many);
const secs = (ms) => (ms / 1000).toFixed(1);
// Download size in MB, or KB when it would round to 0.0 MB
const size = (b) => (b < 104858 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

// Plain words for the Lighthouse accessibility and SEO audits that come up most on small-business sites
const LH_PLAIN = {
  'color-contrast': ['medium', 'Some text is hard to read against its background', 'Low-contrast text is hard to read for older visitors and anyone on a phone in sunlight.', 'Darken the text or lighten its background until the contrast ratio is at least 4.5:1.'],
  'link-name': ['medium', 'Some links have no name for screen readers', 'Blind visitors hear "link" with no idea where it goes, often on icon-only social or phone links.', 'Give icon-only links an aria-label, such as aria-label="Call us".'],
  'button-name': ['medium', 'Some buttons have no name for screen readers', 'Blind visitors hear "button" with no idea what it does (menus, sliders, close buttons).', 'Add visible text or an aria-label to every button.'],
  label: ['medium', 'Some form fields have no label', 'Screen readers can\'t say what to type, and the field\'s hint disappears for everyone once they start typing.', 'Give each field a <label> tied to it with for="…".'],
  'select-name': ['medium', 'Some drop-down menus have no label', 'Screen readers can\'t say what the menu is for.', 'Give each <select> a <label>.'],
  'heading-order': ['low', 'Headings skip levels', 'Screen-reader users jump through a page by its headings; skipped levels make the outline confusing.', 'Use headings in order (H2, then H3) and style them with CSS instead of picking a level for its size.'],
  'aria-allowed-attr': ['low', 'Some elements use accessibility attributes wrongly', 'Wrong ARIA attributes can make assistive technology announce the page incorrectly.', 'Remove the ARIA attributes Lighthouse lists, or use the ones that element supports.'],
  'frame-title': ['low', 'Embedded maps or videos have no title', 'Screen readers announce an unnamed frame, so visitors don\'t know what it is.', 'Add a title to each iframe, such as title="Map to our shop".'],
  'meta-viewport': ['medium', 'Zooming is turned off on phones', 'Visitors with poor eyesight can\'t pinch to zoom in on text.', 'Remove user-scalable=no and maximum-scale from the viewport tag.'],
  'link-text': ['low', 'Some links just say "click here" or "read more"', 'Google and screen readers use link text to understand where a link goes.', 'Make link text say where it leads, such as "See our drain cleaning service".'],
  'crawlable-anchors': ['low', 'Some links can\'t be followed by Google', 'Links built only with JavaScript are invisible to Google, so the pages behind them may not be found.', 'Use real <a href="…"> links for navigation.'],
  canonical: ['medium', 'A page tells Google the wrong main address', 'An invalid canonical tag can make Google skip the page or list the wrong one.', 'Point each page\'s canonical tag at its own final address.'],
  'robots-txt': ['medium', 'robots.txt has errors', 'Google may misread which pages it\'s allowed to visit.', 'Fix the lines Lighthouse lists in robots.txt.'],
  'http-status-code': ['high', 'A page returns an error code to Google', 'Google drops pages that answer with an error.', 'Make the page return 200 OK, or redirect it to its replacement.'],
  hreflang: ['low', 'Language versions are marked up wrongly', 'Google may show visitors the wrong language version.', 'Fix the hreflang tags Lighthouse lists.'],
};
// Covered by the crawl's own checks on every page, so Lighthouse's copy would only repeat them
const LH_SKIP = new Set(['image-alt', 'document-title', 'meta-description', 'is-crawlable', 'html-has-lang', 'target-size', 'errors-in-console', 'is-on-https']);

const LOCAL_TYPES = /LocalBusiness|Store|Shop|Restaurant|Cafe|Bakery|Plumber|Electrician|Contractor|Roofing|HVAC|Locksmith|Dentist|Physician|Clinic|MedicalBusiness|AutoRepair|AutoDealer|AutomotiveBusiness|Salon|Spa|Hotel|Lodging|Agency|Attorney|LegalService|RealEstate|Moving|Cleaning|Gym|HealthClub|Organization|NGO|Church|School|Person/i;

export function buildFindings(d) {
  const issues = [];
  const passes = [];
  const add = (f) => issues.push({ where: [], evidence: [], ...f });
  const pass = (area, text) => passes.push({ area, text });
  const pages = d.pages;
  const home = pages[0];
  const pathsOf = (list) => list.map((p) => p.path);
  const lh = d.lighthouse.filter((r) => !r.error);
  const lhFailing = (cat, id) => lh.filter((r) => r.failing[cat]?.some((a) => a.id === id));
  const thisYear = new Date(d.started).getFullYear();

  // Lighthouse audits with plain words get a finding each; the rest share one, listed by Lighthouse's title
  const addLighthouse = (cat, area, other) => {
    const rest = [];
    for (const [id, a] of lhAuditsBy(lh, cat)) {
      if (!LH_PLAIN[id]) { rest.push(a); continue; }
      const [severity, title, why, fix] = LH_PLAIN[id];
      add({ id: `lh-${id}`, area, severity, title, why, fix, where: a.paths, evidence: a.samples });
    }
    if (rest.length) add({
      id: `lh-other-${cat}`, area, severity: 'low', ...other,
      fix: 'A developer can open the Lighthouse report for these pages (Chrome DevTools, Lighthouse tab) to see each problem and where it is.',
      where: rest.flatMap((a) => a.paths), evidence: rest.map((a) => a.title.replace(/`/g, '')),
    });
  };

  // ---------------------------------------------------------------- speed (Lighthouse, mobile)
  if (lh.length) {
    const worst = (k) => lh.reduce((a, b) => ((b.vitals[k] ?? -1) > (a.vitals[k] ?? -1) ? b : a));
    const w = worst('lcp');
    const lcp = w.vitals.lcp;
    if (lcp > 2500) {
      const tips = w.failing.performance.slice(0, 3).map((a) => `${a.title}${a.savingsMs ? ` (could save about ${secs(a.savingsMs)} s)` : a.savingsBytes ? ` (could save about ${Math.round(a.savingsBytes / 1024)} KB)` : ''}`);
      add({
        id: 'slow-lcp', area: 'speed', severity: lcp > 4000 ? 'high' : 'medium',
        title: `The main content takes ${secs(lcp)} s to appear on phones`,
        why: 'Google\'s target is under 2.5 seconds. Visitors on slow pages leave before they see what you offer, and speed is one of the signals Google ranks pages by.',
        fix: 'Compress and resize the largest image (usually the hero photo) and don\'t lazy-load it. Remove or delay scripts that hold the page back.',
        where: [w.path], evidence: tips.length ? ['Biggest savings Lighthouse found:', ...tips] : [],
      });
    } else if (lcp != null) pass('speed', `The main content appears in ${secs(lcp)} s on a phone (Google's target: under 2.5 s).`);

    const c = worst('cls');
    if (c.vitals.cls > 0.1) add({
      id: 'layout-shift', area: 'speed', severity: c.vitals.cls > 0.25 ? 'high' : 'medium',
      title: 'Parts of the page jump around while it loads',
      why: `Visitors tap the wrong thing when content moves under their finger. The layout shift score is ${c.vitals.cls.toFixed(2)}; Google's target is under 0.1.`,
      fix: 'Give images, videos and embeds a fixed width and height (or an aspect-ratio), and reserve space for banners that load late.',
      where: [c.path],
    });
    else pass('speed', 'The layout stays put while the page loads.');

    const t = worst('tbt');
    if (t.vitals.tbt > 200) add({
      id: 'blocking-time', area: 'speed', severity: t.vitals.tbt > 600 ? 'high' : 'medium',
      title: `The page freezes for ${Math.round(t.vitals.tbt)} ms while scripts run`,
      why: 'While it\'s frozen, taps and scrolls don\'t respond, so the site feels broken. Google\'s target is under 200 ms.',
      fix: 'Remove plugins and third-party scripts the site doesn\'t need (chat widgets, extra trackers, sliders), and load the rest after the page appears.',
      where: [t.path],
    });

    const homeLh = lh.find((r) => r.path === home.path);
    if (homeLh?.bytes != null) {
      if (homeLh.bytes > 3 * 1048576) add({
        id: 'page-weight', area: 'speed', severity: homeLh.bytes > 5 * 1048576 ? 'high' : 'medium',
        title: `The homepage is a ${size(homeLh.bytes)} download`,
        why: 'Heavy pages load slowly on mobile data and use up visitors\' data plans. A small-business homepage can usually stay under 2 MB.',
        fix: 'Serve photos as WebP or AVIF at the size they\'re shown, and remove unused fonts, scripts and videos.',
        where: [home.path],
      });
      else pass('speed', `The homepage is a light ${size(homeLh.bytes)} download.`);
    }
  }

  // ---------------------------------------------------------------- phones
  const noViewport = pages.filter((p) => !p.viewport || !/width\s*=\s*device-width/i.test(p.viewport));
  if (noViewport.length) add({
    id: 'no-viewport', area: 'mobile', severity: 'high',
    title: noViewport.length === pages.length ? 'The site isn\'t set up for phones' : `${plural(noViewport.length, 'page')} ${be(noViewport.length, 'isn\'t', 'aren\'t')} set up for phones`,
    why: 'Without a viewport tag, phones show a shrunken desktop page that visitors have to pinch and zoom to read.',
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head> of every page.',
    where: pathsOf(noViewport),
  });

  const wide = pages.filter((p) => p.overflow);
  if (wide.length) add({
    id: 'mobile-overflow', area: 'mobile', severity: 'high',
    title: `${plural(wide.length, 'page')} ${be(wide.length, 'is', 'are')} wider than a phone screen`,
    why: 'Depending on the phone, the page wobbles sideways as visitors scroll, opens zoomed out with tiny text, or cuts off whatever sticks out past the right edge. Each one looks broken.',
    fix: 'Let the wide element fit: max-width: 100% on images, tables and embeds, allow long words, emails and links to wrap, and check which header or menu shows at phone widths.',
    where: pathsOf(wide),
    evidence: [
      `On ${wide[0].path === '/' ? 'the homepage' : wide[0].path}, at ${wide[0].overflow.width}px wide, the page is ${wide[0].overflow.scrollWidth}px${wide[0].overflow.offenders.length ? ':' : '. Nothing visible sticks out, so look for an empty or hidden element that\'s too wide.'}`,
      ...wide[0].overflow.offenders,
    ],
  });
  else pass('mobile', `${pages.length === 1 ? 'The page fits' : `All ${pages.length} pages fit`} a phone screen with no sideways scrolling.`);

  const phonePages = pages.filter((p) => p.phones.length);
  const untappable = phonePages.filter((p) => !p.tel);
  const anyTel = pages.some((p) => p.tel);
  if (untappable.length) add({
    id: 'no-tap-to-call', area: 'mobile', severity: anyTel ? 'low' : 'medium',
    title: anyTel ? `On ${plural(untappable.length, 'page')}, the phone number isn't tap-to-call` : 'The phone number isn\'t tap-to-call',
    why: 'On a phone, people expect to tap a number to call it. Making them copy it by hand loses calls.',
    fix: 'Wrap the number in a call link, e.g. <a href="tel:+15551234567">(555) 123-4567</a>.',
    where: pathsOf(untappable), evidence: [`Number found: ${untappable[0].phones[0]}`],
  });
  else if (anyTel) pass('mobile', 'The phone number is tap-to-call.');

  const smallTargets = lhFailing('accessibility', 'target-size');
  if (smallTargets.length) add({
    id: 'tap-targets', area: 'mobile', severity: 'low',
    title: 'Some buttons and links are too small or too close together to tap',
    why: 'Visitors hit the wrong link with their thumb and have to go back.',
    fix: 'Make tap targets at least 24×24 px (ideally 44×44) with space between them.',
    where: smallTargets.map((r) => r.path),
    evidence: smallTargets[0].failing.accessibility.find((a) => a.id === 'target-size').samples,
  });

  // ---------------------------------------------------------------- Google search
  if (d.site.robots.blocksAll) add({
    id: 'robots-blocked', area: 'search', severity: 'high',
    title: 'robots.txt tells Google to stay away from the whole site',
    why: 'Google won\'t crawl any page, so the site can drop out of search results entirely.',
    fix: 'Remove the "Disallow: /" line for "User-agent: *" (it\'s often left over from a staging site).',
    where: ['/robots.txt'],
  });

  const noindex = pages.filter((p) => /noindex/i.test(`${p.robots ?? ''} ${p.robotsHeader ?? ''}`));
  if (noindex.length) add({
    id: 'noindex', area: 'search', severity: 'high',
    title: `Google is told not to list ${plural(noindex.length, 'page')}`,
    why: 'These pages carry a "noindex" tag or header, so they won\'t appear in Google at all.',
    fix: 'Remove noindex from every page you want people to find. It\'s often left over from building the site.',
    where: pathsOf(noindex),
  });

  const noTitle = pages.filter((p) => !p.title);
  if (noTitle.length) add({
    id: 'missing-title', area: 'search', severity: 'high',
    title: `${plural(noTitle.length, 'page')} ${noTitle.length === 1 ? 'has' : 'have'} no title`,
    why: 'The title is the blue headline of your Google listing. Without one, Google makes one up.',
    fix: 'Give every page a title: the service or topic first, then the business name and town.',
    where: pathsOf(noTitle),
  });
  const byTitle = groupBy(pages.filter((p) => p.title), (p) => p.title.toLowerCase());
  const dupTitles = [...byTitle.values()].filter((g) => g.length > 1);
  if (dupTitles.length) add({
    id: 'duplicate-title', area: 'search', severity: 'medium',
    title: `${plural(dupTitles.reduce((n, g) => n + g.length, 0), 'page')} share the same title`,
    why: 'Each page\'s title is its headline in Google. Identical titles make pages compete with each other, and Google may show the wrong one.',
    fix: 'Write a different title for each page that says what that page is about.',
    where: dupTitles.flat().map((p) => p.path), evidence: dupTitles.map((g) => `"${g[0].title}" on ${g.length} pages`),
  });
  const longTitles = pages.filter((p) => p.title && p.title.length > 65);
  if (longTitles.length) add({
    id: 'long-title', area: 'search', severity: 'low',
    title: `${plural(longTitles.length, 'page title')} ${be(longTitles.length, 'gets', 'get')} cut off in Google`,
    why: 'Google shows about 60 characters, so the end of a long title (often the business name) is lost.',
    fix: 'Keep titles under 60 characters with the most important words first.',
    where: pathsOf(longTitles), evidence: longTitles.slice(0, 3).map((p) => `${p.title.length} characters: "${p.title}"`),
  });
  if (!noTitle.length && !dupTitles.length && !longTitles.length) pass('search', 'Every page has its own title, short enough to show in full on Google.');

  const noDesc = pages.filter((p) => !p.description);
  if (noDesc.length) add({
    id: 'missing-description', area: 'search', severity: 'medium',
    title: `${plural(noDesc.length, 'page')} ${noDesc.length === 1 ? 'has' : 'have'} no search description`,
    why: 'The description is the text under your title in Google. Without one, Google picks a random snippet from the page, which often reads poorly and gets fewer clicks.',
    fix: 'Write a 120–160 character description for each page that says what you offer and where.',
    where: pathsOf(noDesc),
  });
  const dupDesc = [...groupBy(pages.filter((p) => p.description), (p) => p.description.toLowerCase()).values()].filter((g) => g.length > 1);
  if (dupDesc.length) add({
    id: 'duplicate-description', area: 'search', severity: 'low',
    title: `${plural(dupDesc.reduce((n, g) => n + g.length, 0), 'page')} share the same search description`,
    why: 'Repeated descriptions make different pages look identical in Google\'s results.',
    fix: 'Write a description for each page about that page\'s service or topic.',
    where: dupDesc.flat().map((p) => p.path),
  });
  if (!noDesc.length && !dupDesc.length) pass('search', 'Every page has its own search description.');

  const noH1 = pages.filter((p) => !p.h1s.filter(Boolean).length);
  if (noH1.length) add({
    id: 'missing-h1', area: 'search', severity: 'medium',
    title: `${plural(noH1.length, 'page')} ${noH1.length === 1 ? 'has' : 'have'} no main heading`,
    why: 'The main heading (H1) tells visitors and Google what a page is about.',
    fix: 'Give each page one H1 that names its service or topic, such as "Emergency plumbing in Seattle".',
    where: pathsOf(noH1),
  });
  const manyH1 = pages.filter((p) => p.h1s.length > 1);
  if (manyH1.length) add({
    id: 'multiple-h1', area: 'search', severity: 'low',
    title: `${plural(manyH1.length, 'page')} ${manyH1.length === 1 ? 'has' : 'have'} more than one main heading`,
    why: 'Several H1s blur what the page is mainly about for Google and screen readers.',
    fix: 'Keep one H1 per page and make the others H2s (the look can stay the same).',
    where: pathsOf(manyH1), evidence: [`${manyH1[0].path}: ${manyH1[0].h1s.slice(0, 3).map((h) => `"${h.slice(0, 50)}"`).join(', ')}`],
  });
  if (!noH1.length && !manyH1.length) pass('search', 'Every page has one clear main heading.');

  const types = [...new Set(pages.flatMap((p) => p.schemaTypes))];
  const local = types.filter((t) => LOCAL_TYPES.test(t));
  if (!local.length) add({
    id: 'no-local-schema', area: 'search', severity: 'medium',
    title: 'Google doesn\'t get your business details in a form it can read',
    why: 'Structured data (LocalBusiness) gives Google your name, address, phone and hours exactly. It helps local searches and Google Maps match the site to your business.',
    fix: 'Add LocalBusiness JSON-LD to the homepage with your name, address, phone, opening hours and website, matching your Google Business Profile.',
    where: [home.path], evidence: types.length ? [`Found only: ${types.join(', ')}`] : [],
  });
  else pass('search', `Business details are marked up for Google (${local.slice(0, 3).join(', ')}).`);

  if (!d.site.sitemap.found && !d.site.local) add({
    id: 'no-sitemap', area: 'search', severity: 'low',
    title: 'No sitemap for Google',
    why: 'A sitemap lists every page so Google finds new and deep pages sooner.',
    fix: 'Create sitemap.xml (most site builders and SEO plugins do it automatically) and submit it in Google Search Console.',
  });
  else if (d.site.sitemap.found) pass('search', 'A sitemap lists the site\'s pages for Google.');

  if (!home.ogImage) add({
    id: 'no-share-image', area: 'search', severity: 'low',
    title: 'Links to the site show no preview picture when shared',
    why: 'When someone shares the site on Facebook, Messenger or Viber, a link with a picture gets far more attention than a bare one.',
    fix: 'Add an og:image tag pointing to a 1200×630 image, using its full https:// address.',
    where: [home.path],
  });
  else pass('search', 'Shared links show a preview picture.');

  addLighthouse('seo', 'search', {
    title: 'Lighthouse found other search problems',
    why: 'Each one makes it a little harder for Google to read or trust the page.',
  });

  // ---------------------------------------------------------------- accessibility
  const noAlt = pages.map((p) => ({ p, imgs: p.imgs.filter((i) => i.alt === null && i.src && !/facebook\.com\/tr|pixel|spacer|1x1/i.test(i.src)) })).filter((x) => x.imgs.length);
  if (noAlt.length) {
    const n = new Set(noAlt.flatMap((x) => x.imgs.map((i) => i.src))).size;
    add({
      id: 'img-alt', area: 'access', severity: 'medium',
      title: `${plural(n, 'image')} ${n === 1 ? 'has' : 'have'} no description (alt text)`,
      why: 'Blind visitors hear nothing (or a file name) where the image is, and Google can\'t tell what the photo shows, so it won\'t appear in image search.',
      fix: 'Describe each meaningful image in its alt attribute, such as alt="Technician fixing a water heater". Decorative images get alt="".',
      where: noAlt.map((x) => x.p.path), evidence: noAlt[0].imgs.slice(0, 3).map((i) => fileName(i.src)),
    });
  } else pass('access', 'Every image has a description (alt text) or is marked as decorative.');

  const noLang = pages.filter((p) => !p.lang);
  if (noLang.length) add({
    id: 'no-lang', area: 'access', severity: 'low',
    title: 'The page language isn\'t set',
    why: 'Screen readers may read the text with the wrong accent and pronunciation.',
    fix: 'Add the language to the <html> tag, e.g. <html lang="en">.',
    where: pathsOf(noLang),
  });

  addLighthouse('accessibility', 'access', {
    title: 'Lighthouse found other accessibility problems',
    why: 'These are technical problems in the page code that make the site harder to use with a screen reader or keyboard.',
  });
  if (lh.length && !lhAuditsBy(lh, 'accessibility').length) pass('access', 'Lighthouse found no accessibility problems on the pages it tested.');

  // ---------------------------------------------------------------- trust & contact
  const s = d.site;
  if (!s.local && !s.https) add({
    id: 'not-https', area: 'trust', severity: 'high',
    title: s.httpsAvailable ? 'The site opens on the insecure http:// address' : 'The site isn\'t secure (no HTTPS)',
    why: 'Browsers label the site "Not secure", which scares visitors off forms, and Google ranks secure sites higher.',
    fix: s.httpsAvailable ? 'Redirect every http:// address to https:// on the server or host.' : 'Turn on a free SSL certificate at the host (most include one) and redirect http:// to https://.',
  });
  else if (!s.local && s.httpRedirects === false) add({
    id: 'no-https-redirect', area: 'trust', severity: 'medium',
    title: 'The http:// address doesn\'t forward to the secure one',
    why: 'People who type the address or follow old links land on a page marked "Not secure".',
    fix: 'Redirect http:// to https:// at the host (usually a single setting).',
  });
  else if (!s.local) pass('trust', 'The site is secure (HTTPS), and the old http:// address forwards to it.');

  const mixed = lhFailing('best-practices', 'is-on-https');
  if (s.https && mixed.length) add({
    id: 'mixed-content', area: 'trust', severity: 'medium',
    title: 'Some files load over an insecure connection',
    why: 'Browsers block insecure files on secure pages, so images or scripts can silently go missing.',
    fix: 'Change the addresses of the files listed below from http:// to https://.',
    where: mixed.map((r) => r.path), evidence: mixed[0].failing['best-practices'].find((a) => a.id === 'is-on-https').samples,
  });

  const start = new URL(d.url);
  const broken = d.links.filter((l) => l.verdict === 'broken');
  const isInternal = (l) => { try { return sameSite(new URL(l.url), start); } catch { return false; } };
  const linkLine = (l) => `${shortUrl(l.url)} (${l.status ? `error ${l.status}` : l.error}), on ${l.pages.slice(0, 3).join(', ')}${l.pages.length > 3 ? '…' : ''}`;
  const brokenInternal = broken.filter((l) => l.kind === 'link' && isInternal(l));
  const brokenExternal = broken.filter((l) => l.kind === 'link' && !isInternal(l));
  const brokenImages = broken.filter((l) => l.kind === 'image');
  if (brokenInternal.length) add({
    id: 'broken-internal', area: 'trust', severity: 'high',
    title: `${plural(brokenInternal.length, 'link')} on the site lead${brokenInternal.length === 1 ? 's' : ''} to a missing page`,
    why: 'Visitors who hit an error page often give up, and Google sees it as a sign the site isn\'t kept up.',
    fix: 'Point each link at the right page, or redirect the old address to its replacement.',
    where: [...new Set(brokenInternal.flatMap((l) => l.pages))], evidence: brokenInternal.slice(0, 6).map(linkLine),
  });
  if (brokenExternal.length) add({
    id: 'broken-external', area: 'trust', severity: 'medium',
    title: `${plural(brokenExternal.length, 'link')} to other websites ${brokenExternal.length === 1 ? 'is' : 'are'} broken`,
    why: 'Dead links (often old social profiles, directories or partners) make the site look neglected.',
    fix: 'Update each link to the current address or remove it.',
    where: [...new Set(brokenExternal.flatMap((l) => l.pages))], evidence: brokenExternal.slice(0, 6).map(linkLine),
  });
  if (brokenImages.length) add({
    id: 'broken-images', area: 'trust', severity: 'medium',
    title: `${plural(brokenImages.length, 'image')} ${brokenImages.length === 1 ? 'doesn\'t' : 'don\'t'} load`,
    why: 'Visitors see an empty box or a broken-image icon instead of your photo.',
    fix: 'Re-upload the missing images or fix their addresses.',
    where: [...new Set(brokenImages.flatMap((l) => l.pages))], evidence: brokenImages.slice(0, 6).map(linkLine),
  });
  if (!broken.length) pass('trust', `No broken links or images among the ${plural(d.links.filter((l) => l.verdict === 'ok').length, 'address', 'addresses')} checked.`);

  const contactWays = pages.some((p) => p.tel || p.phones.length || p.mailto || p.forms.some((f) => f.fields >= 2));
  if (!contactWays) add({
    id: 'no-contact', area: 'trust', severity: 'high',
    title: 'Visitors can\'t find a way to contact you',
    why: 'No phone number, email link or contact form turned up on the pages checked. Every visitor who\'s ready to buy has nowhere to go.',
    fix: 'Put the phone number in the header and footer of every page, and add a contact page with a short form.',
  });
  else pass('trust', 'Visitors can reach the business by phone, email or a form.');

  const mailtoForms = pages.filter((p) => p.forms.some((f) => /^mailto:/i.test(f.action)));
  if (mailtoForms.length) add({
    id: 'mailto-form', area: 'trust', severity: 'medium',
    title: 'A form opens the visitor\'s email app instead of sending',
    why: 'Many people have no email app set up on their computer, so the message never sends and you never see the lead.',
    fix: 'Send the form through a form service (such as Formspree or Netlify Forms) or the site\'s own backend.',
    where: pathsOf(mailtoForms),
  });

  const years = pages.map((p) => p.copyrightYear).filter(Boolean);
  const year = years.length ? Math.max(...years) : null;
  if (year && year < thisYear) add({
    id: 'old-copyright', area: 'trust', severity: 'low',
    title: `The footer says © ${year}`,
    why: 'An old year makes visitors wonder whether the business is still open and the information still current.',
    fix: 'Update the year, or have the site fill in the current year automatically.',
    where: pathsOf(pages.filter((p) => p.copyrightYear === year)),
  });
  else if (year) pass('trust', `The footer's copyright year is current (${year}).`);

  if (!home.favicon) add({
    id: 'no-favicon', area: 'trust', severity: 'low',
    title: 'No icon in the browser tab',
    why: 'The small icon in tabs, bookmarks and Google\'s mobile results makes the site look finished and easy to spot.',
    fix: 'Add a favicon (your logo mark) with <link rel="icon" href="/favicon.png">.',
    where: [home.path],
  });

  const consoleErr = lhFailing('best-practices', 'errors-in-console');
  if (consoleErr.length) add({
    id: 'console-errors', area: 'trust', severity: 'low',
    title: 'The site has script errors',
    why: 'Errors can quietly break buttons, forms, maps or tracking without anyone noticing.',
    fix: 'Open the browser console on the pages listed and fix or remove the scripts that fail.',
    where: consoleErr.map((r) => r.path), evidence: consoleErr[0].failing['best-practices'].find((a) => a.id === 'errors-in-console').samples,
  });

  const slow = pages.filter((p) => p.slow);
  if (slow.length) add({
    id: 'slow-pages', area: 'speed', severity: 'medium',
    title: `${plural(slow.length, 'page')} took more than 45 s to finish loading`,
    why: 'Something on the page (often a widget or tracker) keeps loading long after the rest.',
    fix: 'Find the slow resource in the browser\'s network panel and remove or delay it.',
    where: pathsOf(slow),
  });

  issues.sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank);
  for (const f of issues) f.where = [...new Set(f.where)];

  // ---------------------------------------------------------------- scores
  const checkScore = (area) => Math.max(0, 100 - issues.filter((f) => f.area === area).reduce((n, f) => n + SEVERITY[f.severity].penalty, 0));
  const lhAvg = (cat) => {
    const v = lh.map((r) => r.scores[cat]).filter((x) => x != null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const seo = lhAvg('seo');
  const scores = {
    speed: lhAvg('performance'),
    mobile: checkScore('mobile'),
    search: seo == null ? checkScore('search') : Math.round((seo + checkScore('search')) / 2),
    access: lhAvg('accessibility') ?? checkScore('access'),
    trust: checkScore('trust'),
  };
  const vals = Object.values(scores).filter((v) => v != null);
  const overall = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  const grade = overall >= 90 ? 'A' : overall >= 80 ? 'B' : overall >= 70 ? 'C' : overall >= 60 ? 'D' : 'F';

  return { issues, passes, scores, overall, grade };
}

// Failing Lighthouse audits of one category across the tested pages, merged by audit id
function lhAuditsBy(lh, cat) {
  const out = new Map();
  for (const r of lh) {
    for (const a of r.failing[cat] ?? []) {
      if (LH_SKIP.has(a.id)) continue;
      if (!out.has(a.id)) out.set(a.id, { title: a.title, paths: [], samples: a.samples });
      out.get(a.id).paths.push(r.path);
    }
  }
  return [...out];
}

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function fileName(src) {
  try { return decodeURIComponent(new URL(src).pathname.split('/').pop()) || src; } catch { return src; }
}

function shortUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').slice(0, 90);
}
