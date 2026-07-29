// Semantic emoji-grid controller for the docs grid tool: CLIP whole-image classification +
// OWL-ViT detection, then a color↔semantic blend raster (box coverage + specificity) with the
// same autotune as grid-ab.html. Browser-only ML (CDN import); not exported from the library.
// grid-ab.html keeps its own inline copy for now — extracting a shared module + migrating it is
// future work (grid-ab has no headless test today).
import { ClipClassifier } from './semantic.js';
import { pipeline, env } from 'https://esm.sh/@huggingface/transformers@3';
env.allowLocalModels = false;

// Body-part anchors: decompose a person into squarer regions (head/torso/legs/feet) so square
// emoji fill them, instead of one tall whole-body box filled with face emoji. Injected regardless of
// CLIP rank. The table self-selects: OWL-ViT scores the actual garment/footwear higher than absent
// alternatives (swimwear > dress, bare feet > shoes), so the bare/clothed variants resolve correctly.
const PARTS = {
  // head
  'human face': '👤', "woman's face": '👩', "man's face": '👨', 'face': '👤', 'bearded face': '🧔', 'beard': '🧔',
  // eyewear (sunglasses over a face → the 😎 combo in classifyAndDetect)
  'sunglasses': '🕶', 'dark sunglasses': '🕶', 'glasses': '👓',
  // torso / clothing
  'bikini': '👙', 'swimwear': '👙', 'swimsuit': '👙', 'dress': '👗', 'shirt': '👕', 't-shirt': '👕', 'coat': '🧥', 'jacket': '🧥',
  // legs
  'pants': '👖', 'jeans': '👖', 'trousers': '👖', 'legs': '🦵',
  // feet
  'shoes': '👞', 'shoe': '👞', 'sneakers': '👟', 'sneaker': '👟', 'boots': '🥾', 'boot': '🥾', 'feet': '🦶', 'foot': '🦶',
};
// Demographic + role face/person emoji from CLIP (man/woman/boy/girl/pregnant/royal/dancer…).
// Suppress their whole-body boxes — parts represent the person. Without this, a tall "woman"/
// "pregnant woman" box fills with that face emoji across torso/legs/feet.
const PERSON_FACE = new Set([...'👦👧👨👩🧓👴👵🧔👱🧑👶🧒👲👳🤰🤱🤴👸🤵🕵💂👷👮🕴💃🕺👯']);
const NMS_IOU = 0.5;
const IMG_AREA = 256 * 256;

function boxIou(a, b) {
  const ix = Math.max(0, Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin));
  const iy = Math.max(0, Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin));
  const inter = ix * iy;
  const uni = (a.xmax - a.xmin) * (a.ymax - a.ymin) + (b.xmax - b.xmin) * (b.ymax - b.ymin) - inter;
  return uni > 0 ? inter / uni : 0;
}
// Non-max suppression: OWL-ViT returns heavily overlapping / duplicate boxes (often the same object
// under two labels). Collapse by IoU, keeping the highest-confidence box per cluster.
function nms(boxes, iouThr) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const b of sorted) if (kept.every((k) => boxIou(b.box, k.box) < iouThr)) kept.push(b);
  return kept;
}

// DSL sprite token encoders (spec §Translate/§Scale): sign-magnitude hex for x/y (center-origin,
// +x right/+y up, ±0.5 at edges), plain hex fraction for s. n=2 digits. Emit detected objects as
// quadtree seed sprites (base layers).
const encXY = (v, n = 2) => {
  if (Math.abs(v) < 0.5 / 16 ** (n + 1)) return '';
  const sign = v < 0 ? 1 : 0;
  const mag = Math.min(2 ** (4 * n - 1), Math.max(1, Math.round(Math.abs(v) * 16 ** n)));
  return ((sign << (4 * n - 1)) | (mag - 1)).toString(16).toUpperCase().padStart(n, '0');
};
const encS = (c, n = 2) => {
  if (c >= 1 - 0.5 / 16 ** n) return '';
  return Math.min(16 ** n - 1, Math.max(1, Math.round(c * 16 ** n))).toString(16).toUpperCase().padStart(n, '0');
};

