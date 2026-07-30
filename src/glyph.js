// imgoji glyph rendering: render one emoji to a canvas context and cache its
// pixels. Shared by the renderer (draw) and the encoder (atlas). No DOM of its
// own — it builds canvases through a factory.

export const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui';
// Neutral fallbacks for standalone renderEmojiAt() calls (no GlyphCache). A
// GlyphCache replaces these with values measured from the actual emoji font, so
// no magic placement/scale constants do real work — see GlyphCache._calibrate.
export const DEFAULT_GLYPH_SCALE = 1.0;
export const DEFAULT_VSHIFT = 0;
export const DEFAULT_HSHIFT = 0;

// The solid-color anchor emoji are full-bleed solid fills; their rendered colors
// extend the palette's convex hull to the extremes (incl. pure black/white).
export const TINT_ANCHORS = ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫', '⬛', '⬜'];
export const ANCHOR_EMOJI = new Set(TINT_ANCHORS);

// Calibration reference. The green square is full-bleed on every major emoji
// font (Apple/Google/Microsoft), so its painted bbox is a reliable proxy for
// where the engine placed the em-box. We render it at font-size CALIB_REF into a
// larger CALIB_CANVAS — the margin stops a full-bleed glyph from touching every
// edge, which would make its position ambiguous — and read the font's real scale
// + placement once, lazily, per GlyphCache.
export const CALIB_ANCHOR = '🟩';
export const CALIB_REF = 256;    // probe font-size (px)
export const CALIB_CANVAS = 512; // probe canvas side (must exceed CALIB_REF)
export const CENTER_REF = 128;    // per-glyph probe font-size (px)
export const CENTER_CANVAS = 256; // probe canvas side (must exceed CENTER_REF)

const defaultCreateCanvas = (w, h) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return c;
};

