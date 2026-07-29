<img width="932" height="326" alt="image" src="https://github.com/user-attachments/assets/f60f2668-1504-4ed9-b728-42caeecc0bbb" />


# imgoji

An experimental image codec that encodes a square image as a string of emoji
characters. Compositing the emoji back together reconstructs a lossy
approximation of the original image.

The emoji string is the encoded form. It is compact and transmissible as plain
text. A decoder renders the referenced glyphs at the regions they encode.

## Platform

The codec runs in the browser. JavaScript renders emoji to a canvas using the
system emoji font (modern browsers render color emoji on canvas), reads pixels
back for the similarity search, and composites the reconstruction on the same
canvas. The browser supplies the emoji, so no glyph assets are bundled.

Each cell's search compares against every emoji, so each emoji is rendered once
to an offscreen glyph atlas and reused, not re-rendered per comparison.

A consequence of using the system font: glyph pixels depend on the viewer's
operating system. macOS renders Apple emoji, Windows renders Segoe UI Emoji,
Linux and Android render Noto. A string encoded in one browser decodes to
slightly different pixels in another. Encode and decode stay self-consistent
within a single browser session, which uses one font. Cross-platform drift is
expected and treated as an experiment, not a defect.

## Encoding model

A quadtree approximates the image. The first emoji approximates the whole image.
The next four approximate the upper-left, upper-right, bottom-left, and
bottom-right quadrants. The following sixteen approximate each quadrant's four
sub-quadrants, and so on.

A prefix of the string is always a valid approximation. Longer strings refine
finer regions and get progressively closer to the source. The reconstruction is
resolution independent: each emoji is scaled to cover the region it represents,
so the same string renders at any output size.

Each cell beyond the root blends its chosen emoji with the parent cell's
rendered value over that region. Blending makes the approximation converge:
the final color at a pixel is a weighted combination of the emoji on the chain
from the root to the finest cell covering it, and each level shrinks the
residual. The blend is RGB alpha compositing, `A' = (1-a)A + a*E`, at a fixed
ratio (0.65 by default). The root cell has no parent and takes a=1. Each deeper
cell picks the emoji that minimizes residual against the original over its
region. A pure replace operator was ruled out: at the one-emoji-per-pixel limit
it confines the output to the discrete set of emoji mean colors and plateaus
instead of converging.

The first cell, and optionally the first few, can be user-supplied as a seed.
A seed pins those positions to chosen emoji so the head of the string carries a
thematic anchor (a globe for a planet photo) while the auto-encoded tail drives
the reconstruction toward the original. Seeded cells are painted, not searched.
Deeper cells blend over them as usual. A pixel-poor seed leaves residual that
refinement removes only gradually. Higher alpha and deeper quadtree recover it.

## Status

The encoder lives in `src/`. `docs/index.html` is the interactive tool. It
loads an Emoji-property codepoint list from `assets/emoji-list.js`, generated
from Unicode emoji-data.txt 15.1.0 across the classic pictograph ranges with
modifiers and components excluded. Solid color-anchor emoji (circles and
squares, including black and white) are included to extend the palette's convex
hull so blending can reach extreme colors. The list is pinned to 15.1.0 rather
than latest so it excludes bleeding-edge emoji that current system fonts may not
ship and would render as tofu.

Verified on `assets/earth.jpg` (NASA Earthrise). Reconstruction RMS against the
original (alpha 0.7, no seed) falls with depth: 142 mean-color baseline, 145 at
depth 0, 127 at depth 1, 107 at depth 2, 93 at depth 3, 76 at depth 4, 61 at
depth 5, 53 at depth 6. Depth is capped at 8 (one pixel per cell at 256²).
Adding the color-anchor palette drops depth 6 to about 51.

Reference image: `assets/earth.jpg`, 1000x1000.

## Running

Serve the repo over http, then open http://localhost:8000/docs/:

    python3 -m http.server 8000
    bunx serve .

`docs/index.html` is the tool: it encodes an image, decodes any imgoji string
via `<imgoji-viewer>`, and rasterizes a flat emoji grid for terminals. Serve
from the repo root (not from `docs/`) so `../src` and `../assets/emoji-list.js`
resolve. http is required rather than file://, because the encoder loads
`earth.jpg` and reads its pixels via `getImageData`. A same-origin server keeps
the canvas untainted.

## As a library

The codec ships as importable ES modules in `src/`, with no build step. The
**renderer** (string to pixels) and **encoder** (image to string) are separate:
a page that only displays strings imports `imgoji/render` and pulls in no
encoder or glyph-atlas code. The public API is JSDoc-annotated in the source.
Regenerate the API reference (TypeDoc) with `bun run docs:api`.

### Put a viewer on your page

Register the element once, then use it anywhere. The string is the element's
text content: inline, copyable, and it degrades to plain text without JS.

```html
<!doctype html>
<meta charset="utf-8">
<!-- serve viewer.js and its imports (render.js, glyph.js, util.js) over http(s) -->
<script type="module" src="/imgoji/viewer.js"></script>

<imgoji-viewer alpha="0.65" style="width:320px">⬛🌍s4🏔️s8…</imgoji-viewer>
```

Loading: `viewer.js` is an ES module with relative imports, so serve the four
files (`viewer.js`, `render.js`, `glyph.js`, `util.js`) from one directory over
http(s). The package is not on a CDN or npm yet. Copy the files from `src/`.

| attribute  | default | meaning                                                             |
| ---------- | ------- | ------------------------------------------------------------------- |
| (text)     |         | the imgoji string (used unless `src` is set)                        |
| `alpha`    | `0.65`  | per-layer blend weight. Colors drift if it differs from the encoder's `alpha`. |
| `prefix`   | full    | render only the first fraction `0..1` (the prefix property). `0` is the root glyph |
| `autoplay` | off     | animate `prefix` from 0 to 1 on render                              |
| `src`      |         | URL of an `.imgoji` file to fetch (overrides the text content)      |

The `.value` property holds the string. Setting it re-renders.

Size it with CSS like any element (`width`, `height`). The viewer renders to match
its displayed size and re-renders on resize, so it stays as sharp as the system
emoji font allows. The codec image is square. A non-square box stretches it,
which is intended.

### Render (display only)

```js
import { Renderer } from 'imgoji/render';   // pulls in no encoder code

const r = new Renderer();
r.decode(string, ctx);                        // codec BFS string onto a 2D context
r.decode(string, ctx, 256, { prefix: 0.5 });  // render half the stream
r.decode('🌍r0 🚀x4y2', ctx);          // DSL composition (r0 renders the leading glyph as a picture)
```

### Encode (image to string)

```js
import { Encoder } from 'imgoji';

const enc = new Encoder();
const { string, deflatedBytes, de00 } = await enc.encode(image, {
  byteTarget: 8192,   // deflated-byte budget (threshold is searched to hit it)
  alpha: 0.65,        // must match the viewer's alpha
  seed: '🌍s4',        // optional DSL base layers
});
// flat emoji grid for terminals or chat:
const { grid } = await enc.rasterize(image, { cols: 24, rows: 24 });
```

`docs/index.html` (served from the project root) is the interactive tool: it
encodes a chosen image with `Encoder`, renders the string in an
`<imgoji-viewer>`, and scrubs the prefix to show the progressive property. See
`FORMAT.md` for the string grammar.
