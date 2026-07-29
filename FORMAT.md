# imgoji format (v1)

A model for composing images from Unicode glyphs, plus serializations of that
model. A subject is one or more glyphs rendered as a text run, placed and
transformed in a unit square. Subjects render back-to-front, so order gives
z-ordering with no index field.

Two projects share this model. The composition project places glyphs by hand.
The codec project approximates a raster image with a quadtree of blended emoji.
The codec is the novel core; the composition model is a constrained scene graph.

## Model vs syntax

The model is the spec. Syntax is a swappable layer on top.

- **Model.** What a scene is: an ordered list of placed, transformed glyph
  subjects, rendered back-to-front. Syntax-independent.
- **Reference serialization: JSON.** Standard, typed values, universal tooling.
  The form machines and programs exchange.
- **Compact serialization: DSL.** Atomic lowercase-letter ops with uppercase
  hex values, aimed at hand-authoring and markup embedding. Specified in §Compact
  serialization: the DSL.
- **Render target: SVG.** The model is a constrained scene graph, and SVG is the
  standard scene-graph format. SVG also renders the codec with no custom decode
  code, because the codec's blend is ordinary alpha compositing. SVG is an output
  target, not the authoring syntax.

Defining the model first keeps the syntax decision from painting anything into a
corner. JSON, the DSL, and SVG are three views of the same model, chosen per use
case.

## The model

### Structure

```
scene      = { version, background?, exprs: [expr] }
expr       = sprite | group | directive
sprite     = { subject: glyphrun, transform?, color? }
group      = { transform?, exprs: [expr] }
directive  = { name, value }              // scene-level metadata, renders nothing
transform  = { rotate?, scale?, translate?, opacity? }
glyphrun   = one or more grapheme clusters
```

Field names belong to the serialization, not the model. JSON may spell them out
(`rotate`, `opacity`); the DSL abbreviates each to a letter (`r`, `o`). The
concepts are stable across serializations.

### Subjects

A subject is one or more glyphs rendered as a **text run**: glyphs laid out
left-to-right using font advance widths on a shared baseline. A single glyph is
a run of length one. The whole run's bounding box takes the sprite's transforms.

Grapheme clusters count as one glyph. ZWJ sequences, flag regional-indicator
pairs, and variation-selector sequences are single subjects. Tools split on
grapheme clusters, not code units.

### Transforms and coordinate system

The canvas is the unit square. A subject's reference point is the center of its
bounding box, and transforms are frame-relative so a scene is resolution- and
font-independent: positions and sizes are fractions of the frame side, angles
are fractions of a turn.

| field | meaning | range | default |
|---|---|---|---|
| `translate` | offset from frame center, `[dx,dy]` | each `[-0.5, 0.5]` (±0.5 = edges); `+x` right, `+y` up | `[0,0]` (center) |
| `rotate` | rotation about center, clockwise | angle (cyclic) | `0` |
| `scale` | size as coverage of the frame side | `[0,1]` (1 = fills the frame); uniform, or `[sx,sy]` | `1.0` (full frame) |
| `opacity` | compositing weight | `[0,1]` | `1.0` (full) |
| `hue` | hue rotation of the subject's pixels (HSV) | angle (cyclic) | `0` (native color) |

Angles (`rotate`, `hue`) are cyclic, so they carry no sign: the DSL encodes each
as an unsigned fraction of a turn `[0,1)`; JSON below may write degrees (signed
or not, they wrap). Render order for a sprite: rasterize the subject, apply
`hue` to its pixels, then `scale`, `rotate`, `translate` about its center, then
composite with `opacity` (source-over). A group applies scale/rotate/translate
to its combined bounding box after its children render.

Sizes are frame-relative, so there is no notion of a 'natural' glyph size — a
subject with no `scale` fills the frame (`1.0`), which keeps the scene
font-independent. The compact DSL (§Compact serialization) and the JSON below
are two serializations of this same transform set; they differ only in how they
write the values.