// Render an emoji centered in an R×R context. ⬛/⬜ are forced to pure black /
// white (fonts render them as off-grey). `scale` is a font-size multiplier;
// `hshift`/`vshift` are translations as a fraction of the rendered font-size.
// All three normally come from a GlyphCache that measured them from the anchor.
export function renderEmojiAt(ctx, emoji, size, opts = {}) {
  const { scale = DEFAULT_GLYPH_SCALE, hshift = DEFAULT_HSHIFT, vshift = DEFAULT_VSHIFT, font = EMOJI_FONT } = opts;
  ctx.clearRect(0, 0, size, size);
  ctx.font = `${Math.round(size * scale)}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Per-glyph centering wins when a cache is attached: some emoji sit off-center
  // in their em-box (e.g. 🖼️ on iOS), and no single global shift places them all.
  // Falls back to the global calibration shift otherwise.
  let dx = hshift, dy = vshift;
  if (typeof opts.centerFor === 'function') { const c = opts.centerFor(emoji); if (c) { dx = c.dx; dy = c.dy; } }
  ctx.fillText(emoji, size / 2 + size * scale * dx, size / 2 + size * scale * dy);
  if (emoji === '⬛' || emoji === '⬜') {
    const ic = emoji === '⬛' ? 0 : 255;
    const im = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < im.data.length; i += 4) if (im.data[i + 3] > 40) { im.data[i] = ic; im.data[i + 1] = ic; im.data[i + 2] = ic; }
    ctx.putImageData(im, 0, 0);
  }
}

// Caches rendered glyph pixels per (emoji, size) and the anchor colors. One
// instance per Renderer/Encoder; the cache makes repeated glyphs cheap.
export class GlyphCache {
  constructor({ createCanvas, scale, vshift, hshift, font } = {}) {
    this.createCanvas = createCanvas || defaultCreateCanvas;
    this.font = font || EMOJI_FONT;
    // An explicit arg (or window global) wins and bypasses calibration — an
    // escape hatch for A/B against the old magic constants. When unset, the
    // getters fall back to values measured from the anchor glyph (_calibrate).
    this._manualScale  = scale  ?? (typeof window !== 'undefined' && window.IMGOJI_GSCALE)  ?? null;
    this._manualVShift = vshift ?? (typeof window !== 'undefined' && window.IMGOJI_VSHIFT)  ?? null;
    this._manualHShift = hshift ?? (typeof window !== 'undefined' && window.IMGOJI_HSHIFT)  ?? null;
    this._px = new Map();       // `${emoji}\0${size}` -> Uint8ClampedArray (RGBA)
    this._scratch = null;       // reused canvas for rendering
    this._anchorColors = null;  // emoji -> [r,g,b], built lazily
    this._calib = null;         // measured { scale, hshift, vshift, ... }, lazily
    this._centers = null;       // Map<emoji, {dx,dy}|null> per-glyph centering, lazily
    this._cscratch = null;      // dedicated canvas for per-glyph centering probes
  }
  // Resolved values: manual override, else the measured calibration. Reading any
  // of these triggers the one-time measurement (memoized), so every caller —
  // renderer, encoder atlas, and the palette cache key — shares one result.
  get scale()  { return this._manualScale  ?? this._calibrate().scale; }
  get hshift() { return this._manualHShift ?? this._calibrate().hshift; }
  get vshift() { return this._manualVShift ?? this._calibrate().vshift; }
  get calib()  { return this._calibrate(); } // measured values, for logging/inspection

  // A manual position override (IMGOJI_VSHIFT/HSHIFT or ctor arg) disables
  // per-glyph centering, so the old single-global-shift behavior can be A/B'd.
  get _manualPos() { return this._manualVShift !== null || this._manualHShift !== null; }
  _cscratchCtx(size) {
    if (!this._cscratch || this._cscratch.width !== size) this._cscratch = this.createCanvas(size, size);
    return this._cscratch.getContext('2d', { willReadFrequently: true });
  }
  // Normalized (fraction of font-size) shift that centers this glyph's painted
  // bbox in its cell. Measured once per emoji, cached on a dedicated canvas (so
  // it cannot clobber the scratch pixels() is mid-render into). Null if the glyph
  // paints nothing on this font. opts.centerFor in renderEmojiAt resolves to this.
  centerFor(emoji) {
    if (this._manualPos) return null;
    if (!this._centers) this._centers = new Map();
    else if (this._centers.has(emoji)) return this._centers.get(emoji);
    const R = CENTER_REF, M = CENTER_CANVAS;
    const ctx = this._cscratchCtx(M);
    ctx.clearRect(0, 0, M, M);
    ctx.font = `${R}px ${this.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, M / 2, M / 2);     // raw, uncorrected → glyph's true resting place
    const { data } = ctx.getImageData(0, 0, M, M);
    let minX = M, minY = M, maxX = -1, maxY = -1;
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      if (data[(y * M + x) * 4 + 3] > 40) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    let c = null;
    if (maxX >= 0) {
      const cx = (minX + maxX + 1) / 2, cy = (minY + maxY + 1) / 2;
      c = { dx: -(cx - M / 2) / R, dy: -(cy - M / 2) / R };
    }
    this._centers.set(emoji, c);
    return c;
  }

  // Measure where the anchor glyph (🟩, full-bleed) actually lands and derive a
  // scale + x/y translation that re-centers it in a cell. Replaces the old magic
  // DEFAULT_VSHIFT=0.13 / scale=1.0 with values read from the real font, so the
  // same code self-calibrates on iOS, macOS, Android, Windows, etc.
  _calibrate() {
    if (this._calib) return this._calib;
    const R = CALIB_REF, M = CALIB_CANVAS;
    const c = this.createCanvas(M, M);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, M, M);
    ctx.font = `${R}px ${this.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(CALIB_ANCHOR, M / 2, M / 2);     // raw, no shift → exposes font placement
    const { data } = ctx.getImageData(0, 0, M, M);
    let minX = M, minY = M, maxX = -1, maxY = -1;
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      if (data[(y * M + x) * 4 + 3] > 40) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) {
      // Font unavailable / not loaded → neutral (no correction). System emoji
      // fonts load synchronously, so this is mainly a headless/SSR guard.
      this._calib = { scale: 1, hshift: 0, vshift: 0, ok: false, ref: R, canvas: M };
    } else {
      const cx = (minX + maxX + 1) / 2, cy = (minY + maxY + 1) / 2;
      const bw = maxX - minX + 1, bh = maxY - minY + 1, side = (bw + bh) / 2;
      this._calib = {
        scale:  R / side,             // make the em-box fill the cell
        hshift: -(cx - M / 2) / R,    // center it horizontally (fraction of font-size)
        vshift: -(cy - M / 2) / R,    // center it vertically
        ok: true, ref: R, canvas: M, side, bw, bh, cx, cy, minX, minY, maxX, maxY,
      };
    }
    if (typeof console !== 'undefined' && console.info) {
      console.info('[imgoji] glyph calibration', this._calib);
    }
    return this._calib;
  }
  _scratchCtx(size) {
    if (!this._scratch || this._scratch.width !== size) {
      this._scratch = this.createCanvas(size, size);
    }
    return this._scratch.getContext('2d', { willReadFrequently: true });
  }
  // RGBA pixels of `emoji` rendered at `size`×`size`.
  pixels(emoji, size) {
    const key = emoji + '\0' + size;
    let p = this._px.get(key);
    if (p) return p;
    const ctx = this._scratchCtx(size);
    renderEmojiAt(ctx, emoji, size, this);
    p = ctx.getImageData(0, 0, size, size).data;
    this._px.set(key, p);
    return p;
  }
  // Mean opaque-pixel color of an emoji (used for the background anchor when it
  // isn't one of the known TINT_ANCHORS).
  avgColor(emoji) {
    const d = this.pixels(emoji, 32);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return n ? [r / n, g / n, b / n] : [128, 128, 128];
  }
  // The 9 anchor colors, rendered once. (Encoder overrides this with atlas-exact
  // values; the renderer's lazy version is close enough for the background base.)
  anchorColors() {
    if (this._anchorColors) return this._anchorColors;
    const ac = {};
    for (const a of TINT_ANCHORS) ac[a] = this.avgColor(a);
    this._anchorColors = ac;
    return ac;
  }
  // Pure black/white for the extremes; otherwise the anchor's rendered color.
  anchorIdeal(emoji) {
    if (emoji === '⬛') return [0, 0, 0];
    if (emoji === '⬜') return [255, 255, 255];
    return this.anchorColors()[emoji] || [128, 128, 128];
  }
  // Nearest TINT_ANCHOR to an RGB (snaps the base to a reproducible anchor).
  nearestAnchor(color) {
    const ac = this.anchorColors();
    let best = TINT_ANCHORS[0], bd = Infinity;
    for (const a of TINT_ANCHORS) {
      const c = ac[a] || [0, 0, 0];
      const dd = (c[0] - color[0]) ** 2 + (c[1] - color[1]) ** 2 + (c[2] - color[2]) ** 2;
      if (dd < bd) { bd = dd; best = a; }
    }
    return best;
  }
}
