// imgoji docs tool. Three tabs over the componentized library:
//   - view:   <imgoji-viewer> decodes any string (front door, with pre-rendered examples)
//   - encode: Encoder.encode(image, { depth, byteTarget, ... }) -> quadtree string
//   - grid:   Encoder.rasterize(image, { cols, rows }) -> flat emoji grid
//
// Serve from the repo root so ../src/index.js and ../assets/emoji-list.js resolve.
import { Encoder, Renderer, MAX_RES, splitGraphemes, rleExpand, encodePrefix, deflateRaw, inflateRaw, b64urlEncode, b64urlDecode } from '../src/index.js';
import { SemanticGrid } from '../src/semantic-grid.js';

const $ = (id) => document.getElementById(id);
const WORK = 256;
const fontsReady = (typeof document !== 'undefined' && document.fonts) ? document.fonts.ready : Promise.resolve();
// The deployed Cloudflare Worker that shortens imgoji share links. Empty until you
// deploy shortener/ and paste its URL here (see shortener/README.md).
const SHORTENER = 'https://imgoji.nebulous-31a.workers.dev';   // deployed Cloudflare Worker (shortener/)

// Off-screen 256x256 source the encode/grid tabs share; #orig mirrors it as the
// picker preview.
const source = document.createElement('canvas');
source.width = source.height = WORK;
const sctx = source.getContext('2d', { willReadFrequently: true });
const octx = $('orig').getContext('2d', { willReadFrequently: true });

// Detail slider = deflated byte budget in powers of two (64 B..64 KB); depth
// scales with it. 64 KB at depth 8 is past the codec ceiling (one pixel per cell
// at 256^2), so the top reaches the real maximum output.
const LEVELS = [
  { bytes: 64,    depth: 4 },
  { bytes: 128,   depth: 5 },
  { bytes: 256,   depth: 5 },
  { bytes: 512,   depth: 6 },
  { bytes: 1024,  depth: 6 },
  { bytes: 2048,  depth: 7 },
  { bytes: 4096,  depth: 8 },
  { bytes: 8192,  depth: 8 },
  { bytes: 16384, depth: 8 },
  { bytes: 32768, depth: 8 },
  { bytes: 65536, depth: 8 },
];
const ADV_DEFAULTS = { alpha: 1, compare: 32, threshold: 0, detailGate: 0, skipBias: 0, bilateral: true, bilateralR: 32 };
const readAdv = () => ({
  alpha: parseFloat($('advAlpha').value),
  compare: parseInt($('advCompare').value, 10),
  threshold: parseInt($('advThreshold').value, 10),
  detailGate: parseFloat($('advDetailGate').value),
  skipBias: parseFloat($('advSkipBias').value),
  bilateral: $('advBilateral').checked ? parseFloat($('advBilateralR').value) : undefined,
});

let enc = null;       // encode/grid encoder (compare 32), created lazily
let busy = false;

const fmtBytes = (b) =>
  b >= 1000 ? (b / 1000).toFixed(b >= 10000 ? 0 : 1).replace(/\.0$/, '') + ' KB' : b + ' B';

// The Encoder carries scratch/canvas state, so uses of it are serialized through one
// chain (quad encode + grid rasterize).
let encChain = Promise.resolve();
const encTask = (fn) => { const p = encChain.then(fn); encChain = p.then(() => {}, () => {}); return p; };

function ensureEncoder() {
  if (!enc) { enc = new Encoder({ compare: 32 }); enc.onProgress = onProgress; }
  return enc;
}

