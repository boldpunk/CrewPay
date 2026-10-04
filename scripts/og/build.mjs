// Рендер public/og.png из scripts/og/og.html (нужен Playwright с Chromium).
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const src = new URL('./og.html', import.meta.url);
const out = fileURLToPath(new URL('../../public/og.png', import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(src.href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`→ ${out}`);
