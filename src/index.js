// imgoji — full entry (renderer + viewer + encoder). For a display-only bundle
// with zero encoder code, import `imgoji/render` instead.
export { Encoder } from './encode.js';
export { default as emojiList } from '../assets/emoji-list.mjs';
export { Renderer, renderString } from './render.js';
export { GlyphCache, renderEmojiAt, TINT_ANCHORS, ANCHOR_EMOJI, EMOJI_FONT } from './glyph.js';
export {
  splitGraphemes, rleCompress, rleExpand, isDSLStart, encodePrefix,
  rgbToLab, dE00, encBytes, deflateRawBytes, deflateRaw, inflateRaw, b64urlEncode, b64urlDecode,
  LEAF_MARKER, SKIP_MARKER, LEAF_MODE_MARKER, OP_LETTERS,
} from './util.js';
export { ImgojiViewer, MAX_RES } from './viewer.js';