// ---- semantic grid (CLIP + OWL-ViT) -------------------------------------
// Detail slider maps to a square resolution; autotune sets blend/threshold from it.
// Detail slider value IS the resolution (1×1..80×80, step 1); λ = 3/cols autotunes from it.
// WebGPU only if an adapter is actually obtainable (navigator.gpu existing isn't enough — headless
// or unsupported GPUs expose it but fail to get an adapter). ?device=wasm forces a fallback.
const PARAM_DEVICE = (typeof location !== 'undefined') && new URLSearchParams(location.search).get('device');
const DEVICE_PROMISE = PARAM_DEVICE
  ? Promise.resolve(PARAM_DEVICE)
  : (async () => {
      if (typeof navigator === 'undefined' || !navigator.gpu) return 'wasm';
      try { return (await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm'; } catch { return 'wasm'; }
    })();
let sg = null;
let hasSourceImage = false;
// Semantic grids are opt-in: they download CLIP + OWL-ViT and run them locally. Remembered.
let semanticEnabled = (typeof localStorage !== 'undefined' && localStorage.getItem('imgoji.grid.semantic') === '1');
let encodeSemanticEnabled = (typeof localStorage !== 'undefined' && localStorage.getItem('imgoji.encode.semantic') === '1');
const gridProgress = (p) => {
  if (p && p.status === 'progress' && p.file) $('gridStatus').textContent = `loading ${p.file}… ${Math.round(p.progress || 0)}%`;
  else if (p && p.status === 'ready' && p.file) $('gridStatus').textContent = `${p.file} ready`;
};
function buildKeywordsByEmoji() {
  const m = new Map();
  if (Array.isArray(window.IMGOJI_EMOJI) && Array.isArray(window.IMGOJI_KW)) {
    for (let i = 0; i < window.IMGOJI_EMOJI.length; i++) {
      const terms = window.IMGOJI_KW[i];
      if (terms && terms.length) m.set(String.fromCodePoint(window.IMGOJI_EMOJI[i]), terms);
    }
  }
  return m;
}
async function ensureGrid() {
  if (!sg) sg = new SemanticGrid({ encoder: new Encoder({ compare: 32, dedup: 0 }), canvas: source, keywordsByEmoji: buildKeywordsByEmoji(), device: await DEVICE_PROMISE, onStatus: (s) => { $('gridStatus').textContent = s; }, onProgress: gridProgress });
  return sg;
}

// Cover-fit an image onto a 256x256 context on a white ground.
function coverFit(img, ctx) {
  const s = Math.max(WORK / img.width, WORK / img.height);
  const w = img.width * s, h = img.height * s;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WORK, WORK);
  ctx.drawImage(img, (WORK - w) / 2, (WORK - h) / 2, w, h);
}

// Edge-preserving bilateral preview (matches Encoder.applyBilateral(2, sigmaR): fixed 11×11 spatial
// kernel, sigmaR = contrast threshold). In-place on the 256² preview. Heavy — debounced.
function bilateralFilter(ctx, sigmaR) {
  const W = WORK;
  const src = ctx.getImageData(0, 0, W, W).data;
  const out = new Uint8ClampedArray(src.length);
  const sigmaS = 2, radius = Math.max(1, Math.round(2.5 * sigmaS));
  const gs = 2 * sigmaS * sigmaS, gr = 2 * sigmaR * sigmaR, R = 2 * radius + 1;
  const spatial = new Float32Array(R * R);
  for (let dy = -radius, k = 0; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++, k++) spatial[k] = Math.exp(-(dx * dx + dy * dy) / gs);
  const MAXC = (3 * 255 * 255) >> 8;
  const rangeLut = new Float32Array(MAXC + 1);
  for (let c = 0; c <= MAXC; c++) rangeLut[c] = Math.exp(-(c * 256) / gr);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const ci = (y * W + x) * 4, cr = src[ci], cg = src[ci + 1], cb = src[ci + 2];
    let wr = 0, wg = 0, wb = 0, wsum = 0, k = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= W) { k += R; continue; }
      const rowi = yy * W;
      for (let dx = -radius; dx <= radius; dx++, k++) {
        const xx = x + dx; if (xx < 0 || xx >= W) continue;
        const ni = (rowi + xx) * 4;
        const dd = (src[ni] - cr) ** 2 + (src[ni + 1] - cg) ** 2 + (src[ni + 2] - cb) ** 2;
        const w = spatial[k] * rangeLut[dd >> 8];
        wr += src[ni] * w; wg += src[ni + 1] * w; wb += src[ni + 2] * w; wsum += w;
      }
    }
    out[ci] = wr / wsum; out[ci + 1] = wg / wsum; out[ci + 2] = wb / wsum; out[ci + 3] = 255;
  }
  ctx.putImageData(new ImageData(out, W, W), 0, 0);
}
let previewFilterT = 0;
// Show the source as the encoder will see it: raw, or bilateral-filtered when edge smoothing is on.
function refreshPreview() {
  if (!hasSourceImage) return;
  octx.drawImage(source, 0, 0);
  if ($('advBilateral').checked) bilateralFilter(octx, parseFloat($('advBilateralR').value));
}
const schedulePreviewFilter = () => { clearTimeout(previewFilterT); previewFilterT = setTimeout(refreshPreview, 200); };

function drawSource(img) {
  coverFit(img, sctx);
  $('dropzone').classList.remove('empty');
  hasSourceImage = true;
  ensureGrid().then((g) => g.setImage());   // new image drawn on the canvas: invalidate the detection
  refreshPreview();
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

// ---- tabs ----------------------------------------------------------------
function switchTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  $('picker').hidden = (name !== 'encode' && name !== 'grid');
  $('view-panel').hidden = (name !== 'view');
  $('encode-panel').hidden = (name !== 'encode');
  $('grid-panel').hidden = (name !== 'grid');
  $('gallery-panel').hidden = (name !== 'gallery');
  if (name === 'gallery') loadGallery();
}