### Color (hue) by glyph class

Color is a hue rotation of the subject's pixels (`hue` above), not a geometric
transform. It shifts every pixel's hue by a given angle in HSV space, leaving
saturation and value unchanged (à la CSS `hue-rotate`); the default angle is 0
(native colors).

Hue rotation affects only chromatic pixels:

- **Color glyphs** (emoji and other inherently colored glyphs): hue shifts their
  colors — a ½-turn (`hue 0.5`) maps each hue to its complement.
- **Monochrome glyphs** (ASCII, CJK, symbols) and neutral pixels (white, black,
  gray): unaffected, since hue is undefined at zero saturation. Coloring
  monochrome text needs a future direct-fill op, not hue.

The renderer classifies a glyph as color or monochrome by consulting the font
and glyph.

### Z-order and rendering

1. Fill the unit square with `background`, or leave it transparent.
2. For each sprite in list order, render its subject to a bitmap, apply hue,
   scale, rotate, translate about its center, apply opacity, and composite onto
   the canvas with source-over alpha.
3. Groups render their children in order first, then apply the group's own
   transform to the union bounding box.
4. Later sprites paint over earlier ones. This is the only z-ordering rule.

### Resolution independence and the system font

All coordinates are fractions of the unit square, so a scene renders at any
output size. Glyphs resolve to the viewer's system font; no font is embedded.
This is deliberate: the affordance the format exploits is that every device
ships a glyph set, so referencing glyphs by codepoint needs zero asset
distribution.

The same scene renders differently across platforms (Apple, Google, Noto emoji).
Under this model that is intended behavior, not drift to suppress.

## Reference serialization: JSON

```json
{
  "version": 1,
  "background": "000000",
  "exprs": [
    { "subject": "🌍", "transform": { "hue": 120 } },
    { "subject": "🚀", "transform": { "translate": [0.2, 0.2], "scale": 0.5, "rotate": -20 } },
    { "subject": "Hello", "transform": { "translate": [0, -0.3], "scale": 0.4 } },
    { "group": true, "transform": { "rotate": 30 }, "exprs": [
      { "subject": "😀", "transform": { "translate": [-0.1, 0] } },
      { "subject": "🐽", "transform": { "translate": [0.1, 0] } }
    ]}
  ]
}
```

Values are typed: numbers for `rotate`, `scale`, `opacity`, `hue`; two-element
arrays for `translate` and non-uniform `scale`; strings for `subject`. Angles
are in degrees here; positions and sizes are frame fractions. Strings hold any
glyphs including whitespace, so no disambiguation or quoting rules are needed —
the chief structural advantage of JSON over a custom DSL.

A future `directive` set covers scene metadata (`version`, `background` are the
first two). Unknown fields are ignored for forward compatibility.

## Compact serialization: the DSL

A sprite is a glyph run (the subject) followed by zero or more transform ops.
Each op is a **lowercase letter** naming the transform, then **uppercase hex**
digits giving its value:

```
🎪s33h8       tent at ~20% of the frame, hue-shifted 180°
🚀x4Dy2Fr1    rocket offset from center, rotated 22.5°
🌍            globe: full frame, centered, native (every op omitted)
```

Whitespace separates sprites; they paint back-to-front (later covers earlier).
Grouping is not in the DSL yet (the model's `group` is a JSON-level concept) and
is deferred.

### Charset and parsing

One invariant carries the whole grammar: **lowercase ASCII = operators,
uppercase `[0-9A-F]` = hex data.** Values are self-delimiting — read hex until a
non-hex character (the next op, a new subject, or a structural marker). The same
split disambiguates a DSL sprite from the codec's quadtree body (§Codec): the
body never contains a lowercase letter, so "a glyph immediately followed by a
lowercase letter" is unambiguously a transform op. A sprite with no ops at all
(every transform at its default) carries no lowercase letter and is therefore
indistinguishable from a body cell; in a codec string such a sprite must carry
at least one explicit op (commonly opacity) to be recognized as a DSL sprite. A
recognized DSL sprite claims its cell (§Codec): the quadtree emits no full-size
glyph there and subdivides, so deeper cells refine over the sprite.

### Values: variable width = precision

Every op's value is one or more hex digits. More digits means a *finer* value,
not a larger range, and a shorter prefix is a valid coarser approximation — the
codec's prefix property applied to transforms. One digit ≈ 16 levels (~6% for
linear quantities, 22.5° for cyclic); two ≈ 256 levels (~0.4% / ~1.4°); three is
sub-0.1°. Write as many digits as the placement warrants.

