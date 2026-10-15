// Google Lighthouse on a phone profile (Moto G Power on slow 4G, Lighthouse's default), boiled down to
// what the report needs: four scores, the Core Web Vitals, page weight and the failing audits.
import lighthouse from 'lighthouse';

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

export async function runLighthouse(url, port) {
  let result;
  try {
    result = await lighthouse(url, { port, output: 'json', logLevel: 'error', onlyCategories: CATEGORIES });
  } catch (e) {
    return { url, error: e.message.split('\n')[0] };
  }
  const lhr = result?.lhr;
  if (!lhr) return { url, error: 'Lighthouse returned no result' };
  if (lhr.runtimeError) return { url, error: lhr.runtimeError.message };
  try {
    return summarize(url, lhr);
  } catch (e) {
    // A Lighthouse result in a shape we don't expect must not cost the rest of the audit
    return { url, error: `could not read the Lighthouse result (${e.message})` };
  }
}

// The rows of an audit's details: tables and opportunities have an items array, insight "lists" nest
// tables inside, and checklists have none
function rows(details) {
  if (!details) return [];
  if (details.type === 'list') return (Array.isArray(details.items) ? details.items : []).flatMap(rows);
  return Array.isArray(details.items) ? details.items : [];
}

function summarize(url, lhr) {
  const audit = (id) => lhr.audits[id];
  const num = (id) => audit(id)?.numericValue ?? null;
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, lhr.categories[c]?.score == null ? null : Math.round(lhr.categories[c].score * 100)]));

  const failing = {};
  for (const cat of CATEGORIES) {
    failing[cat] = [];
    for (const ref of lhr.categories[cat]?.auditRefs ?? []) {
      const a = audit(ref.id);
      if (!a || a.score == null || a.score >= 0.9) continue;
      if (!['binary', 'numeric', 'metricSavings'].includes(a.scoreDisplayMode)) continue;
      const items = rows(a.details);
      const savingsMs = a.details?.overallSavingsMs ?? a.metricSavings?.LCP ?? 0;
      const savingsBytes = a.details?.overallSavingsBytes ?? 0;
      // Performance: only audits that cost real time or bytes (the metrics themselves are reported separately)
      if (cat === 'performance' && (ref.group === 'metrics' || (savingsMs < 100 && savingsBytes < 50000 && !(a.metricSavings?.CLS > 0.01)))) continue;
      if (cat !== 'performance' && ref.weight === 0 && a.scoreDisplayMode !== 'metricSavings') continue;
      failing[cat].push({
        id: ref.id,
        title: a.title,
        display: a.displayValue ?? '',
        savingsMs: Math.round(savingsMs),
        savingsBytes,
        count: items.length,
        samples: items.slice(0, 3).map((it) => String(it?.node?.nodeLabel || it?.node?.snippet || it?.url || it?.source?.url || '')).filter(Boolean),
      });
    }
  }
  failing.performance.sort((a, b) => b.savingsMs - a.savingsMs || b.savingsBytes - a.savingsBytes);

  return {
    url,
    scores,
    vitals: {
      lcp: num('largest-contentful-paint'),
      fcp: num('first-contentful-paint'),
      cls: num('cumulative-layout-shift'),
      tbt: num('total-blocking-time'),
      si: num('speed-index'),
    },
    bytes: num('total-byte-weight'),
    failing,
    version: lhr.lighthouseVersion,
  };
}
