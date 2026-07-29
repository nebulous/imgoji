// imgoji glyph rendering: render one emoji to a canvas context and cache its
// pixels. Shared by the renderer (draw) and the encoder (atlas). No DOM of its
// own — it builds canvases through a factory.

export const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui';
export const DEFAULT_GLYPH_SCALE = 1.0;
export const DEFAULT_VSHIFT = 0.13;

// The solid-color anchor emoji are full-bleed solid fills; their rendered colors
// extend the palette's convex hull to the extremes (incl. pure black/white).
export const TINT_ANCHORS = ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫', '⬛', '⬜'];
export const ANCHOR_EMOJI = new Set(TINT_ANCHORS);

const defaultCreateCanvas = (w, h) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return c;
};

// Render an emoji centered in an R×R context. ⬛/⬜ are forced to pure black /
// white (fonts render them as off-grey).
export function renderEmojiAt(ctx, emoji, size, { scale = DEFAULT_GLYPH_SCALE, vshift = DEFAULT_VSHIFT, font = EMOJI_FONT } = {}) {
  ctx.clearRect(0, 0, size, size);
  ctx.font = `${Math.round(size * scale)}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, size / 2, size / 2 + size * scale * vshift);
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
  constructor({ createCanvas, scale, vshift, font } = {}) {
    this.createCanvas = createCanvas || defaultCreateCanvas;
    this.scale = scale ?? ((typeof window !== 'undefined' && window.IMGOJI_GSCALE) || DEFAULT_GLYPH_SCALE);
    this.vshift = vshift ?? ((typeof window !== 'undefined' && window.IMGOJI_VSHIFT) ?? DEFAULT_VSHIFT);
    this.font = font || EMOJI_FONT;
    this._px = new Map();       // `${emoji}\0${size}` -> Uint8ClampedArray (RGBA)
    this._scratch = null;       // reused canvas for rendering
    this._anchorColors = null;  // emoji -> [r,g,b], built lazily
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