### Ops

| op | quantity | value mapping | omit (default) |
|---|---|---|---|
| `x`, `y` | translate, center-origin | no-zero sign-magnitude (below); unit `1/16ⁿ`, range ±0.5 | `0` (center) |
| `r` | rotate | `V/16ⁿ × 360°`, clockwise, `[0,360°)` | `0°` |
| `s` | scale (shrink) | coverage `V/16ⁿ` of the frame side, `(0,1)` | `1.0` (full frame) |
| `o` | opacity | `V/16ⁿ`, `[0,1)` | `1.0` (full) |
| `h` | hue rotation | `V/16ⁿ × 360°` shift, HSV, `[0,360°)` | `0°` (native color) |

Reserved, deferred: **`z`** — zoom (scale up), coverage `1 + V/16ⁿ` over `(1,2]`,
omit `1.0`. Op letters are kept out of `a`–`f` (hex letters): opacity is `o`, not
`a`; color is `h`, not `c`.

Omitting an op applies its default, so a sprite carries only the ops it changes.

### Translate (`x`, `y`) — the only signed op

Offsets are from the frame center (emoji are center-oriented); ±0.5 reaches the
edges. `+x` is right, `+y` is up (Cartesian). The encoding is no-zero
sign-magnitude, which pins the range to ±0.5 at every width so that width
controls granularity alone:

- **Sign** = the top bit of the leading nibble: `0–7` positive, `8–F` negative.
- **Magnitude** = the remaining bits + 1 (no-zero: `x0` is +1 unit, never 0).
- **Unit** = `1/16ⁿ`.

```
x0  +1/16 ≈ 0.06      x7  +0.5  (right edge)
x8  −1/16             xF  −0.5  (left edge)
x4B +76/256 ≈ 0.30    x7F +0.5  (max at 2 digits)
```

Cost: the value is not readable as plain hex — the +1 bias and sign-magnitude
mean `x4B` decodes to 76/256, not 75/256. Fine for encoder output; a mild tax
when hand-writing.

### Scale (`s`) and opacity (`o`) — magnitudes

Both are plain unsigned `V/16ⁿ`, with the maximum left to the default: omit means
full (scale = full frame, opacity = fully opaque), the common case, so neither
is written unless something is actually shrunk or made translucent. `s0` (zero
size) and `o0` (invisible) are harmlessly redundant — you would not place an
invisible sprite.

```
🎪s33   ~20% of frame    🎪s8   50%       🎪    full frame (omit)
🔵o8    50% opaque       🔵o0   invisible (≡ a skip)   🔵   fully opaque (omit)
```

### Rotation (`r`) and hue (`h`) — cyclic, unsigned

Both are fractions of a full turn, `V/16ⁿ × 360°`, single direction. Being
cyclic, sign is meaningless (+270° = −90°, and likewise for hue), so they are
unsigned. A cyclic quantity cannot have all codes nonzero without `n/n` wrapping
to 0, so `r` and `h` are the two ops allowed a redundant `0` value (`r0`, `h0`)
equivalent to omit.

```
r4  90°     r8  180°     rC  270°     h8  180° hue shift (complement)
```

