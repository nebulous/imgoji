// imgoji encoder: approximate a square image as a BFS quadtree of blended
// glyphs (BFOS cost-complexity pruning). Produces a codec string the Renderer
// decodes. Heavy: builds a glyph atlas, matches per cell, grows + prunes a tree.
//
// This is a faithful extraction of the original single-file encoder with module-global
// canvases/state moved onto the instance, so many encoders can coexist and the
// encoder carries no DOM of its own (canvases come from a factory).

import { splitGraphemes, rleExpand, rleCompress, isDSLStart, rgbToLab, rgbToOklab, dE00, encBytes, deflateRawBytes, LEAF_MARKER, SKIP_MARKER, LEAF_MODE_MARKER } from './util.js';
import { GlyphCache, renderEmojiAt, TINT_ANCHORS, ANCHOR_EMOJI } from './glyph.js';
import { Renderer } from './render.js';
import EMOJI_LIST from '../assets/emoji-list.mjs';

const WORK = 256;
const TINT_STRENGTH = 0.5;
const frame = () => new Promise(r => setTimeout(r, 0));
const defaultCreateCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/**
 * Encodes an image as an imgoji codec string: grows a breadth-first quadtree,
 * selects/blends a glyph per cell, prunes by BFOS cost-complexity to a byte budget,
 * and emits a position-implicit RLE-compressed string. Heavy: builds a glyph
 * atlas and matches per cell. The display-only `Renderer` does not import this.
 */
export class Encoder {
  constructor({ createCanvas, glyphs, emojiList, dedup } = {}) {
    this.createCanvas = createCanvas || defaultCreateCanvas;
    this.glyphs = glyphs || new GlyphCache({ createCanvas: this.createCanvas });
    this.renderer = new Renderer({ glyphs: this.glyphs }); // shares the glyph cache; renders seed sprites
    this.emojiList = emojiList;                                          // default: window.IMGOJI_EMOJI
    this.dedup = dedup;
    this.metric = 'cielab';       // matcher color space: 'cielab' (CIE76) or 'oklab'
    this._conv = rgbToLab;        // sRGB→matcher-space (set per-encode)
    this.compare = 32;
    this.alpha = 0.65;
    // scratch canvases (sized to `compare` lazily)
    this._scratch = null; this._sctx = null;
    this._glyphC = null; this._gctx = null;
    this._sigCanvas = null; this._sourceSig = '';   // content hash so the tree cache keys on the image, not just params
    // source + recon
    this._source = null; this._mctx = null;     // match target (what we encode against)
    this._recon = null; this._rctx = null;       // reconstruction (for RMS / ΔE00)
    // palette + tree cache
    this.palette = []; this.paletteBuildKey = ''; this.paletteByEmoji = {};
    this.bfosCache = { key: null, root: null, base: null, bgAnchor: null, seedDsl: '' };
    this.lastMean = [128, 128, 128];
  }

  _ensureScratch() {
    const C = this.compare;
    if (!this._scratch || this._scratch.width !== C) {
      this._scratch = this.createCanvas(C, C); this._sctx = this._scratch.getContext('2d', { willReadFrequently: true });
      this._glyphC = this.createCanvas(C, C); this._gctx = this._glyphC.getContext('2d', { willReadFrequently: true });
    }
  }
  _ensureRecon() {
    if (!this._recon) { this._recon = this.createCanvas(WORK, WORK); this._rctx = this._recon.getContext('2d', { willReadFrequently: true }); }
  }
  // Adopt a source canvas/ImageData as the 256² match target (cover-fit).
  setSource(source) {
    this._ensureRecon();
    const c = this.createCanvas(WORK, WORK);
    this._source = c; this._mctx = c.getContext('2d', { willReadFrequently: true });
    const sw = source.width, sh = source.height;
    const scale = Math.max(WORK / sw, WORK / sh);
    const w = sw * scale, h = sh * scale;
    this._mctx.fillStyle = '#ffffff'; this._mctx.fillRect(0, 0, WORK, WORK);
    this._mctx.drawImage(source, (WORK - w) / 2, (WORK - h) / 2, w, h);
    this._sourceSig = this._sourceSignature();
    return c;
  }

  // Cheap content hash of the normalized source (8x8 average, djb2). The tree
  // cache key includes this so a changed image invalidates the cache even when
  // depth/alpha/seed are unchanged; params alone do not identify the tree.
  _sourceSignature() {
    if (!this._sigCanvas) this._sigCanvas = this.createCanvas(8, 8);
    const ctx = this._sigCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 8, 8);
    ctx.drawImage(this._source, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    let h = 5381;
    for (let i = 0; i < d.length; i += 4) h = ((h * 33) ^ d[i] ^ (d[i + 1] << 1) ^ (d[i + 2] << 2)) >>> 0;
    return h.toString(36);
  }

