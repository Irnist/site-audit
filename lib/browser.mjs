// Headless Chrome for the crawl (puppeteer) and Lighthouse, sharing one browser on one debugging port.
import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';

export const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
export const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

export async function openBrowser() {
  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--mute-audio',
      // Two tabs work in turn; a background tab must keep rendering or its screenshot never arrives
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ],
  });
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  // Some hosts turn away "HeadlessChrome"; present as the regular browser it is
  const desktopUA = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');

  async function tab(kind) {
    const page = await browser.newPage();
    await page.setViewport(kind === 'phone' ? PHONE : DESKTOP);
    await page.setUserAgent(kind === 'phone' ? PHONE_UA : desktopUA);
    return page;
  }

  return {
    port: chrome.port,
    browser,
    tab,
    async close() {
      await browser.disconnect().catch(() => {});
      await chrome.kill();
    },
  };
}

// Load a page and let it settle: load event, a quiet network (capped), web fonts, then a beat for intro motion
export async function load(page, url, { settle = 1200, idle = 8000 } = {}) {
  let response = null;
  let error = null;
  await page.bringToFront();
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  } catch (e) {
    error = e.name === 'TimeoutError' ? 'timed out after 45 s' : e.message.split('\n')[0];
  }
  if (!error || error.startsWith('timed out')) {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: idle }).catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await new Promise((r) => setTimeout(r, settle));
  }
  return { status: response?.status() ?? 0, finalUrl: page.url(), error, robotsHeader: response?.headers()['x-robots-tag'] ?? null };
}
