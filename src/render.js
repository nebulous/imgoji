// imgoji renderer: render a codec string (or a DSL scene) to a canvas.
// Lightweight — no palette, no matching, no atlas, no deflate. Just glyph
// drawing + the codec's per-pixel alpha blend. This is what a consumer needs to
// display an imgoji string; it does NOT depend on the encoder.

import { splitGraphemes, rleExpand, isDSLStart, LEAF_MARKER, SKIP_MARKER, LEAF_MODE_MARKER } from './util.js';
import { GlyphCache, renderEmojiAt, TINT_ANCHORS } from './glyph.js';

const WORK = 256;            // canonical render resolution (power of 2 → clean quadtree cells)
const DEFAULT_ALPHA = 0.65;  // per-cell blend weight (depth > 0); must match the encoder's

const isOp = c => c >= 'a' && c <= 'z';
const isHex = c => (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F');

/**
 * Renders imgoji strings to a canvas. Display-only: pulls in no encoder or glyph
 * atlas/emoji-list code. A page that only shows strings imports `imgoji/render`.
 */
export class Renderer {
  constructor({ createCanvas, alpha = DEFAULT_ALPHA, glyphs, lastMean = [128, 128, 128] } = {}) {
    this.alpha = alpha;
    this.lastMean = lastMean;
    this.glyphs = glyphs || new GlyphCache({ createCanvas });
    this._createCanvas = this.glyphs.createCanvas; // share the canvas factory
    this._temp = null;                              // scratch for DSL sprites
  }
  _tempCtx(size) {
    if (!this._temp || this._temp.width !== size) this._temp = this._createCanvas(size, size);
    return this._temp.getContext('2d', { willReadFrequently: true });
  }
  alphaForDepth(d) { return d === 0 ? 1 : this.alpha; }

  // Composite a glyph over the target at (x,y,size) with the codec's blend:
  // result = parent + alpha*glyphAlpha*(glyph - parent); result stays opaque.
  blend(ctx, x, y, size, emoji, alpha) {
    const s = Math.max(1, Math.round(size));
    const ed = this.glyphs.pixels(emoji, s);
    const ad = ctx.getImageData(x, y, s, s);
    const add = ad.data;
    for (let i = 0; i < ed.length; i += 4) {
      const w = alpha * (ed[i + 3] * (1 / 255));
      if (w > 0) {
        add[i]     = add[i]     + w * (ed[i]     - add[i]);
        add[i + 1] = add[i + 1] + w * (ed[i + 1] - add[i + 1]);
        add[i + 2] = add[i + 2] + w * (ed[i + 2] - add[i + 2]);
      }
      add[i + 3] = 255;
    }
    ctx.putImageData(ad, x, y);
  }

  // Decode + render a codec BFS string into ctx (size×size). opts: debug
  // outlines, sub-origin/scale (for rendering into a larger canvas).
  /**
   * Decode a codec (BFS quadtree) imgoji string onto a 2D context.
   * @param {string} str imgoji codec string (optionally RLE-compressed): a
   *   background anchor followed by breadth-first cells, where each cell is either
   *   a plain glyph (with an optional leaf marker) or a DSL sprite list that claims
   *   the cell (positioned sprites; the quadtree subdivides beneath them). A leading
   *   glyph with no transform op is the background anchor (a solid color fill); give
   *   it a no-op op such as `r0` to render it as a picture.
   * @param {CanvasRenderingContext2D} ctx destination context.
   * @param {number} [size=256] canvas side length.
   * @param {object} [opts]
   * @param {number} [opts.ox=0] / [opts.oy=0] origin offset within the canvas.
   * @param {number} [opts.scale=1] output scale.
   * @param {number} [opts.prefix] render only the first fraction of the stream
   *   (0..1; the prefix property). The decoder always emits at least the root
   *   glyph, so 0 shows level 0.
   */
  decode(str, ctx, size = WORK, { ox = 0, oy = 0, scale = 1, debug = false, prefix } = {}) {
    const S = size * scale;
    let tokens = splitGraphemes(rleExpand(str)).filter(t => t !== ' ');
    if (prefix != null && prefix < 1) tokens = tokens.slice(0, Math.max(1, Math.round(tokens.length * prefix))); // prefix property: any cut renders
    let idx = 0;
    // First token: a background anchor glyph (fill), unless it's a DSL sprite
    // (then the canvas is cleared transparent — no anchor).
    if (tokens.length > 1 && !isDSLStart(tokens, 0)) {
      const bg = tokens[0];
      const raw = (bg && TINT_ANCHORS.includes(bg)) ? this.glyphs.anchorIdeal(bg)
        : (bg ? this.glyphs.avgColor(bg) : this.lastMean);
      ctx.fillStyle = `rgb(${Math.round(raw[0])},${Math.round(raw[1])},${Math.round(raw[2])})`;
      ctx.fillRect(ox, oy, S, S);
      idx = 1;
    } else {
      ctx.clearRect(ox, oy, S, S);
    }
    let leafMode = false;
    let frontier = [{ x: ox, y: oy, size: S, depth: 0, alpha: this.alphaForDepth(0) }];
    while (frontier.length && idx < tokens.length) {
      const next = [];
      for (const cell of frontier) {
        if (idx >= tokens.length) break;
        // A DSL sprite list claims the cell (render, skip glyph, subdivide).
        let dsl = false;
        while (idx < tokens.length && isDSLStart(tokens, idx)) { idx = this.renderSprite(tokens, idx, ctx, S); dsl = true; }
        if (dsl) {
          const hs = cell.size / 2, cd = cell.depth + 1;
          pushQuad(next, cell, hs, cd, this.alphaForDepth(cd));
          continue;
        }
        if (idx >= tokens.length) break;
        const glyph = tokens[idx++];
        if (glyph !== SKIP_MARKER) this.blend(ctx, cell.x, cell.y, cell.size, glyph, cell.alpha);
        // Subdivision directive: LEAF_MODE (!) starts a leaf run; LEAF (|)
        // marks a single leaf / ends a run; omitted => subdivide.
        if (leafMode) {
          if (idx < tokens.length && tokens[idx] === LEAF_MARKER) { idx++; leafMode = false; }
        } else if (idx < tokens.length && tokens[idx] === LEAF_MODE_MARKER) { idx++; leafMode = true; }
        else if (idx < tokens.length && tokens[idx] === LEAF_MARKER) { idx++; }
        else {
          const hs = cell.size / 2, cd = cell.depth + 1;
          pushQuad(next, cell, hs, cd, this.alphaForDepth(cd));
        }
      }
      frontier = next;
    }
  }

  // Render one DSL sprite (glyph + ops) at its transformed position; return the
  // new token index. Variable-width hex ops; x/y are no-zero sign-magnitude.
  // Public so the encoder can render seed sprites onto its recon canvas.
  renderSprite(tokens, idx, ctx, S) {
    const subject = tokens[idx++];
    let tx = 0, ty = 0, sc = 1, rot = 0, opacity = 1, hue = 0;
    while (idx < tokens.length && isOp(tokens[idx])) {
      const op = tokens[idx++];
      let hex = '';
      while (idx < tokens.length && isHex(tokens[idx])) hex += tokens[idx++];
      if (!hex) continue;
      const n = hex.length, V = parseInt(hex, 16), topBit = 1 << (4 * n - 1);
      switch (op) {
        case 'x': case 'y': {
          const sign = V >= topBit ? -1 : 1;
          const mag = (V & (topBit - 1)) + 1;
          const val = sign * mag / Math.pow(16, n);
          if (op === 'x') tx = val; else ty = val; break;
        }
        case 's': sc = V / Math.pow(16, n); break;
        case 'r': rot = V / Math.pow(16, n) * 360; break;
        case 'o': opacity = V / Math.pow(16, n); break;
        case 'h': hue = V / Math.pow(16, n) * 360; break;
      }
    }
    const cellSize = S * sc;
    const cx = S * (0.5 + tx), cy = S * (0.5 - ty); // +y up (Cartesian)
    const s = Math.max(1, Math.round(cellSize));
    const tctx = this._tempCtx(s);
    renderEmojiAt(tctx, subject, s, this.glyphs);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot * Math.PI / 180);
    if (hue && ctx.filter !== undefined) ctx.filter = `hue-rotate(${hue}deg)`;
    ctx.drawImage(this._temp, -s / 2, -s / 2);
    ctx.restore();
    return idx;
  }

}

function pushQuad(next, cell, hs, cd, alpha) {
  next.push({ x: cell.x, y: cell.y, size: hs, depth: cd, alpha });
  next.push({ x: cell.x + hs, y: cell.y, size: hs, depth: cd, alpha });
  next.push({ x: cell.x, y: cell.y + hs, size: hs, depth: cd, alpha });
  next.push({ x: cell.x + hs, y: cell.y + hs, size: hs, depth: cd, alpha });
}

// Convenience: render a string into a canvas in one call.
export function renderString(str, canvas, opts) {
  const r = new Renderer(opts);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  r.decode(str, ctx, canvas.width, opts);
  return r;
}