`h` rotates hue in HSV space — it shifts every chromatic pixel uniformly (a
blunt recolor on multi-color emoji; clean on single-color glyphs). Neutrals
(white/black/gray) and monochrome glyphs are untouched (hue is undefined at
S=0), so coloring text needs a future direct-fill op.

### Relation to the model above

The DSL and §The model now share one set of conventions — center-origin
translate, frame-coverage scale, cyclic angles, hue color — defined in the model
and encoded compactly here. The only difference is encoding: the DSL writes
values as variable-width uppercase hex, JSON writes them as decimal
numbers/arrays. No semantic gap remains between the two serializations.

## Render target: SVG

The model is a constrained scene graph. SVG is the standard text-based
scene-graph format, and it covers the model almost completely.

| model concept | SVG |
|---|---|
| subject glyph run | `<text>` (system font, no embedding) |
| rotate / scale / translate | `transform` |
| opacity | `opacity` |
| color (hue) | SVG/CSS `hue-rotate` filter (`fill` is still ignored by color glyphs) |
| group | `<g>` |
| z-order | document order |
| background | `<rect>` filling the viewBox |
| resolution independence | vector; browser re-rasterizes at display DPI |
| viewer's emoji set | `<text>` resolves to the system font |

SVG is XML, so it is verbose and carries XML's syntax and escaping baggage. It
is an output and render target, not the authoring syntax. Author in JSON (or the
DSL); render to SVG when a browser or SVG viewer is the consumer.

### The codec renders to SVG with no decoder

The codec's blend is `A' = (1-a)A + a*E`. That is source-over alpha compositing
with source opacity `a`:

```
result = a * src + (1 - a) * dst
```

So rendering a codec scene to SVG is: emit each cell's glyph as a `<text>`
element at its quadtree position and scale, with `opacity` equal to the cell
alpha, in breadth-first document order. The browser's compositor does the
blending. The decoder is the browser; no custom compositing code is needed.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">
  <rect width="1" height="1" fill="#a9b7c4"/>
  <text x="0" y="1" font-size="1" opacity="1">🌍</text>
  <text x="0" y=".5" font-size=".5" opacity=".7">🏔️</text>
  <text x=".5" y=".5" font-size=".5" opacity=".7">🌊</text>
  <text x="0" y="1" font-size=".5" opacity=".7">🌳</text>
  <text x=".5" y="1" font-size=".5" opacity=".7">🏜️</text>
</svg>
```

Glyph-box alignment to the cell is approximate because emoji baseline metrics
vary by font. That is consistent with the model's acceptance of font-dependent
rendering, and blending averages out small misalignment.

### Caveats

- **Resolution independence has a ceiling.** Color emoji are raster glyphs in
  every shipping font, topping out around 128 to 160px. SVG scales without
  stair-stepping, but zooming past the glyph's intrinsic resolution upscales it.
  True infinite detail would need vector color emoji fonts, which do not exist.
- **File size.** An explicit `<text>` per cell is verbose. Adaptive depth 6 on
  `earth.jpg` is roughly 600 to 2800 cells, about 50 KB to 340 KB uncompressed.
  `<defs>` plus `<use>` instances repeated glyphs, recovering run-length gains
  within the standard, and gzip compresses the repetitive text another 5 to 10x.
  If size matters more than zero-custom-code, the codec's compact BFS string can
  ride inside the SVG in a `<script>` that expands to DOM.

## Codec

The codec is the novel part. It approximates a raster image as a quadtree of
blended glyphs: breadth-first subdivision, each cell picks the glyph that best
matches its region, each glyph blends over its parent's accumulated render. A
prefix of the output is a valid coarser image. Full detail is in `README.md`.

The codec's native serialization is a compact position-implicit BFS string: the
position of a token implies its quadtree region, so no per-cell coordinates are
stored. The string is run-length encoded for transmission; an expander reverses
the RLE, then walks the BFS quadtree painting each cell.

### The string grammar (ABNF)