  // Edge-preserving low-pass on the match target. Smooths flat regions (so photo
  // noise does not waste tokens) while keeping sharp edges. sigmaS is the spatial
  // radius; sigmaR is the range (contrast) threshold: higher = more smoothing.
  // Recomputes _sourceSig so the tree cache distinguishes filtered states.
  applyBilateral(sigmaS = 2, sigmaR = 30) {
    const W = WORK;
    const src = this._mctx.getImageData(0, 0, W, W).data;
    const out = new Uint8ClampedArray(src.length);
    const radius = Math.max(1, Math.round(2.5 * sigmaS));
    const gs = 2 * sigmaS * sigmaS, gr = 2 * sigmaR * sigmaR;
    const R = 2 * radius + 1;
    const spatial = new Float32Array(R * R);
    for (let dy = -radius, k = 0; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++, k++)
      spatial[k] = Math.exp(-(dx * dx + dy * dy) / gs);
    const MAXC = (3 * 255 * 255) >> 8;
    const rangeLut = new Float32Array(MAXC + 1);
    for (let c = 0; c <= MAXC; c++) rangeLut[c] = Math.exp(-(c * 256) / gr);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const ci = (y * W + x) * 4;
        const cr = src[ci], cg = src[ci + 1], cb = src[ci + 2];
        let wr = 0, wg = 0, wb = 0, wsum = 0, k = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= W) { k += R; continue; }
          const rowi = yy * W;
          for (let dx = -radius; dx <= radius; dx++, k++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const ni = (rowi + xx) * 4;
            const dr = src[ni] - cr, dg = src[ni + 1] - cg, db = src[ni + 2] - cb;
            const w = spatial[k] * rangeLut[(dr * dr + dg * dg + db * db) >> 8];
            wr += src[ni] * w; wg += src[ni + 1] * w; wb += src[ni + 2] * w; wsum += w;
          }
        }
        out[ci] = wr / wsum; out[ci + 1] = wg / wsum; out[ci + 2] = wb / wsum; out[ci + 3] = 255;
      }
    }
    this._mctx.putImageData(new ImageData(out, W, W), 0, 0);
    this._sourceSig = this._sourceSignature();
  }

  // ---- palette / glyph atlas --------------------------------------------
  async buildPalette() {
    this._ensureScratch();
    const C = this.compare;
    const DEDUP = this.dedup ?? (typeof window !== 'undefined' && window.IMGOJI_DEDUP) ?? 16;
    const list = this.emojiList || (typeof window !== 'undefined' && window.IMGOJI_EMOJI) || EMOJI_LIST;
    const { scale, font } = this.glyphs;
    const gctx = this._gctx;
    gctx.textAlign = 'center'; gctx.textBaseline = 'middle';
    gctx.font = `${Math.round(C * scale)}px ${font}`;
    const palette = [];
    const SMALL_RES = []; for (let r = 1; r < C; r *= 2) SMALL_RES.push(r);
    const smallC = this.createCanvas(1, 1); const smallCtx = smallC.getContext('2d', { willReadFrequently: true });
    const tintColor = {};
    for (const ach of TINT_ANCHORS) {
      gctx.clearRect(0, 0, C, C);
      renderEmojiAt(gctx, ach, C, this.glyphs);
      const ad = gctx.getImageData(0, 0, C, C).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let j = 0; j < ad.length; j += 4) if (ad[j + 3] > 40) { r += ad[j]; g += ad[j + 1]; b += ad[j + 2]; n++; }
      tintColor[ach] = n ? [r / n, g / n, b / n] : [0, 0, 0];
    }
    this.glyphs._anchorColors = tintColor; // atlas-exact anchor colors for anchorIdeal/nearestAnchor
    for (let i = 0; i < list.length; i++) {
      const ch = String.fromCodePoint(list[i]);
      gctx.clearRect(0, 0, C, C);
      renderEmojiAt(gctx, ch, C, this.glyphs);
      const d = gctx.getImageData(0, 0, C, C).data;
      if (ch === '⬛' || ch === '⬜') { const ic = ch === '⬛' ? 0 : 255; for (let j = 0; j < d.length; j += 4) if (d[j + 3] > 40) { d[j] = ic; d[j + 1] = ic; d[j + 2] = ic; } }
      let opaque = 0;
      for (let j = 3; j < d.length; j += 4) { if (d[j] > 40 && ++opaque >= 8) break; }
      if (opaque < 8) continue;
      let tm = 0, mr = 0, mg = 0, mb = 0, tn = 0;
      for (let j = 0; j < d.length; j += 4) if (d[j + 3] > 40) { const l = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]; tm += l; mr += d[j]; mg += d[j + 1]; mb += d[j + 2]; tn++; }
      let tv = 0;
      if (tn) { const mm = tm / tn; for (let j = 0; j < d.length; j += 4) if (d[j + 3] > 40) { const l = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]; tv += (l - mm) * (l - mm); } }
      const dataR = {};
      for (const R of SMALL_RES) {
        smallC.width = R; smallC.height = R;
        renderEmojiAt(smallCtx, ch, R, this.glyphs);
        dataR[R] = { plain: new Uint8ClampedArray(smallCtx.getImageData(0, 0, R, R).data) };
      }
      palette.push({ emoji: ch, data: new Uint8ClampedArray(d), tex: tn ? tv / tn : 0, dataR });
      if (this.onProgress && (palette.length & 31) === 0) { this.onProgress({ phase: 'palette', count: palette.length }); await frame(); }
    }
    let maxTex = 1; for (const p of palette) if (p.tex > maxTex) maxTex = p.tex;
    for (const p of palette) p.tex /= maxTex;
    if (DEDUP > 0) {
      const kept = [];
      for (const p of palette) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < p.data.length; i += 4) if (p.data[i + 3] > 40) { r += p.data[i]; g += p.data[i + 1]; b += p.data[i + 2]; n++; }
        const av = n ? [r / n, g / n, b / n] : [0, 0, 0];
        let dup = false;
        for (const kp of kept) if ((av[0] - kp.av[0]) ** 2 + (av[1] - kp.av[1]) ** 2 + (av[2] - kp.av[2]) ** 2 < DEDUP * DEDUP && Math.abs(p.tex - kp.p.tex) < 0.05) { dup = true; break; }
        if (!dup) kept.push({ p, av });
      }
      palette.length = 0; palette.push(...kept.map(k => k.p));
    }
    this.paletteByEmoji = {}; for (let i = 0; i < palette.length; i++) this.paletteByEmoji[palette[i].emoji] = palette[i];
    this.palette = palette;
    return palette;
  }

  // ---- region / color helpers -------------------------------------------
  extractRegion(srcCanvas, x, y, size, res) {
    const R = res || this.compare;
    const sctx = this._sctx;
    sctx.clearRect(0, 0, R, R);
    sctx.drawImage(srcCanvas, x, y, size, size, 0, 0, R, R);
    return sctx.getImageData(0, 0, R, R).data;
  }
  meanColor() {
    const d = this._mctx.getImageData(0, 0, WORK, WORK).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    n = n || 1; return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }
  modeColor() {
    const d = this._mctx.getImageData(0, 0, WORK, WORK).data;
    const hist = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    let best = [128, 128, 128], bn = 0;
    for (const [k, n] of hist) if (n > bn) { bn = n; best = [((k >> 8) & 15) * 17, ((k >> 4) & 15) * 17, (k & 15) * 17]; }
    return best;
  }
  nearestAnchor(color) {
    const ac = this.glyphs.anchorColors();
    let best = TINT_ANCHORS[0], bd = Infinity;
    for (const a of TINT_ANCHORS) { const c = ac[a] || [0, 0, 0]; const dd = (c[0] - color[0]) ** 2 + (c[1] - color[1]) ** 2 + (c[2] - color[2]) ** 2; if (dd < bd) { bd = dd; best = a; } }
    return best;
  }
  // Mean ΔE00 between recon (_rctx) and source (_mctx) over a region (for seed-sprite measurement).
  meanDeltaE(x0, y0, x1, y1) {
    const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) return Infinity;
    const a = this._rctx.getImageData(x0, y0, w, h).data, b = this._mctx.getImageData(x0, y0, w, h).data;
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) { const rl = rgbToLab(a[i], a[i + 1], a[i + 2]), sl = rgbToLab(b[i], b[i + 1], b[i + 2]); s += dE00(rl[0], rl[1], rl[2], sl[0], sl[1], sl[2]); n++; }
    return n ? s / n : Infinity;
  }
  // Greedily keep only the seed sprites that reduce regional reconstruction error. Renders each onto
  // the bg-anchor base (largest-first = back), measures mean ΔE00 in its footprint before vs after;
  // keeps it only if it lowers the error there. compare must match the encode's compare (palette res).
  async filterSeedByError(source, tokens, bilateral, compare) {
    if (!tokens || !tokens.length) return [];
    this.compare = Math.max(4, compare || 32);
    this.setSource(source);
    if (bilateral) this.applyBilateral(2, bilateral);
    if (!this.palette.length) await this.buildPalette();
    const W = WORK, rctx = this._rctx;
    const base = this.glyphs.anchorIdeal(this.nearestAnchor(this.modeColor()));
    rctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; rctx.fillRect(0, 0, W, W);
    const isOp = c => c >= 'a' && c <= 'z', isHex = c => (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F');
    const foot = (tok) => {
      const cps = splitGraphemes(tok); let i = 1, tx = 0, ty = 0, sc = 1; // i=1: skip emoji
      while (i < cps.length && isOp(cps[i])) { const op = cps[i++]; let hex = ''; while (i < cps.length && isHex(cps[i])) hex += cps[i++]; const n = hex.length || 1, V = parseInt(hex, 16) || 0, top = 1 << (4 * n - 1); if (op === 'x' || op === 'y') { const sign = V >= top ? -1 : 1, mag = (V & (top - 1)) + 1, val = sign * mag / 16 ** n; if (op === 'x') tx = val; else ty = val; } else if (op === 's') sc = V / 16 ** n; }
      const cell = W * sc, cx = W * (0.5 + tx), cy = W * (0.5 - ty);
      return { x0: Math.max(0, Math.floor(cx - cell / 2)), y0: Math.max(0, Math.floor(cy - cell / 2)), x1: Math.min(W, Math.ceil(cx + cell / 2)), y1: Math.min(W, Math.ceil(cy + cell / 2)) };
    };
    const kept = [];
    for (const tok of tokens) {
      const f = foot(tok); if (f.x1 <= f.x0 || f.y1 <= f.y0) continue;
      // Pad the snapshot region to cover any rotation's bounding extent (diagonal = side × √2).
      const cell = Math.max(f.x1 - f.x0, f.y1 - f.y0), pad = Math.ceil(cell * 0.21);
      const rx = Math.max(0, f.x0 - pad), ry = Math.max(0, f.y0 - pad), rw = Math.min(W, f.x1 + pad), rh = Math.min(W, f.y1 + pad);
      const snap = rctx.getImageData(rx, ry, rw - rx, rh - ry);
      const before = this.meanDeltaE(rx, ry, rw, rh);
      let bestRot = 0, bestErr = Infinity;
      for (let rot = 0; rot < 16; rot++) {
        rctx.putImageData(snap, rx, ry);
        const rTok = tok + (rot ? 'r' + rot.toString(16).toUpperCase() : '');
        const dt = splitGraphemes(rTok); if (isDSLStart(dt, 0)) this.renderer.renderSprite(dt, 0, rctx, W);
        const err = this.meanDeltaE(rx, ry, rw, rh);
        if (err < bestErr) { bestErr = err; bestRot = rot; }
      }
      // Then sweep the 16 hue rotations (h0..hF, 22.5° steps), holding the best
      // rotation; keep the hue if it lowers the footprint error further. h0 is the
      // no-hue baseline (== bestErr), so the loop starts at 1.
      const rotOp = bestRot ? 'r' + bestRot.toString(16).toUpperCase() : '';
      let bestHue = 0, bestErrH = bestErr;
      for (let hue = 1; hue < 16; hue++) {
        rctx.putImageData(snap, rx, ry);
        const hTok = tok + rotOp + 'h' + hue.toString(16).toUpperCase();
        const dt = splitGraphemes(hTok); if (isDSLStart(dt, 0)) this.renderer.renderSprite(dt, 0, rctx, W);
        const err = this.meanDeltaE(rx, ry, rw, rh);
        if (err < bestErrH) { bestErrH = err; bestHue = hue; }
      }
      if (bestErrH < before) {
        rctx.putImageData(snap, rx, ry);
        const hueOp = bestHue ? 'h' + bestHue.toString(16).toUpperCase() : '';
        const kTok = tok + rotOp + hueOp;
        const dt = splitGraphemes(kTok); if (isDSLStart(dt, 0)) this.renderer.renderSprite(dt, 0, rctx, W);
        kept.push(kTok);
      } else rctx.putImageData(snap, rx, ry);
    }
    return kept;
  }
  metricRefScales() {
    const conv = this._conv;
    const d = this._mctx.getImageData(0, 0, WORK, WORK).data;
    const m = this.meanColor(); const ml = conv(m[0], m[1], m[2]);
    let sRgb = 0, sMetric = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      sRgb += (r - m[0]) ** 2 + (g - m[1]) ** 2 + (b - m[2]) ** 2;
      const L = conv(r, g, b);
      sMetric += (L[0] - ml[0]) ** 2 + (L[1] - ml[1]) ** 2 + (L[2] - ml[2]) ** 2; n++;
    }
    n = n || 1; return { rgb: sRgb / n, scale: sMetric / n };
  }
  regionDE00(x, y, size) {
    const R = Math.min(this.compare, Math.max(1, size | 0));
    const o = this.extractRegion(this._source, x, y, size, R), r = this.extractRegion(this._recon, x, y, size, R);
    let s = 0;
    for (let i = 0; i < o.length; i += 4) { const ol = rgbToLab(o[i], o[i + 1], o[i + 2]), rl = rgbToLab(r[i], r[i + 1], r[i + 2]); s += dE00(ol[0], ol[1], ol[2], rl[0], rl[1], rl[2]); }
    return s;
  }
  meanDE00() {
    const a = this._mctx.getImageData(0, 0, WORK, WORK).data, b = this._rctx.getImageData(0, 0, WORK, WORK).data;
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) { const p = rgbToLab(a[i], a[i + 1], a[i + 2]), q = rgbToLab(b[i], b[i + 1], b[i + 2]); s += dE00(p[0], p[1], p[2], q[0], q[1], q[2]); n++; }
    return s / n;
  }
  alphaForDepth(d) { return d === 0 ? 1 : this.alpha; }
  paintsCell(res) { return res.err < res.skip; }
  // Composite a glyph over the recon at a region (codec alpha blend).
  paintRegion(x, y, size, alpha, emoji) {
    const s = Math.max(1, Math.round(size));
    const ed = this.glyphs.pixels(emoji, s);
    const ad = this._rctx.getImageData(x, y, s, s); const add = ad.data;
    for (let i = 0; i < ed.length; i += 4) {
      const w = alpha * (ed[i + 3] * (1 / 255));
      if (w > 0) { add[i] += w * (ed[i] - add[i]); add[i + 1] += w * (ed[i + 1] - add[i + 1]); add[i + 2] += w * (ed[i + 2] - add[i + 2]); }
      add[i + 3] = 255;
    }
    this._rctx.putImageData(ad, x, y);
  }

  // ---- per-cell matcher --------------------------------------------------
  bestForRegion(x, y, size, alpha) {
    const a = alpha, C = this.compare;
    const R = Math.min(C, Math.max(1, size | 0));
    const target = this.extractRegion(this._source, x, y, size, R);
    const parent = this.extractRegion(this._recon, x, y, size, R);
    const N = R * R;
    const tL = new Float32Array(N), tA = new Float32Array(N), tB = new Float32Array(N);
    const conv = this._conv;
    for (let i = 0; i < N; i++) { const o = i * 4; const lab = conv(target[o], target[o + 1], target[o + 2]); tL[i] = lab[0]; tA[i] = lab[1]; tB[i] = lab[2]; }
    let bestPlain = null, plainErr = Infinity;
    for (let e = 0; e < this.palette.length; e++) {
      const pe = this.palette[e], pd = R === C ? pe.data : pe.dataR[R].plain;
      let err = 0;
      for (let i = 0; i < N; i++) {
        const o = i * 4; const w = a * (pd[o + 3] * (1 / 255));
        let br, bg, bb;
        if (w <= 0) { br = parent[o]; bg = parent[o + 1]; bb = parent[o + 2]; }
        else { br = parent[o] + w * (pd[o] - parent[o]); bg = parent[o + 1] + w * (pd[o + 1] - parent[o + 1]); bb = parent[o + 2] + w * (pd[o + 2] - parent[o + 2]); }
        const lab = conv(br, bg, bb);
        const dl = lab[0] - tL[i], da = lab[1] - tA[i], dbb = lab[2] - tB[i];
        err += dl * dl + da * da + dbb * dbb;
        if (err >= plainErr) break;
      }
      if (err < plainErr) { plainErr = err; bestPlain = pe; }
    }
    let skipErr = 0;
    for (let i = 0; i < N; i++) { const o = i * 4; const l = conv(parent[o], parent[o + 1], parent[o + 2]); skipErr += (l[0] - tL[i]) ** 2 + (l[1] - tA[i]) ** 2 + (l[2] - tB[i]) ** 2; }
    if (!bestPlain) return { emoji: '⬜', err: Infinity, skip: 0 };
    return { emoji: bestPlain.emoji, err: plainErr, skip: skipErr };
  }

  // ---- tree growth + prune ----------------------------------------------
  async growFullTree(maxDepth, seedStr = '', detailGate = 0) {
    this._ensureScratch(); this._ensureRecon();
    const C = this.compare;
    const key = this._sourceSig + '|' + maxDepth + '|' + C + '|' + this.alpha + '|' + (seedStr) + '|' + detailGate + '|' + this.metric;
    if (this.bfosCache.key === key) return this.bfosCache;
    const seedTokens = splitGraphemes(rleExpand(seedStr)).filter(t => t !== ' ');
    let seedDsl = ''; const seedPins = []; let seeded = 0;
    const bgAnchor = this.nearestAnchor(this.modeColor());
    const base = this.glyphs.anchorIdeal(bgAnchor).slice();
    this.lastMean = [Math.round(base[0]), Math.round(base[1]), Math.round(base[2])];
    this._rctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; this._rctx.fillRect(0, 0, WORK, WORK);
    for (let si = 0; si < seedTokens.length;) {
      if (isDSLStart(seedTokens, si)) { const s0 = si; si = this.renderer.renderSprite(seedTokens, si, this._rctx, WORK); seedDsl += seedTokens.slice(s0, si).join(''); }
      else seedPins.push(seedTokens[si++]);
    }
    const root = { x: 0, y: 0, size: WORK, depth: 0, alpha: this.alphaForDepth(0), children: null, res: null };
    if (seedDsl) { root._dsl = true; root._dslStr = seedDsl; }
    const total = (Math.pow(4, maxDepth + 1) - 1) / 3;
    const q = [root]; let qi = 0, lastYield = performance.now();
    while (qi < q.length) {
      const n = q[qi++];
      n.res = this.bestForRegion(n.x, n.y, n.size, n.alpha);
      if (n._dsl) { /* DSL-claimed: content is the seed layer; no pin/paint */ }
      else {
        const isSeed = seeded < seedPins.length;
        if (isSeed) { n.res.emoji = seedPins[seeded]; n._seed = true; seeded++; }
        if (isSeed || n.res.err < n.res.skip) this.paintRegion(n.x, n.y, n.size, n.alpha, n.res.emoji);
      }
      if (n.depth < maxDepth) {
        if (detailGate > 0 && !n._dsl) {
          const Rd = Math.min(C, Math.max(1, n.size | 0));
          const td = this.extractRegion(this._source, n.x, n.y, n.size, Rd);
          let hf = 0, hfc = 0;
          for (let yy = 1; yy < Rd - 1; yy++) for (let xx = 1; xx < Rd - 1; xx++) {
            const li = (yy * Rd + xx) * 4; const la = o => 0.299 * td[o] + 0.587 * td[o + 1] + 0.114 * td[o + 2];
            hf += Math.abs(la(li + 4) - la(li - 4)) + Math.abs(la(li + Rd * 4) - la(li - Rd * 4)); hfc++;
          }
          if (hfc && hf / hfc < detailGate) continue;
        }
        const hs = n.size / 2, cd = n.depth + 1, ca = this.alphaForDepth(cd);
        n.children = [{ x: n.x, y: n.y, size: hs, depth: cd, alpha: ca }, { x: n.x + hs, y: n.y, size: hs, depth: cd, alpha: ca }, { x: n.x, y: n.y + hs, size: hs, depth: cd, alpha: ca }, { x: n.x + hs, y: n.y + hs, size: hs, depth: cd, alpha: ca }];
        for (const c of n.children) q.push(c);
      }
      if (this.onProgress && performance.now() - lastYield > 60) { this.onProgress({ phase: 'grow', pct: qi / total }); await frame(); lastYield = performance.now(); }
    }
    this.bfosCache = { key, root, base, bgAnchor, seedDsl };
    return this.bfosCache;
  }

  pruneAndEmit(root, base, lambda, maxDepth, mscale, nopaint) {
    const C = this.compare;
    const f = n => n.size > C ? (n.size / C) * (n.size / C) : 1;
    const D = n => ((n._seed || this.paintsCell(n.res)) ? n.res.err : n.res.skip) * f(n) * (mscale || 1);
    const mark = n => {
      if (!n.children) { n._l = true; n._R = 1; n._D = D(n); return; }
      for (const c of n.children) mark(c);
      const subR = 1 + n.children.reduce((s, c) => s + c._R, 0);
      const subD = n.children.reduce((s, c) => s + c._D, 0);
      const leafD = D(n), leafR = 2;
      if (leafD + lambda * leafR <= subD + lambda * subR) { n._l = true; n._R = leafR; n._D = leafD; }
      else { n._l = false; n._R = subR; n._D = subD; }
    };
    mark(root);
    if (root._dsl) root._l = false;
    if (!nopaint) {
      this._rctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; this._rctx.fillRect(0, 0, WORK, WORK);
      if (root._dslStr) { const dt = splitGraphemes(rleExpand(root._dslStr)).filter(t => t !== ' '); for (let si = 0; si < dt.length;) { if (isDSLStart(dt, si)) si = this.renderer.renderSprite(dt, si, this._rctx, WORK); else si++; } }
    }
    let str = '', tokens = 0; const depthCounts = new Array(maxDepth + 1).fill(0); let leafMode = false;
    const qq = [root];
    while (qq.length) {
      const m = qq.shift();
      if (m._dsl) {
        if (!nopaint && m._dslStr) { const dt = splitGraphemes(rleExpand(m._dslStr)).filter(t => t !== ' '); for (let si = 0; si < dt.length;) { if (isDSLStart(dt, si)) si = this.renderer.renderSprite(dt, si, this._rctx, WORK); else si++; } }
        if (m.children) for (const c of m.children) qq.push(c);
        continue;
      }
      if (m._seed || this.paintsCell(m.res)) { if (!nopaint) this.paintRegion(m.x, m.y, m.size, m.alpha, m.res.emoji); str += m.res.emoji; depthCounts[m.depth]++; }
      else str += SKIP_MARKER;
      tokens++;
      if (m._l) {
        if (!leafMode && qq[0] && qq[0]._l) { str += LEAF_MODE_MARKER; tokens++; leafMode = true; }
        else if (leafMode) { if (qq[0] && !qq[0]._l) { str += LEAF_MARKER; tokens++; leafMode = false; } }
        else if (m.depth < maxDepth) { str += LEAF_MARKER; tokens++; }
      } else for (const c of m.children) qq.push(c);
    }
    return { str, tokens, depthCounts };
  }

  async findThresholdForBytes(target, depth, seedStr, detailGate) {
    const grown = await this.growFullTree(depth, seedStr, detailGate);
    const ref = this.metricRefScales(); const ms = ref.scale; const mscale = ms > 0 ? ref.rgb / ms : 1;
    const bgAnchor = grown.bgAnchor;
    const bytesAt = async threshold => {
      const lambda = Math.pow(10, threshold / 25);
      const { str } = this.pruneAndEmit(grown.root, grown.base, lambda, depth, mscale, true);
      return await deflateRawBytes(bgAnchor + (grown.seedDsl || '') + str);
    };
    let lo = 0, hi = 150, best = 150;  // default to max pruning: if the target is below the
    // achievable minimum, return the smallest tree, not the full tree (best=0 would emit unpruned).
    for (let iter = 0; iter < 9; iter++) {
      const mid = Math.round((lo + hi) / 2);
      if (await bytesAt(mid) <= target) { best = mid; hi = mid; } else lo = mid;
      if (hi - lo <= 1) break;
    }
    return best;
  }

  // ---- flat raster (no quadtree): one opaque emoji per cell by avg color ---
  /**
   * Flatten the image into a grid of opaque emoji (one per cell) for terminals /
   * chat, with optional semantic overrides. No quadtree.
   * @param {CanvasImageSource} source the image.
   * @param {object} [opts]
   * @param {number} [opts.cols=10] columns.
   * @param {number} [opts.rows=10] rows (rows = cols / line-height for square paste).
   * @param {'dark'|'light'} [opts.blank] blank the matching background anchor to a space.
   * @param {function} [opts.boost] `(x0,y0,x1,y1) => Map<emoji, 0..1>` semantic distance per cell.
   * @param {number} [opts.lambda=0.5] color/semantic blend weight (0 = color only).
   * @returns {Promise<{grid:string,cols:number,rows:number}>}
   */
  async rasterize(source, { cols = 10, rows = 10, blank, boost, lambda = 0.5 } = {}) {
    if (!this.palette.length) { await this.buildPalette(); }
    this._ensureRecon(); this.setSource(source);
    const cellW = WORK / cols, cellH = WORK / rows;
    const mctx = this._mctx;
    const data = mctx.getImageData(0, 0, WORK, WORK).data;
    // blank the anchor square that matches the chosen background so it disappears
    // into the panel: black on dark, white on light.
    const blankEmoji = blank === 'dark' ? '\u2B1B' : blank === 'light' ? '\u2B1C' : null;
    // avg Lab per palette glyph, cached
    if (!this._avgLab || this._avgLab.length !== this.palette.length) {
      this._avgLab = this.palette.map(pe => {
        const d = pe.data; let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
        return rgbToLab(...(n ? [r / n, g / n, b / n] : [50, 0, 0]));
      });
    }
    let str = '';
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x0 = Math.floor(col * cellW), y0 = Math.floor(row * cellH);
        const x1 = Math.floor((col + 1) * cellW), y1 = Math.floor((row + 1) * cellH);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * WORK + x) * 4; r += data[o]; g += data[o + 1]; b += data[o + 2]; n++; }
        const lab = rgbToLab(r / (n || 1), g / (n || 1), b / (n || 1));
        const cellBoost = boost ? boost(x0, y0, x1, y1) : null;
        const N = this._avgLab.length;
        const dist = new Array(N);
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < N; i++) {
          const al = this._avgLab[i];
          const dd = (al[0] - lab[0]) ** 2 + (al[1] - lab[1]) ** 2 + (al[2] - lab[2]) ** 2;
          dist[i] = dd; if (dd < mn) mn = dd; if (dd > mx) mx = dd;
        }
        const range = (mx - mn) || 1;
        let best = 0, bestScore = Infinity;
        for (let i = 0; i < N; i++) {
          const cn = (dist[i] - mn) / range;               // color distance [0,1], 0 = best
          const s = cellBoost ? cellBoost.get(this.palette[i].emoji) : undefined; // shaped semantic distance, or none
          const detected = s !== undefined;                 // has a detection box covering this cell
          // λ is the sole color↔semantic control. The old color-plausibility gate (cn < plaus) was
          // dropped: it excluded legitimate detections that were poor color matches — e.g. a 👙/🦜
          // box on an image where it isn't the dominant color never won, even as the sole detection
          // at 1×1 (a best-color glyph like 🖤/🦔 took the cell instead). grid-ab shapes `s` per cell
          // from confidence + box-containment strength (+ a specificity tiebreaker). s undefined → sn=1.
          const sn = detected ? Math.min(1, Math.max(0, s)) : 1;
          const sc = (1 - lambda) * cn + lambda * sn;
          if (sc < bestScore) { bestScore = sc; best = i; }
        }
        const emoji = this.palette[best].emoji;
        str += (blankEmoji && emoji === blankEmoji) ? '\u3000' : emoji;
      }
      str += '\n';
    }
    return { grid: str, cols, rows };
  }

  // ---- main entry --------------------------------------------------------
  /**
   * Encode an image as an imgoji codec string (BFOS-pruned blended quadtree).
   * @param {CanvasImageSource|HTMLImageElement|HTMLCanvasElement|ImageBitmap} source the image (cover-fit to 256²).
   * @param {object} [opts]
   * @param {number} [opts.byteTarget=8192] deflated-byte budget; the prune threshold is binary-searched to hit it.
   * @param {number} [opts.threshold] fixed prune threshold (0..150) overriding byteTarget; lambda = 10^(threshold/25).
   * @param {number} [opts.alpha=0.65] per-layer blend weight (must match the viewer's alpha).
   * @param {number} [opts.depth=6] max quadtree depth (8 = one pixel per cell at 256²).
   * @param {number} [opts.compare=32] comparison/match resolution.
   * @param {number} [opts.detailGate=0] Sobel gate; cells below it stay leaves.
   * @param {number} [opts.bilateral] edge-preserving smoothing sigmaR applied to the match target.
   * @param {'cielab'|'oklab'} [opts.metric='cielab'] matcher color space.
   * @param {string} [opts.seed] DSL seed string (base-layer sprites / anchor pins).
   * @returns {Promise<{string:string,bytes:number,deflatedBytes:number,tokens:number,depthCounts:number[],threshold:number,lambda:number,de00:number,recon:ImageData}>}
   */
  async encode(source, opts = {}) {
    this.compare = Math.max(4, opts.compare || 32);
    this.alpha = opts.alpha ?? 0.65;
    this.metric = opts.metric === 'oklab' ? 'oklab' : 'cielab';
    this._conv = this.metric === 'oklab' ? rgbToOklab : rgbToLab;
    this._ensureScratch();
    this.setSource(source);
    if (opts.bilateral) this.applyBilateral(2, opts.bilateral);   // edge-preserving smoothing of the match target
    const key = this.compare + '|' + this.glyphs.scale + '|' + this.glyphs.hshift + '|' + this.glyphs.vshift + '|' + (this.dedup ?? (typeof window !== 'undefined' && window.IMGOJI_DEDUP) ?? 16);
    if (!this.palette.length || key !== this.paletteBuildKey) { await this.buildPalette(); this.paletteBuildKey = key; }
    const depth = opts.depth ?? 6;
    const seedStr = opts.seed || '';
    const detailGate = opts.detailGate ?? 0;
    const m = this.meanColor();
    this._rctx.fillStyle = `rgb(${m[0]},${m[1]},${m[2]})`; this._rctx.fillRect(0, 0, WORK, WORK);
    const grown = await this.growFullTree(depth, seedStr, detailGate);
    let threshold;
    if (opts.threshold != null) threshold = opts.threshold;
    else { threshold = await this.findThresholdForBytes(opts.byteTarget ?? 8192, depth, seedStr, detailGate); }
    const lambda = Math.pow(10, threshold / 25);
    const ref = this.metricRefScales(); const ms = ref.scale; const mscale = ms > 0 ? ref.rgb / ms : 1;
    const { str: treeStr, tokens, depthCounts } = this.pruneAndEmit(grown.root, grown.base, lambda, depth, mscale, false);
    const body = grown.bgAnchor + (grown.seedDsl || '') + treeStr;
    const out = rleCompress(body);
    const bytes = encBytes(out);
    const deflatedBytes = await deflateRawBytes(out);
    const de00 = this.meanDE00();
    return { string: out, bytes, deflatedBytes, tokens, depthCounts, threshold, lambda, de00, recon: this._rctx.getImageData(0, 0, WORK, WORK) };
  }
}