export class SemanticGrid {
  // canvas: the 256² source canvas the encoder rasterizes and CLIP classifies.
  constructor({ encoder, canvas, keywordsByEmoji, device = 'wasm', onStatus = () => {}, onProgress = () => {} } = {}) {
    this.enc = encoder;
    this.canvas = canvas;
    this.keywordsByEmoji = keywordsByEmoji;
    this.device = device;
    this.onStatus = onStatus;
    this.onProgress = onProgress;
    this.clf = null;
    this.detector = null;
    this.hasImage = false;
    this.st = null;       // { ranked, boxes, maxScore } — cached per image
  }

  // Called after a new image is drawn to the canvas: invalidate the cached detection.
  setImage() { this.hasImage = true; this.st = null; }
  get ready() { return this.hasImage; }

  async ensureClassifier() {
    if (this.clf) return this.clf;
    this.onStatus('loading CLIP…');
    this.clf = new ClipClassifier({ device: this.device, dtype: 'fp32', keywordsByEmoji: this.keywordsByEmoji, onProgress: this.onProgress });
    return this.clf;
  }
  async ensureDetector() {
    if (this.detector) return this.detector;
    this.onStatus('loading OWL-ViT…');
    // OWL-ViT's box head emits spatially-biased garbage as q8 on WebGPU; fp32 is correct + fast.
    this.detector = await pipeline('zero-shot-object-detection', 'Xenova/owlvit-base-patch32', { dtype: 'fp32', device: this.device, progress_callback: this.onProgress });
    return this.detector;
  }

  // Classify the 256 canvas + detect objects on it; cache as this.st.
  async classifyAndDetect() {
    if (!this.hasImage) return;
    this.onStatus('classifying + detecting…');
    const clf = await this.ensureClassifier();
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    const ranked = await clf.classify(ctx.getImageData(0, 0, 256, 256).data, 256, 256); // [{emoji,label,score}]
    const broad = ranked.slice(0, 20);
    const labelToEmoji = new Map(), labelScore = new Map();
    for (const t of broad) {
      if (PERSON_FACE.has(t.emoji)) continue;              // parts handle people; skip whole-body face labels
      if (!labelToEmoji.has(t.label)) { labelToEmoji.set(t.label, t.emoji); labelScore.set(t.label, t.score); }
    }
    for (const [lbl, emo] of Object.entries(PARTS)) { if (!labelToEmoji.has(lbl)) { labelToEmoji.set(lbl, emo); labelScore.set(lbl, 0); } }
    const detector = await this.ensureDetector();
    const queryLabels = [...labelToEmoji.keys()];
    // Detect on the 256 canvas itself: OWL-ViT returns boxes in this space (no cover transform),
    // so they align exactly with the raster grid. dataURL avoids the object-URL lifecycle.
    const detected = queryLabels.length ? await detector(this.canvas.toDataURL('image/png'), queryLabels, { threshold: 0.001 }) : [];
    let rawBoxes = nms(detected, NMS_IOU);
    // 😎 combo: sunglasses over a face → render the face as 😎 and consume the standalone sunglasses box.
    const sun = rawBoxes.filter((b) => labelToEmoji.get(b.label) === '🕶');
    if (sun.length) {
      for (const fb of rawBoxes) {
        if (!['👤', '👩', '👨'].includes(labelToEmoji.get(fb.label))) continue; // any face emoji → 😎 combo
        const f = fb.box, fa = ((f.xmax - f.xmin) * (f.ymax - f.ymin)) || 1;
        const hit = sun.find((s) => {
          const ix = Math.max(0, Math.min(f.xmax, s.box.xmax) - Math.max(f.xmin, s.box.xmin));
          const iy = Math.max(0, Math.min(f.ymax, s.box.ymax) - Math.max(f.ymin, s.box.ymin));
          return ix * iy / fa > 0.3;
        });
        if (hit) { fb._combo = '😎'; hit._consumed = true; }
      }
      rawBoxes = rawBoxes.filter((b) => !b._consumed);
    }
    const clamp = (v) => Math.max(0, Math.min(256, v));
    const boxes = rawBoxes
      .map((b) => ({ label: b.label, xmin: clamp(b.box.xmin), ymin: clamp(b.box.ymin), xmax: clamp(b.box.xmax), ymax: clamp(b.box.ymax), emoji: b._combo || labelToEmoji.get(b.label), score: b.score, clip: labelScore.get(b.label) || 0 }))
      .filter((r) => r.emoji);
    this.st = { ranked, boxes, maxScore: (ranked[0] && ranked[0].score) || 1 };
  }

