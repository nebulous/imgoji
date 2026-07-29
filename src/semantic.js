// Browser-only CLIP keyword classifier for the grid encoder. Embeds every emoji's
// candidate terms (name + word-split synonyms) once with CLIPTextModelWithProjection,
// then per image embeds it with CLIPVisionModelWithProjection and scores each emoji as the
// MAX over its terms — so compound names like "earth americas" also score via "earth".
// Output is softmax (CLIP logit_scale) so the %-threshold matches the zero-shot pipeline.
// Injected/used by the page; the core (encode.js) imports no ML library. CDN import, no build.
import { CLIPTextModelWithProjection, CLIPVisionModelWithProjection, AutoTokenizer, AutoProcessor, RawImage, env } from 'https://esm.sh/@huggingface/transformers@3';
env.allowLocalModels = false;

// CLIP-vit-base learned logit_scale ≈ exp(4.6) ≈ 100; sharpens cosine into the softmax
// probability scale the zero-shot-image-classification pipeline uses.
const LOGIT_SCALE = 100;

export class ClipClassifier {
  constructor({ modelId = 'Xenova/clip-vit-base-patch32', device = 'wasm', dtype = 'fp32', keywordsByEmoji = new Map(), template = 'This is a photo of {}.', onProgress } = {}) {
    this.modelId = modelId;
    this.device = device;
    this.dtype = dtype;
    this.template = template;
    this.onProgress = onProgress;
    this.keywordsByEmoji = keywordsByEmoji; // Map<emojiGlyph, string[]>
    this._ready = false;
    this._emojiTerms = []; // [{ emoji, idxs: [termIdx,...] }]
    this._terms = [];      // templated term strings
    this._termEmb = [];    // unit embeddings (parallel to _terms)
  }

  async _ensureModels() {
    if (this._ready) return;
    this._textModel = await CLIPTextModelWithProjection.from_pretrained(this.modelId, { dtype: this.dtype, device: this.device });
    this._tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
    this._visionModel = await CLIPVisionModelWithProjection.from_pretrained(this.modelId, {
      dtype: this.dtype, device: this.device, progress_callback: this.onProgress,
    });
    this._processor = await AutoProcessor.from_pretrained(this.modelId);

    // Precompute one embedding per unique term (stored raw; templated at embed time so the
    // returned label is the raw term, e.g. for OWL-ViT queries).
    const termIdx = new Map();
    for (const [emoji, terms] of this.keywordsByEmoji) {
      const idxs = [];
      for (const t of terms) {
        if (!termIdx.has(t)) { termIdx.set(t, this._terms.length); this._terms.push(t); }
        idxs.push(termIdx.get(t));
      }
      if (idxs.length) this._emojiTerms.push({ emoji, idxs });
    }
    if (this._terms.length) {
      const phrased = this._terms.map((t) => this.template.replace('{}', t));
      const ti = this._tokenizer(phrased, { padding: true, truncation: true });
      const { text_embeds } = await this._textModel(ti);
      this._termEmb = text_embeds.tolist().map(unit);
    }
    this._ready = true;
  }

  // rgba: Uint8ClampedArray RGBA of the (original) image. Returns [{emoji,label,score}] sorted desc.
  async classify(rgba, w, h) {
    await this._ensureModels();
    if (!this._emojiTerms.length) return [];
    const iv = await this._embedImage(rgba, w, h);
    const raw = [];
    for (const { emoji, idxs } of this._emojiTerms) {
      let best = -Infinity, bestIdx = idxs[0];
      for (const idx of idxs) { const s = dot(iv, this._termEmb[idx]); if (s > best) { best = s; bestIdx = idx; } }
      raw.push({ emoji, label: this._terms[bestIdx], cos: best });
    }
    const ex = raw.map((r) => Math.exp(LOGIT_SCALE * r.cos));
    const sum = ex.reduce((a, b) => a + b, 0) || 1;
    raw.forEach((r, i) => { r.score = ex[i] / sum; });
    raw.sort((a, b) => b.score - a.score);
    return raw;
  }

  async _embedImage(rgba, w, h) {
    const rgb = new Uint8ClampedArray(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2]; }
    const img = new RawImage(rgb, w, h, 3);
    const vi = await this._processor(img);
    const { image_embeds } = await this._visionModel(vi);
    return unit(image_embeds.tolist()[0]);
  }
}

function unit(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
