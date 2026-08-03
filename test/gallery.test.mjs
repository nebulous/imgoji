// Integration test for the public gallery tab (docs/index.html). The shortener's
// GET /g is mocked to return two real imgoji strings as raw #s= share URLs; the
// gallery must decode each into an <imgoji-viewer> tile, render it non-blank, and
// loading a tile must put the render into the view tab. No deployed worker needed.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/docs/index.html';
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

// Raw #s= share URLs (decodeShare supports both #z deflated and #s raw).
const shareUrl = (str) => `http://localhost:${port}/docs/index.html#s=${encodeURIComponent(str)}`;
const moon = fs.readFileSync(path.join(ROOT, 'docs/examples/moon.imgoji'), 'utf8').trim();
const parrot = fs.readFileSync(path.join(ROOT, 'docs/examples/parrot.imgoji'), 'utf8').trim();
const payload = [
  { code: 'aaaaaa', url: shareUrl(moon), t: Date.now() - 1000 },
  { code: 'bbbbbb', url: shareUrl(parrot), t: Date.now() - 86400000 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ timeout: 60000 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.route('**/g', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));

await page.goto(`http://localhost:${port}/docs/index.html`);
await page.evaluate(() => document.fonts.ready);

await page.click('[data-tab="gallery"]');
await page.waitForSelector('.gtile imgoji-viewer', { timeout: 15000 });
await page.waitForTimeout(1500);   // let both streamed tiles decode

const status = await page.textContent('#galleryStatus');
const tileCount = await page.locator('.gtile').count();
const ranges = await page.$$eval('.gtile imgoji-viewer', (els) => els.map((el) => {
  const c = el.shadowRoot.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let mn = 255, mx = 0;
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] + d[i + 1] + d[i + 2]) / 3; if (g < mn) mn = g; if (g > mx) mx = g; }
  return mx - mn;
}));

await page.locator('.gtile').first().click();
await page.waitForTimeout(800);
const viewVisible = await page.locator('#view-panel').isVisible();
const mainRange = await page.evaluate(() => {
  const el = document.getElementById('viewer');
  const c = el.shadowRoot.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let mn = 255, mx = 0;
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] + d[i + 1] + d[i + 2]) / 3; if (g < mn) mn = g; if (g > mx) mx = g; }
  return mx - mn;
});

await browser.close(); server.close();

console.log('gallery:', { status, tileCount, ranges, viewVisible, mainRange, errors: errors.length ? errors : '(none)' });
const ok = tileCount === 2 && ranges.every(r => r > 20) && viewVisible && mainRange > 20 && errors.length === 0;
if (!ok) { console.error('FAIL'); process.exit(1); }
console.log('PASS: gallery tab rendered ' + tileCount + ' tiles and a click loaded the view tab');