The decoded stream (RLE expanded) is an optional background anchor followed by a
BFS sequence of cells. A cell is **either** a list of one or more DSL sprites
(positioned emoji that claim the cell) **or** a single full-size glyph followed
by an optional subdivision marker.

```abnf
stream     = [bg-anchor] *cell

bg-anchor  = GRAPH                     ; present iff the first unit is a glyph not
                                       ;   immediately followed by an op-letter

cell       = dsl-list / quad-cell
dsl-list   = 1*sprite                  ; claims the cell: render the positioned
                                       ;   sprites, skip the full-size glyph, and
                                       ;   subdivide (deeper cells refine over them)
sprite     = GRAPH 1*op
op         = op-letter 1*HEXDIG
op-letter  = "x" / "y" / "r" / "s" / "o" / "h"

quad-cell  = fill [leaf-token]
fill       = GRAPH / SKIP              ; SKIP paints nothing, inheriting the parent
leaf-token = LEAF-MODE / LEAF          ; omitted => subdivide into four children
SKIP       = "-"
LEAF       = "|"                       ; this cell is a leaf (do not subdivide)
LEAF-MODE  = "!"                       ; this leaf starts a run; following cells are
                                       ;   auto-leaves until a LEAF ends the run

GRAPH      = <a Unicode grapheme cluster; not ASCII [0-9A-F], not an ASCII
             lowercase letter, and not one of "-", "|", "!">
HEXDIG     = DIGIT / "A" / "B" / "C" / "D" / "E" / "F"
```

**Leaf runs are stateful.** `!` and `|` bracket a run of two or more leaves so
interior leaves carry no marker; an expander tracks an in-run flag. In the
explicit (uncompressed) form every leaf carries `|` and `!` is unused — `!` is a
size optimization for leaf-heavy trees, not a distinct cell type.

**Run-length encoding.** The wire form compresses each maximal run of N >= 2
identical graphemes to `GRAPH` followed by N in uppercase hex; a run of one is
just the grapheme. A DSL op (lowercase letter + its hex value) is passed through
verbatim and is never read as a run count. Counts, op values, and the body share
the `[0-9A-F]` alphabet but never collide: hex after a lowercase op-letter is an
op value, hex after a glyph in a run is a count, and the quadtree body itself
contains no lowercase letters.

**Prefix property.** A prefix of the string is a valid, coarser image: every
emitted glyph is painted, and an incomplete subdivision inherits its parent's
render. Cutting the stream at any point yields a recognizable lower-resolution
frame — the property that lets a semantic anchor (a DSL sprite at the root) read
clearly before the quadtree refines color over it.

An expander converts the string to the model, or directly to SVG for browser
rendering (§Render target: SVG); the browser's compositor does the blending.

## Forward compatibility

- Unknown fields and directives are ignored, not errors. A decoder renders what
  it recognizes.
- `version` gates behavior. Absent means `1`. If a file's version exceeds a
  decoder's, the decoder renders the recognized subset and may warn.

Lenient parsing trades early typo detection for partial-render compatibility. A
strict validator can be a separate tool.

## Open questions

- **Codec emitter target.** Does the codec emit the model (JSON), SVG, or its
  compact BFS string as primary, with the others as conversions? The decoder
  choice (custom expander vs browser-via-SVG) follows from this.
- **Cluster layout.** A second multi-glyph layout that overlays glyphs at one
  anchor instead of flowing them as text. A `layout` field or a distinct subject
  form. Deferred.
- **Pivot override.** Let `rotate` and `scale` act about a point other than the
  bounding box center. Deferred.
- **Font selection.** A field to name a font family for monochrome text. Deferred
  until cross-platform font behavior is pinned.
- **Text direction.** RTL and vertical runs. Deferred.
- **Color in SVG.** The DSL's hue op (`h`) maps to an SVG/CSS `hue-rotate` filter
  on the sprite. Full color (saturation, value, and direct fill for monochrome
  text) is deferred, along with how it renders in SVG beyond `hue-rotate`.
