// Pre-render the view-tab example images to .imgoji string files.
// Run from the repo root:  node gen-examples.mjs
//
// Serves the repo over http and encodes each image in headless Chromium (the system
// emoji font supplies the glyphs), at the per-example budget and the codec's blend
// default (alpha 1). Writes docs/examples/<name>.imgoji. Re-run whenever the budgets,
// images, or blend default change.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.css':'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/docs/index.html';
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (err, d) => { if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

// name -> source image, deflated-byte budget, quadtree depth. Ascending budget.
const EXAMPLES = [
  { name: 'moon',  img: '/assets/earth.jpg',                      bytes: 1024, depth: 6 },
  { name: 'depth', img: '/assets/img/test_image_depthmap.jpg',    bytes: 2048, depth: 7 },
  { name: 'stick', img: '/assets/img/test_image_stickfigure.jpg', bytes: 3072, depth: 7 },
  { name: 'parrot', img: '/assets/img/test_image_parrot.jpg',     bytes: 4096, depth: 7 },
  { name: 'city',  img: '/assets/img/test_image_cityphoto.jpg',   bytes: 8192, depth: 7 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/docs/index.html`);  // loads ../assets/emoji-list.js
const outDir = path.join(ROOT, 'docs', 'examples');
fs.mkdirSync(outDir, { recursive: true });
for (const ex of EXAMPLES) {
  const str = await page.evaluate(async ({ imgUrl, bytes, depth }) => {
    await document.fonts.ready;
    const { Encoder } = await import('/src/index.js');
    const img = await new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = imgUrl; });
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d', { willReadFrequently: true });
    const s = Math.max(256 / img.width, 256 / img.height), w = img.width * s, h = img.height * s;
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 256, 256); x.drawImage(img, (256 - w) / 2, (256 - h) / 2, w, h);
    const enc = new Encoder({ compare: 32 }); enc.alpha = 1;
    const out = await enc.encode(c, { depth, byteTarget: bytes });
    return out.string;
  }, { imgUrl: ex.img, bytes: ex.bytes, depth: ex.depth });
  fs.writeFileSync(path.join(outDir, ex.name + '.imgoji'), str);
  console.log(ex.name.padEnd(7), str.length, 'chars');
}
await browser.close(); server.close();
console.log('wrote', EXAMPLES.length, 'files to docs/examples/');
