// <imgoji-viewer>: drop-in element that renders an imgoji string to a canvas.
// Full API in the class JSDoc below.

import { Renderer } from './render.js';

const WORK = 256;
export const MAX_RES = 2048;   // cap on internal render resolution (memory); otherwise display-aware

/**
 * Drop-in custom element that renders an imgoji string to a canvas.
 *
 * The string is the element's text content: inline, copyable, and it degrades to
 * plain text without JavaScript. The canvas renders to match the host's display
 * size (× devicePixelRatio) and re-renders on resize, so output is as sharp as
 * the system emoji font allows. The codec image is square. A non-square host
 * stretches it by design.
 *
 * Register once (the module side-effect defines the element):
 *   <script type="module" src="imgoji/viewer.js"></script>
 * Use anywhere:
 *   <imgoji-viewer alpha="0.7">⬛🌍s4🏔️s8…</imgoji-viewer>
 *
 * @customElement imgoji-viewer
 * @attr {number} [alpha=0.65] Per-layer blend weight. Must match the encoder's
 *   alpha, or colors drift.
 * @attr {number} [prefix] Fraction of the stream to render, 0..1 (the prefix
 *   property). Omit for the full string; `0` renders only the root glyph.
 * @attr {boolean} [autoplay] If present, animate prefix 0→1 (~1.4s) on render.
 * @attr {string} [src] URL of an `.imgoji` file to load via fetch; overrides the
 *   text content.
 * @property {string} value - The imgoji string. Assigning it re-renders.
 */
class ImgojiViewer extends HTMLElement {
  constructor() {
    super();
    this._renderer = new Renderer();
    this._canvas = document.createElement('canvas');
    this._canvas.width = WORK; this._canvas.height = WORK;
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._str = '';
    this._raf = 0;
    this._ro = null;            // ResizeObserver → re-render at display size
    this._renderSize = WORK;    // last internal render resolution (read-only via renderSize)
    this._renderSig = '';       // (length,res) signature; emit 'render' when it changes
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host{display:inline-block;width:256px;height:256px;line-height:0}canvas{width:100%;height:100%;display:block;image-rendering:auto}`;
    root.appendChild(style);
    root.appendChild(this._canvas);
  }
  static get observedAttributes() { return ['alpha', 'prefix', 'autoplay', 'src']; }

  connectedCallback() {
    if (this.getAttribute('src')) this._loadSrc();
    else if (this._str === '' && this.textContent != null) { this._str = this.textContent.trim(); }
    this._applyAttrs();
    this._observe();
    this._render();
  }
  disconnectedCallback() { cancelAnimationFrame(this._raf); this._unobserve(); }

  // Re-render when the host's display size changes, so the internal canvas tracks
  // display × devicePixelRatio (the decode cost is bounded; coalesced via rAF).
  _observe() {
    if (this._ro || typeof ResizeObserver === 'undefined') return;
    this._ro = new ResizeObserver(() => {
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => this._render());
    });
    this._ro.observe(this._canvas);
  }
  _unobserve() { if (this._ro) { this._ro.disconnect(); this._ro = null; } }

  attributeChangedCallback() { this._applyAttrs(); this._render(); }

  _applyAttrs() {
    const a = parseFloat(this.getAttribute('alpha'));
    if (!isNaN(a)) this._renderer.alpha = a;
  }
  async _loadSrc() {
    try { this._str = await (await fetch(this.getAttribute('src'))).text(); this._render(); }
    catch (e) { this._str = ''; }
  }

  /** The imgoji string. Assigning it re-renders. @type {string} */
  set value(v) { this._str = v || ''; this._render(); }
  get value() { return this._str; }
  /** Last internal render resolution (the square canvas backing-store side, px). Read-only. */
  get renderSize() { return this._renderSize; }

  _render() {
    cancelAnimationFrame(this._raf);
    if (!this.isConnected || !this._str) return;
    const prefixAttr = parseFloat(this.getAttribute('prefix'));
    if (this.hasAttribute('autoplay')) this._animate(performance.now());
    else this._draw(isNaN(prefixAttr) ? 1 : prefixAttr);
  }
  _animate(start) {
    const p = Math.min(1, (performance.now() - start) / 1400);
    this._draw(p);
    if (p < 1) this._raf = requestAnimationFrame(() => this._animate(start));
  }
  _draw(prefix) {
    // Render at the canvas's display size × devicePixelRatio (floored to WORK,
    // capped at MAX_RES), so sharpness is bounded by the system emoji font, not a
    // fixed 256. decode floors to >=1 token, so prefix 0 still renders the root glyph.
    const css = this._canvas.clientWidth || WORK;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const S = Math.max(WORK, Math.min(MAX_RES, Math.round(css * dpr)));
    this._renderSize = S;
    if (this._canvas.width !== S) { this._canvas.width = S; this._canvas.height = S; }
    this._renderer.decode(this._str, this._ctx, S, { prefix });
    // Notify when content or resolution changes (not on every animation frame), so
    // listeners such as a zoom affordance can refresh without polling.
    const sig = this._str.length + '/' + S;
    if (this._renderSig !== sig) { this._renderSig = sig; this.dispatchEvent(new Event('render')); }
  }
}

if (!customElements.get('imgoji-viewer')) customElements.define('imgoji-viewer', ImgojiViewer);

export { ImgojiViewer };