// ---- shared picker (encode + grid) --------------------------------------
async function loadFile(f) {
  if (!f || !f.type.startsWith('image/')) return;
  const url = URL.createObjectURL(f);
  try {
    const img = await loadImage(url);
    drawSource(img);
    $('imgName').textContent = f.name;
    $('status').textContent = 'press Encode';
    $('gridStatus').textContent = 'press Make grid';
  } catch {
    $('status').textContent = 'could not load image';
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- encode --------------------------------------------------------------
function onProgress(p) {
  if (p.phase === 'palette') $('status').textContent = `building palette… ${p.count}`;
  else if (p.phase === 'grow') $('status').textContent = `encoding… ${Math.round(p.pct * 100)}%`;
}

async function doEncode() {
  if (busy) return;
  busy = true;
  const go = $('encodeGo');
  go.disabled = true;
  const status = $('status');
  try {
    const lv = LEVELS[parseInt($('detail').value, 10) - 1];
    let seed = $('seed').value.trim();
    const a = readAdv();
    if (encodeSemanticEnabled) {
      status.textContent = 'detecting objects…';
      const g = await ensureGrid();
      const prev = g.onStatus; g.onStatus = (s) => { status.textContent = s; };
      try { if (!g.st) await g.classifyAndDetect(); } finally { g.onStatus = prev; }
      const tokens = g.seedDsl({ max: 16, thr: 0.05, maxArea: 0.5 });
      const kept = await ensureEncoder().filterSeedByError(source, tokens, a.bilateral, a.compare);
      if (kept.length) seed = seed ? seed + ' ' + kept.join(' ') : kept.join(' ');
    }
    status.textContent = 'encoding…';
    const t0 = performance.now();
    const out = await encTask(async () => {
      await fontsReady;
      const e = ensureEncoder();
      return e.encode(source, {
        depth: lv.depth, byteTarget: lv.bytes, seed,
        alpha: a.alpha, compare: a.compare,
        threshold: a.threshold > 0 ? a.threshold : undefined,   // 0 = let byteTarget choose
        skipBias: a.skipBias, detailGate: a.detailGate,
        bilateral: a.bilateral,                                 // edge-preserving smoothing
      });
    });

    setEncodeRecon(out.string, a.alpha);
    $('out').textContent = out.string;
    const def = out.deflatedBytes < out.bytes ? ` · ${fmtBytes(out.deflatedBytes)} deflated` : '';
    const chars = [...out.string].length;
    $('stats').textContent = `${chars} chars · ${fmtBytes(out.bytes)}${def} · ΔE00 ${out.de00.toFixed(1)}`;
    status.textContent = `done in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  } catch (e) {
    console.error(e);
    status.textContent = 'error: ' + (e.message || e);
  } finally {
    go.disabled = false;
    busy = false;
  }
}

// ---- view ----------------------------------------------------------------
// The viewer decodes a prefix of the string, so a render can reveal the imgoji
// building up (the prefix property) instead of snapping in whole. The slider
// scrubs the prefix; the count shows how many placed glyphs are in it.
let curStr = '', curTokens = 0, dragRaf = 0;
const countTokens = (str) => (str ? splitGraphemes(rleExpand(str)).filter((t) => t !== ' ').length : 0);

function setCount(p) {
  if (!curTokens) { $('prefixCount').textContent = ''; return; }
  const n = Math.max(1, Math.round(curTokens * p));
  $('prefixCount').textContent = `${n} / ${curTokens} glyphs`;
}

// Drive the viewer's prefix attribute. Slider drags coalesce the decode at the site.
function applyPrefix(p) {
  p = Math.max(0.001, Math.min(1, p));
  $('viewer').setAttribute('prefix', p);
  setCount(p);
}

// Load a string into the viewer and decode it whole, as fast as one decode. The
// prefix slider can scrub the build-up manually afterwards.
function setRender(str) {
  cancelAnimationFrame(dragRaf);
  curStr = str;
  curTokens = countTokens(str);
  const v = $('viewer');
  v.removeAttribute('autoplay');
  if (!str) { v.value = ''; $('prefix').value = 100; setCount(0); $('renderStatus').textContent = 'pick an example, or paste a string'; return; }
  v.value = '';                  // empty decode is a no-op; avoids decoding the old string
  v.removeAttribute('prefix');   // render the whole string on the next set
  v.value = str;                 // one full decode
  $('prefix').value = 100;
  setCount(1);
  $('renderStatus').textContent = `${curTokens} glyphs`;
}

// Encode-tab viewer: same prefix-scrub as the view tab, driven by the just-encoded string.
let encStr = '', encTokens = 0, encRaf = 0;
function setEncodeCount(p) {
  if (!encTokens) { $('reconPrefixCount').textContent = ''; return; }
  const n = Math.max(1, Math.round(encTokens * p));
  $('reconPrefixCount').textContent = `${n} / ${encTokens} glyphs`;
}
function applyEncodePrefix(p) {
  p = Math.max(0.001, Math.min(1, p));
  $('reconViewer').setAttribute('prefix', p);
  setEncodeCount(p);
  $('out').textContent = encodePrefix(encStr, p);
}
function setEncodeRecon(str, alpha) {
  cancelAnimationFrame(encRaf);
  encStr = str; encTokens = countTokens(str);
  const v = $('reconViewer');
  if (alpha != null) v.setAttribute('alpha', alpha);
  if (!str) { v.value = ''; $('reconPrefix').value = 100; setEncodeCount(0); return; }
  v.value = ''; v.removeAttribute('prefix'); v.value = str;   // one full decode
  $('reconPrefix').value = 100; setEncodeCount(1);
}

// Load a pre-rendered .imgoji example file and reveal it (no runtime encode).
// reveal='build' parks at prefix 0 (level 0); dragging the slider reveals more.
async function pickExample(src, reveal) {
  const rs = $('renderStatus');
  try {
    rs.textContent = 'loading…';
    await fontsReady;   // emoji font must be loaded before the viewer decodes
    const str = await (await fetch(src)).text();
    $('renderInput').value = str;
    const v = $('viewer');
    if (reveal === 'build') {
      // Park at level 0 (slider 0); the user scrubs the slider to reveal more.
      curStr = str; curTokens = countTokens(str);
      v.value = ''; v.removeAttribute('autoplay');
      v.setAttribute('prefix', '0');
      v.value = str;             // decodes at prefix 0 -> coarsest frame only
      $('prefix').value = 0; setCount(0);
      rs.textContent = `${curTokens} glyphs`;
    } else {
      v.removeAttribute('autoplay');
      setRender(str);
    }
  } catch (e) {
    console.error(e);
    rs.textContent = 'could not load example';
  }
}

// ---- grid ----------------------------------------------------------------
function applyGridBg() {
  const dark = $('gridBg').value === 'dark';
  document.querySelector('#grid-panel .outwrap').classList.toggle('dark', dark);
}

const gridCols = () => parseInt($('gridDetail').value, 10);
// rows = cols / line-height, so a grid pasted where each row renders that tall comes out square.
const gridRows = () => Math.max(1, Math.round(gridCols() / (parseFloat($('gridLineHeight').value) || 1)));

function setGridInputs({ thr, lambda }) {
  $('gridLambda').value = lambda; $('gridLambdaVal').textContent = lambda.toFixed(2);
  $('gridThr').value = thr; $('gridThrVal').textContent = thr.toFixed(3);
}

const escDet = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Distinct emoji OWL-ViT localized, filtered by the current box threshold, as compact chips
// (glyph + mono label + score% + a hairline confidence bar). Live-updates as the threshold moves.
function renderDetections() {
  const host = $('gridDetections');
  if (!host) return;
  const boxes = (sg && sg.st) ? sg.st.boxes : [];
  const thr = parseFloat($('gridThr').value);
  const seen = new Map();
  for (const b of boxes) {
    if (!b.emoji || b.score < thr) continue;
    const e = seen.get(b.emoji);
    if (!e) seen.set(b.emoji, { emoji: b.emoji, label: b.label, score: b.score, count: 1 });
    else { if (b.score > e.score) e.score = b.score; e.count++; }
  }
  const list = [...seen.values()].sort((a, b) => b.score - a.score);
  if (!list.length) { host.innerHTML = '<span class="det-empty">none above threshold — lower the box threshold, or run semantic on an image with objects</span>'; return; }
  host.innerHTML = list.map((e) => `<span class="det" title="${escDet(e.label)} · ${(e.score * 100).toFixed(0)}%${e.count > 1 ? ' · ' + e.count + ' boxes' : ''}"><span class="det-glyph">${e.emoji}</span><span class="det-body"><span class="det-top"><span class="det-label">${escDet(e.label)}</span><span class="det-score">${(e.score * 100).toFixed(0)}%</span></span><span class="det-bar"><i style="width:${Math.round(e.score * 100)}%"></i></span></span></span>`).join('');
}

// retune:true (Detail/Reset/Make-grid) classifies if needed, autotunes, renders. Manual advanced
// edits pass retune:false to re-render only, preserving the user's overrides. gridSeq cancels stale
// runs (e.g. dragging Detail while a prior autotune scan is mid-flight). Semantic mode is opt-in:
// until enabled, the grid is fast pure-color (mean-Lab nearest) with no model download.
let gridSeq = 0;
async function runGrid({ retune } = { retune: true }) {
  if (!hasSourceImage) { $('gridStatus').textContent = 'load an image first'; return; }
  const cols = gridCols();
  const rows = gridRows();
  const bg = $('gridBg').value;
  const blank = $('blankBg').checked ? bg : undefined;
  if (!semanticEnabled) {
    $('gridStatus').textContent = 'building…';
    try {
      await encTask(async () => {
        await fontsReady;
        const { grid } = await ensureEncoder().rasterize(source, { cols, rows, blank });
        $('gridOut').textContent = grid;
        $('gridStatus').textContent = `${cols}×${rows} · ${grid.length} chars`;
      });
    } catch (e) { console.error(e); $('gridStatus').textContent = 'error: ' + (e.message || e); }
    return;
  }
  const g = await ensureGrid();
  const seq = ++gridSeq;
  $('gridStatus').textContent = retune ? 'analyzing image…' : 'building…';
  try {
    await fontsReady;
    await encTask(async () => {
      if (!g.st) await g.classifyAndDetect();
      if (seq !== gridSeq) return;
      if (retune) setGridInputs(await g.autotune(cols));
      if (seq !== gridSeq) return;
      const lambda = parseFloat($('gridLambda').value);
      const thr = parseFloat($('gridThr').value);
      const spec = parseFloat($('gridSpec').value);
      const { grid } = await g.biasedGrid(cols, rows, lambda, thr, spec, blank);
      if (seq !== gridSeq) return;
      $('gridOut').textContent = grid;
      $('gridStatus').textContent = `${cols}×${rows} · ${grid.length} chars`;
      renderDetections();
    });
  } catch (e) {
    console.error(e);
    $('gridStatus').textContent = 'error: ' + (e.message || e);
  }
}

function copyText(text, btn) {
  const done = () => {
    const prev = btn.textContent;
    btn.textContent = 'copied';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
  else done();
}

// Render the view-tab default string once the emoji font is ready (unless a
// shared render is arriving via the URL fragment — loadFromFragment handles that).
fontsReady.then(() => { if (/[#&?](z|s)=/.test(location.hash)) return; const v = $('renderInput').value.trim(); if (v) setRender(v); });

// ---- click-to-zoom: render the string at MAX_RES in a fit-to-screen modal ----
// Skipped (and no zoom cursor) when the on-page viewer already renders near
// MAX_RES, since the modal could not exceed what the default canvas shows.
const ZOOM_THRESHOLD = 0.85;            // skip when renderSize >= this × MAX_RES
let zoomResizeT = 0;
const zoomable = (v) => !!(v.value && v.renderSize < ZOOM_THRESHOLD * MAX_RES);
function refreshZoomCursors() {
  document.querySelectorAll('imgoji-viewer').forEach((v) => v.classList.toggle('zoomable', zoomable(v)));
}
function openZoom(viewer) {
  const str = viewer.value; if (!str) return;
  const alpha = parseFloat(viewer.getAttribute('alpha'));
  const prefixAttr = parseFloat(viewer.getAttribute('prefix'));
  const prefix = isNaN(prefixAttr) ? 1 : prefixAttr;   // mirror the on-page viewer's current build level
  const prevFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'zoom-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Enlarged imgoji render. Press Escape to close.');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MAX_RES; canvas.className = 'zoom-canvas';
  const loading = document.createElement('div'); loading.className = 'zoom-loading'; loading.textContent = 'rendering…';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'zoom-close';
  close.setAttribute('aria-label', 'Close enlarged view'); close.textContent = '×';
  overlay.append(canvas, loading, close); document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); dismiss(); } };
  const dismiss = () => {
    overlay.remove(); document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
  close.focus();
  // Decode is synchronous; defer one frame so the overlay paints before the heavy render.
  requestAnimationFrame(() => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const r = new Renderer();
    if (!isNaN(alpha)) r.alpha = alpha;
    try { r.decode(str, ctx, MAX_RES, { prefix }); } catch (e) { /* leave the canvas blank */ }
    loading.remove();
  });
}
function installZoom() {
  document.querySelectorAll('imgoji-viewer').forEach((v) => {
    v.addEventListener('click', () => { if (zoomable(v)) openZoom(v); });   // live check: stays correct even if the cursor hint lags
    v.addEventListener('render', refreshZoomCursors);                       // viewer emits 'render' on content/res change
  });
  refreshZoomCursors();
  window.addEventListener('resize', () => { clearTimeout(zoomResizeT); zoomResizeT = setTimeout(refreshZoomCursors, 150); });
}

// ---- share: #z fragment links, .imgoji download/open ----------------------
// The view tab is the share hub. Encode tabs bridge into it (quad → view) or
// download directly (grid). Links are #z=<base64url(deflate-raw)> with optional
// &a=<alpha>; on load, loadFromFragment decodes and renders.
const SHARE_WARN = 8000;   // URL chars; above this some apps truncate — steer to Download
const viewerAlpha = () => { const a = parseFloat($('viewer').getAttribute('alpha')); return isNaN(a) ? undefined : a; };
async function shareLinkFor(str, alpha) {
  const z = b64urlEncode(await deflateRaw(str));
  const a = Number.isFinite(alpha) ? `&a=${alpha}` : '';
  return `${location.href.split('#')[0]}#z=${z}${a}`;
}
async function copyLink(str, alpha, status) {
  if (!str) { if (status) status.textContent = 'nothing to share yet'; return; }
  let url;
  try { url = await shareLinkFor(str, alpha); }
  catch { alert("Your browser doesn't support the compression needed for share links."); return; }
  try { await navigator.clipboard.writeText(url); }
  catch { if (status) status.textContent = 'clipboard blocked — use Copy for the string'; return; }
  if (status) status.textContent = url.length > SHARE_WARN
    ? `link copied · ${url.length} chars (long — some apps truncate; Download is safer)`
    : `link copied · ${url.length} chars`;
}
async function shareNative(str, alpha, status) {
  if (!str) { if (status) status.textContent = 'nothing to share yet'; return; }
  let url;
  try { url = await shareLinkFor(str, alpha); }
  catch { alert("Your browser doesn't support the compression needed for share links."); return; }
  if (navigator.share) {
    try { await navigator.share({ title: 'imgoji', text: 'an image made of emoji', url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  await copyLink(str, alpha, status);
}
function downloadStr(str, name, status) {
  if (!str) { if (status) status.textContent = 'nothing to save yet'; return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([str], { type: 'text/plain;charset=utf-8' }));
  a.download = name || 'imgoji.imgoji';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  if (status) status.textContent = `saved ${a.download}`;
}
async function openImgFile(file) {
  if (!file) return;
  let str;
  try { str = await file.text(); } catch { $('renderStatus').textContent = 'could not read file'; return; }
  $('renderInput').value = str;
  switchTab('view');
  setRender(str);
  $('renderStatus').textContent = `opened ${file.name}`;
}
// Decode an imgoji share link (full URL or bare fragment) into { str, alpha? }, or null.
// Shared by loadFromFragment (the view tab) and the public gallery tiles.
async function decodeShare(ref) {
  let hash = '';
  try { hash = new URL(ref, location.href).hash || ''; }
  catch { hash = String(ref).startsWith('#') ? String(ref) : ''; }
  if (!hash || hash.length < 2) return null;
  const p = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const out = {};
  if (p.has('a')) { const a = parseFloat(p.get('a')); if (!isNaN(a)) out.alpha = a; }
  try {
    if (p.has('z')) out.str = new TextDecoder().decode(await inflateRaw(b64urlDecode(p.get('z'))));
    else if (p.has('s')) out.str = decodeURIComponent(p.get('s'));
  } catch { return null; }
  return out.str ? out : null;
}

// Receive a shared render from the URL fragment (#z deflated, #s raw; optional &a=alpha).
async function loadFromFragment() {
  await fontsReady;
  if (!location.hash || location.hash.length < 3) return;
  const dec = await decodeShare(location.hash);
  if (!dec) {
    if (/[#&?](z|s)=/.test(location.hash)) { setRender($('renderInput').value || ''); $('renderStatus').textContent = "couldn't load that link"; }
    return;
  }
  if (dec.alpha != null) $('viewer').setAttribute('alpha', String(dec.alpha));
  $('renderInput').value = dec.str;
  switchTab('view');
  setRender(dec.str);
}

// ---- public gallery (gallery tab) ----------------------------------------
// Loads submissions captured by the shortener (key prefix "g:") via GET /g and
// decodes each share URL into its own <imgoji-viewer> tile. Clicking a tile loads
// the render into the view tab. Empty/error states invite the next action.
let galleryLoaded = false;
function relTime(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 604800) return Math.round(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const galleryMsg = (text, inner = '') => `<div class="gallery-msg"><p>${text}</p>${inner}</div>`;
async function loadGallery(force) {
  if (!force && galleryLoaded) return;
  const grid = $('galleryGrid'), status = $('galleryStatus');
  if (!SHORTENER) { grid.innerHTML = galleryMsg('The gallery is not configured on this build.'); return; }
  status.textContent = 'loading…';
  grid.setAttribute('aria-busy', 'true');
  grid.innerHTML = Array.from({ length: 8 }, () => '<span class="gtile-skel"></span>').join('');
  try {
    const r = await fetch(SHORTENER + '/g', { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const items = await r.json();
    grid.innerHTML = '';
    if (!Array.isArray(items) || !items.length) {
      galleryLoaded = true;
      status.textContent = '';
      grid.innerHTML = galleryMsg('No public renders yet.', '<button type="button" class="btn ghost sm" id="galleryEmptyGo">Share one from the view tab →</button>');
      $('galleryEmptyGo').addEventListener('click', () => switchTab('view'));
      return;
    }
    status.textContent = items.length + (items.length === 1 ? ' render' : ' renders');
    await fontsReady;
    let shown = 0;
    for (const it of items) {
      const dec = await decodeShare(it.url);
      if (!dec || !dec.str) continue;
      appendGalleryTile(dec.str, dec.alpha, it);
      shown++;
      await new Promise((r) => requestAnimationFrame(r));   // yield between decodes so the grid fills smoothly
    }
    galleryLoaded = true;
    if (!shown) grid.innerHTML = galleryMsg('No renders here could be decoded.');
  } catch (e) {
    status.textContent = '';
    grid.innerHTML = galleryMsg('Couldn\'t load the gallery.', '<button type="button" class="btn ghost sm" id="galleryRetry">Try again</button>');
    $('galleryRetry').addEventListener('click', () => loadGallery(true));
  } finally {
    grid.setAttribute('aria-busy', 'false');
  }
}
function appendGalleryTile(str, alpha, item) {
  const grid = $('galleryGrid');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gtile';
  btn.title = 'Open this render in the view tab';
  const frame = document.createElement('span');
  frame.className = 'gtile-frame viewport';
  const v = document.createElement('imgoji-viewer');
  if (alpha != null) v.setAttribute('alpha', String(alpha));
  frame.appendChild(v);
  const meta = document.createElement('span');
  meta.className = 'gtile-meta';
  meta.textContent = item && item.t ? relTime(item.t) : '';
  btn.append(frame, meta);
  btn.addEventListener('click', () => {
    if (alpha != null) $('viewer').setAttribute('alpha', String(alpha));
    $('renderInput').value = str;
    switchTab('view');
    setRender(str);
  });
  grid.append(btn);
  v.value = str;   // connected now; one decode
}

function init() {
  // tabs
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));
  switchTab('view');

  // click any imgoji render to enlarge it (skipped when already near max res)
  installZoom();

  // share hub (view tab): link, native share, download, open file
  const curViewStr = () => $('renderInput').value.trim();
  $('shareLink').addEventListener('click', () => copyLink(curViewStr(), viewerAlpha(), $('renderStatus')));
  $('shareBtn').addEventListener('click', () => shareNative(curViewStr(), viewerAlpha(), $('renderStatus')));
  $('downloadImg').addEventListener('click', () => downloadStr(curViewStr(), 'imgoji.imgoji', $('renderStatus')));
  $('openImgBtn').addEventListener('click', () => $('openImg').click());
  $('openImg').addEventListener('change', (e) => openImgFile(e.target.files[0]));
  const viewerEl = $('viewer');   // drag-drop a .imgoji file onto the viewer
  viewerEl.addEventListener('dragover', (e) => { e.preventDefault(); viewerEl.classList.add('drag'); });
  viewerEl.addEventListener('dragleave', () => viewerEl.classList.remove('drag'));
  viewerEl.addEventListener('drop', (e) => {
    e.preventDefault(); viewerEl.classList.remove('drag');
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.name.endsWith('.imgoji') || x.type === '' || x.type.startsWith('text'));
    if (f) openImgFile(f);
  });
  // bridge encode results to the hub + direct downloads
  $('quadToView').addEventListener('click', () => {
    const s = $('out').textContent.trim();
    if (!s) { $('status').textContent = 'encode something first'; return; }
    const a = parseFloat($('reconViewer').getAttribute('alpha'));
    if (!isNaN(a)) $('viewer').setAttribute('alpha', String(a));
    $('renderInput').value = s; switchTab('view'); setRender(s);
  });
  $('quadDownload').addEventListener('click', () => downloadStr($('out').textContent.trim(), 'imgoji.imgoji', $('status')));
  $('gridDownload').addEventListener('click', () => downloadStr($('gridOut').textContent.trim(), 'imgoji-grid.txt', $('gridStatus')));
  // opt-in server share (short link / public gallery). Stores the imgoji server-side,
  // so it is explicitly opt-in with a note in the disclosure panel.
  $('serverCreate').addEventListener('click', async () => {
    const status = $('serverStatus');
    if (!SHORTENER) { status.textContent = 'shortener not configured'; return; }
    const str = $('renderInput').value.trim();
    if (!str) { status.textContent = 'nothing to share yet'; return; }
    const wantShort = $('optShort').checked, wantGallery = $('optGallery').checked;
    if (!wantShort && !wantGallery) { status.textContent = 'pick at least one'; return; }
    status.textContent = 'creating…';
    try {
      const longUrl = await shareLinkFor(str, viewerAlpha());
      const r = await fetch(SHORTENER + '/s', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: longUrl, short: wantShort, gallery: wantGallery }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'failed');
      const bits = [];
      if (out.short) { try { await navigator.clipboard.writeText(out.short); } catch {} bits.push(`short link (copied): ${out.short}`); }
      if (out.gallery) bits.push('submitted to gallery');
      status.textContent = bits.join(' · ');
    } catch (e) { status.textContent = 'could not create: ' + (e.message || e); }
  });
  loadFromFragment();   // receive a shared render from the URL fragment on load
  window.addEventListener('hashchange', loadFromFragment);

  // detail slider label
  const detail = $('detail'), detailVal = $('detailVal');
  const updDetail = () => { detailVal.textContent = fmtBytes(LEVELS[parseInt(detail.value, 10) - 1].bytes); };
  detail.addEventListener('input', updDetail);
  updDetail();

  // advanced labels + reset
  const advVal = (id, valId, fmt) => {
    const el = $(id), v = $(valId);
    const upd = () => { v.textContent = fmt(el.value); };
    el.addEventListener('input', upd); upd();
  };
  advVal('advAlpha', 'advAlphaVal', (v) => parseFloat(v).toFixed(2));
  advVal('advThreshold', 'advThresholdVal', (v) => (v === '0' ? 'auto' : v));
  advVal('advDetailGate', 'advDetailGateVal', (v) => v);
  advVal('advSkipBias', 'advSkipBiasVal', (v) => v);
  advVal('advBilateralR', 'advBilateralRVal', (v) => v);
  $('advBilateral').addEventListener('change', refreshPreview);
  $('advBilateralR').addEventListener('input', schedulePreviewFilter);
  $('advReset').addEventListener('click', () => {
    $('advAlpha').value = ADV_DEFAULTS.alpha;
    $('advCompare').value = ADV_DEFAULTS.compare;
    $('advThreshold').value = ADV_DEFAULTS.threshold;
    $('advDetailGate').value = ADV_DEFAULTS.detailGate;
    $('advSkipBias').value = ADV_DEFAULTS.skipBias;
    $('advBilateral').checked = ADV_DEFAULTS.bilateral;
    $('advBilateralR').value = ADV_DEFAULTS.bilateralR;
    ['advAlpha', 'advThreshold', 'advDetailGate', 'advSkipBias', 'advBilateralR'].forEach((id) => $(id).dispatchEvent(new Event('input')));
  });

  // buttons
  $('encodeGo').addEventListener('click', doEncode);
  const es = $('encodeSemantic');
  const applyEncodeSemantic = () => {
    encodeSemanticEnabled = es.checked;
    try { localStorage.setItem('imgoji.encode.semantic', encodeSemanticEnabled ? '1' : '0'); } catch {}
    $('encodeSemanticWarn').hidden = encodeSemanticEnabled;
  };
  es.checked = encodeSemanticEnabled;
  applyEncodeSemantic();
  es.addEventListener('change', applyEncodeSemantic);
  $('reconPrefix').addEventListener('input', () => {
    cancelAnimationFrame(encRaf);
    const p = $('reconPrefix').value / 100;
    setEncodeCount(p);
    encRaf = requestAnimationFrame(() => applyEncodePrefix(p));
  });
  // prefix slider: scrub the decoded fraction; glyph count updates instantly, the
  // (heavier) decode is coalesced to one per frame
  $('prefix').addEventListener('input', () => {
    cancelAnimationFrame(dragRaf);
    const p = $('prefix').value / 100;
    setCount(p);
    dragRaf = requestAnimationFrame(() => applyPrefix(p));
  });
  // grid: Detail label + autotune-on-change; advanced knobs re-render only (manual override)
  const gd = $('gridDetail'), gdv = $('gridDetailVal');
  const updGridDetail = () => { gdv.textContent = `${gridCols()}×${gridRows()}`; };
  updGridDetail();
  // semantic opt-in (downloads CLIP + OWL-ViT): toggles the advanced controls and re-runs
  const gs = $('gridSemantic');
  const applySemantic = () => {
    semanticEnabled = gs.checked;
    try { localStorage.setItem('imgoji.grid.semantic', semanticEnabled ? '1' : '0'); } catch {}
    $('gridAdvanced').hidden = !semanticEnabled;
    $('gridSemanticWarn').hidden = semanticEnabled;
  };
  gs.checked = semanticEnabled;
  applySemantic();
  gs.addEventListener('change', () => { applySemantic(); runGrid({ retune: true }); });
  const gAdv = (id, valId, fmt) => { const el = $(id), v = $(valId); const u = () => { v.textContent = fmt(el.value); }; el.addEventListener('input', u); u(); };
  gAdv('gridLambda', 'gridLambdaVal', (x) => parseFloat(x).toFixed(2));
  gAdv('gridThr', 'gridThrVal', (x) => parseFloat(x).toFixed(3));
  gAdv('gridSpec', 'gridSpecVal', (x) => parseFloat(x).toFixed(2));
  let gridTimer = 0;
  const scheduleGrid = (retune) => { clearTimeout(gridTimer); gridTimer = setTimeout(() => runGrid({ retune }), 200); };
  gd.addEventListener('input', () => { updGridDetail(); scheduleGrid(true); });        // Detail → autotune
  $('gridLineHeight').addEventListener('input', () => { updGridDetail(); scheduleGrid(false); }); // line-height → rows change, re-render
  ['gridLambda', 'gridThr', 'gridSpec'].forEach((id) => $(id).addEventListener('input', () => scheduleGrid(false)));
  $('gridBtn').addEventListener('click', () => runGrid({ retune: true }));
  $('gridReset').addEventListener('click', () => runGrid({ retune: true }));
  const regridIfPresent = () => { if ($('gridOut').textContent.trim()) runGrid({ retune: false }); };
  $('gridBg').addEventListener('change', () => { applyGridBg(); regridIfPresent(); });
  $('blankBg').addEventListener('change', regridIfPresent);
  applyGridBg();
  $('copyStr').addEventListener('click', () => copyText($('out').textContent, $('copyStr')));
  $('copyGrid').addEventListener('click', () => copyText($('gridOut').textContent, $('copyGrid')));
  $('copyRender').addEventListener('click', () => copyText($('renderInput').value, $('copyRender')));

  // shared picker (file input + drop)
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  const dz = $('dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); loadFile(e.dataTransfer.files[0]); });
  document.querySelectorAll('[data-sample]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        const img = await loadImage(b.dataset.sample);
        drawSource(img);
        $('imgName').textContent = b.textContent.trim();
        $('status').textContent = 'press Encode';
        $('gridStatus').textContent = 'press Make grid';
      } catch {
        $('status').textContent = 'could not load sample';
      }
    }));

  // view: live-decode as the string is edited (debounced) + example clicks load files
  let liveT = 0;
  $('renderInput').addEventListener('input', () => { clearTimeout(liveT); liveT = setTimeout(() => setRender($('renderInput').value), 200); });;
  document.querySelectorAll('[data-decode]').forEach((b) =>
    b.addEventListener('click', () => pickExample(b.dataset.decode, b.dataset.reveal)));  // nothing renders on load: the view viewer starts blank and a pre-rendered example
  // is fetched only when clicked
  $('renderStatus').textContent = 'pick an example, or paste a string';
}

init();