  // Biased (color + localized-semantic) grid. The boost value is the cell's semantic distance:
  //   sn = (1 − score)·strength + (1 − strength) − spec·specificity·strength
  // strength = cell∩box / min(cellArea, boxArea) (1 when the box fully contains the cell or vice
  // versa; <1 only straddling an edge); specificity = 1 − box/imageArea (small box → ~1). Confidence
  // drives selection; strength feathers box edges; spec (manual, 0–1) is how strongly specificity
  // favors smaller/foreground boxes over larger/background ones in overlaps. λ is the sole
  // color↔semantic control (no separate plaus gate).
  async biasedGrid(cols, rows, lambda, thr, spec, blank) {
    const regions = this.st.boxes.filter((b) => b.score >= thr);
    const boost = (x0, y0, x1, y1) => {
      const cellArea = (x1 - x0) * (y1 - y0) || 1;
      const m = new Map();
      for (const r of regions) {
        if (!r.emoji) continue;
        const ix = Math.max(0, Math.min(x1, r.xmax) - Math.max(x0, r.xmin));
        const iy = Math.max(0, Math.min(y1, r.ymax) - Math.max(y0, r.ymin));
        const overlap = ix * iy;
        if (overlap <= 0) continue;
        const boxArea = (r.xmax - r.xmin) * (r.ymax - r.ymin);
        const strength = overlap / Math.min(cellArea, boxArea);
        const specificity = 1 - boxArea / IMG_AREA;
        let sn = (1 - r.score) * strength + (1 - strength) - spec * specificity * strength;
        if (sn < 0) sn = 0;
        const prev = m.get(r.emoji);
        if (prev === undefined || sn < prev) m.set(r.emoji, sn);
      }
      return m;
    };
    const { grid } = await this.enc.rasterize(this.canvas, { cols, rows, boost, lambda, blank });
    return { grid, regions };
  }

  async autotune(cols) {
    // box threshold: scan up from 0.005, keep detections displaying ≥2% (remove only ~1% items).
    // λ = 3/cols clamped to [0.01,0.99] (semantic weight inversely proportional to resolution).
    let thr = 0.005;
    for (let t = 0.005; t <= 0.5; t = Math.round((t + 0.005) * 1000) / 1000) {
      if (this.st.boxes.filter((b) => b.score >= t).every((b) => Math.round(b.score * 100) >= 2)) { thr = t; break; }
    }
    const lambda = Math.max(0.01, Math.min(0.99, Math.round((3 / cols) * 100) / 100));
    return { thr, lambda };
  }

  // Build a DSL seed string of the top detections as positioned sprites (quadtree base layers):
  // <emoji>x<xt>y<yt>s<st>, center-origin (+x right, +y up), s = min(box w,h). Dedupes by emoji
  // (best box each), caps at max, drops below thr. The quad encoder paints these before growing.
  seedDsl({ max = 16, thr = 0.05, maxArea = 0.5 } = {}) {
    if (!this.st) return '';
    const IMG = 256 * 256;
    const best = new Map();
    for (const b of this.st.boxes) {
      if (b.score < thr || !b.emoji) continue;
      if (((b.xmax - b.xmin) * (b.ymax - b.ymin)) / IMG > maxArea) continue; // drop obscuring whole-image boxes
      const e = best.get(b.emoji);
      if (!e || b.score > e.score) best.set(b.emoji, b);
    }
    // Select the top-N by detection score, then render largest-first. Sprites paint back-to-front
    // in list order, so a huge sprite listed later would bury a smaller, better-placed one — biggest
    // goes to the back so the smaller/good ones land on top.
    const boxes = [...best.values()].sort((a, b) => b.score - a.score).slice(0, max)
      .sort((a, b) => ((b.xmax - b.xmin) * (b.ymax - b.ymin)) - ((a.xmax - a.xmin) * (a.ymax - a.ymin)));
    return boxes.map((b) => {
      const cx = ((b.xmin + b.xmax) / 2) / 256 - 0.5;
      const cy = 0.5 - ((b.ymin + b.ymax) / 2) / 256;
      const s = Math.min((b.xmax - b.xmin) / 256, (b.ymax - b.ymin) / 256);
      const x = encXY(cx), y = encXY(cy), ss = encS(s);
      return b.emoji + (x ? 'x' + x : '') + (y ? 'y' + y : '') + (ss ? 's' + ss : '');
    });
  }
}
