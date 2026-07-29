// <imgoji-viewer> — drop-in element that renders an imgoji string to a canvas.
// Full API in the class JSDoc below.

import { Renderer } from './render.js';

const WORK = 256;

/**
 * Drop-in custom element that renders an imgoji string to a canvas.
 *
 * The string is the element's text content: inline, copyable, and it degrades to
 * plain text without JavaScript. The canvas renders at 256² (the codec's
 * canonical resolution) and CSS-scales to the host, so the element is
 * resolution-independent.
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
    this._render();
  }
  disconnectedCallback() { cancelAnimationFrame(this._raf); }

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
    // decode floors to >=1 token (render.js), so prefix 0 renders exactly the root glyph.
    this._renderer.decode(this._str, this._ctx, WORK, { prefix });
  }
}

if (!customElements.get('imgoji-viewer')) customElements.define('imgoji-viewer', ImgojiViewer);

export { ImgojiViewer };
