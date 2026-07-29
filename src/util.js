// imgoji core utilities: pure helpers shared by the renderer and encoder.
// No canvas, no DOM. Safe in a Worker.

// ---- Structural markers --------------------------------------------------
// The codec BFS body uses ASCII markers; the DSL uses lowercase op letters +
// uppercase hex. This split (lowercase = op, [0-9A-F] = hex, everything else =
// glyph/marker) is what makes a codec string self-delimiting. See FORMAT.md.
export const LEAF_MARKER = '|';       // "don't subdivide" (non-capped leaf)
export const SKIP_MARKER = '-';       // "paint nothing, keep the parent"
export const LEAF_MODE_MARKER = '!';  // starts a run of leaves (see FORMAT.md)

// DSL transform op letters (kept out of a–f so they never read as hex).
export const OP_LETTERS = new Set(['x', 'y', 'r', 's', 'o', 'h']);
const isOp = c => c >= 'a' && c <= 'z';
const isHex = c => (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F');

// ---- Grapheme splitting --------------------------------------------------
// Multi-codepoint emoji (flags, ZWJ sequences) count as ONE position; positional
// decode relies on this.
export function splitGraphemes(s) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.segment);
  }
  return s.match(/\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic})*|\p{Regional_Indicator}{2}|\S/gu) || [];
}

// ---- Run-length encoding -------------------------------------------------
// A run of N>=2 identical graphemes -> GRAPH + uppercase-hex(N); a run of one is
// just the graph. Counts are [0-9A-F]; a DSL op (lowercase + its hex value) is
// passed through verbatim and never read as a count. (See FORMAT.md §Codec.)
export function rleCompress(str) {
  const cps = splitGraphemes(str);
  let out = '';
  for (let i = 0; i < cps.length;) {
    let j = i + 1;
    while (j < cps.length && cps[j] === cps[i]) j++;
    out += cps[i];
    if (j - i >= 2) out += (j - i).toString(16).toUpperCase();
    i = j;
  }
  return out;
}
export function rleExpand(str) {
  const cps = splitGraphemes(str);
  let out = '';
  for (let i = 0; i < cps.length;) {
    const g = cps[i++];
    if (isOp(g)) {                       // DSL op: pass through op + its hex value
      out += g;
      while (i < cps.length && isHex(cps[i])) out += cps[i++];
      continue;
    }
    let num = '';
    while (i < cps.length && isHex(cps[i])) num += cps[i++];
    const n = num ? parseInt(num, 16) : 1;
    out += g.repeat(n);
  }
  return out;
}

// Compressed-string prefix covering the first `frac` of expanded tokens — the inverse view of
// rleExpand's slice. Walks the grammar (DSL ops pass through; <glyph><hexcount> runs expand),
// counts expanded non-space tokens, and re-emits a valid compressed prefix up to round(total×frac),
// truncating a partial run. Matches the prefix cut render.js applies when decoding.
export function encodePrefix(str, frac) {
  if (!str || frac >= 1) return str;
  const cps = splitGraphemes(str);
  let total = 0;
  for (let i = 0; i < cps.length;) {
    const g = cps[i++];
    if (g === ' ') continue;
    if (isOp(g)) { total++; while (i < cps.length && isHex(cps[i])) { total++; i++; } continue; }
    let num = ''; while (i < cps.length && isHex(cps[i])) num += cps[i++];
    total += num ? parseInt(num, 16) : 1;
  }
  const F = Math.max(1, Math.round(total * frac));
  let out = '', count = 0;
  for (let i = 0; i < cps.length && count < F;) {
    const g = cps[i++];
    if (g === ' ') { out += g; continue; }
    if (isOp(g)) { out += g; count++; while (i < cps.length && isHex(cps[i]) && count < F) { out += cps[i++]; count++; } continue; }
    let num = ''; while (i < cps.length && isHex(cps[i])) num += cps[i++];
    const n = num ? parseInt(num, 16) : 1;
    const take = Math.min(n, F - count);
    out += g; if (take >= 2) out += take.toString(16).toUpperCase();
    count += take;
  }
  return out;
}

// ---- DSL detection -------------------------------------------------------
// A cell is EITHER a DSL sprite list (glyph + >=1 op) OR a single full-size
// glyph (+ optional marker). isDSLStart: glyph (not a marker) immediately
// followed by a lowercase op letter.
export function isDSLStart(tokens, idx) {
  const g = tokens[idx];
  if (!g || g === SKIP_MARKER || g === LEAF_MARKER || g === LEAF_MODE_MARKER) return false;
  return idx + 1 < tokens.length && isOp(tokens[idx + 1]);
}

// ---- Color math (sRGB→CIELAB, CIEDE2000) --------------------------------
// Pure. Used by the encoder's matcher / ΔE00 measurement; the renderer does not
// need these.
export function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export function rgbToLab(r, g, b) {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
// CIEDE2000 (ΔE00) between two CIELAB colors.
export function dE00(L1, a1, b1, L2, a2, b2) {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7), G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const D = 180 / Math.PI;
  let h1p = Math.atan2(b1, a1p) * D, h2p = Math.atan2(b2, a2p) * D;
  if (h1p < 0) h1p += 360; if (h2p < 0) h2p += 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp; if (C1p * C2p === 0) dhp = 0; else { const d = h2p - h1p; dhp = Math.abs(d) <= 180 ? d : (d > 180 ? d - 360 : d + 360); }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2 / D);
  const Lbarp = (L1 + L2) / 2, Cbarp = (C1p + C2p) / 2;
  let hbarp; if (C1p * C2p === 0) hbarp = h1p + h2p; else { const sm = h1p + h2p; hbarp = Math.abs(h1p - h2p) <= 180 ? sm / 2 : (sm < 360 ? (sm + 360) / 2 : (sm - 360) / 2); }
  const T = 1 - 0.17 * Math.cos((hbarp - 30) / D) + 0.24 * Math.cos(2 * hbarp / D) + 0.32 * Math.cos((3 * hbarp + 6) / D) - 0.20 * Math.cos((4 * hbarp - 63) / D);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7), RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const SL = 1 + (0.015 * (Lbarp - 50) * (Lbarp - 50)) / Math.sqrt(20 + (Lbarp - 50) * (Lbarp - 50));
  const SC = 1 + 0.045 * Cbarp, SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta / D) * RC;
  const dL = dLp / SL, dC = dCp / SC, dH = dHp / SH;
  return Math.sqrt(dL * dL + dC * dC + dH * dH + RT * dC * dH);
}

// ---- Additional perceptual color spaces (for the matcher-metric A/B) -----
// Each is a self-contained sRGB→space converter, verified against published
// reference values (colour-science / Ottosson / Safdar). Used by the metric
// ensemble judge, NOT by the production matcher (which is CIE76 = CIELAB-Euclidean).

// sRGB (0-255) → CIE XYZ (D65, absolute, normalized 0..1). Not white-relative.
export function srgbToXyz(r, g, b) {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
  return [0.4124564 * R + 0.3575761 * G + 0.1804375 * B,
          0.2126729 * R + 0.7151522 * G + 0.0721750 * B,
          0.0193339 * R + 0.1191920 * G + 0.9503041 * B];
}

// OKLab (Ottosson 2020). sRGB→linear→LMS→cube-root→OKLab.
export function rgbToOklab(r, g, b) {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
  const l = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B;
  const m = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B;
  const s = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
          1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
          0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_];
}

// Jzazbz (Safdar 2017). sRGB→XYZ→LMS→PQ(ST2084, m2 re-optimized)→Izazbz→Jzazbz.
const JZ_B = 1.15, JZ_G = 0.66, JZ_D = -0.56, JZ_D0 = 1.6295499532821566e-11;
const JZ_M1 = 0.1593017578125, JZ_M2 = 1.7 * 2523 / 32;
const JZ_C1 = 0.8359375, JZ_C2 = 18.8515625, JZ_C3 = 18.6875;
const pqEncode = v => { const yp = Math.pow(Math.max(0, v) / 10000, JZ_M1); return Math.pow((JZ_C1 + JZ_C2 * yp) / (JZ_C3 * yp + 1), JZ_M2); };
export function xyzToJzazbz(X, Y, Z) {
  const Xp = JZ_B * X - (JZ_B - 1) * Z;
  const Yp = JZ_G * Y - (JZ_G - 1) * X;
  const L = 0.41478972 * Xp + 0.579999 * Yp + 0.0146480 * Z;
  const M = -0.2015100 * Xp + 1.120649 * Yp + 0.0531008 * Z;
  const S = -0.0166008 * Xp + 0.264800 * Yp + 0.6684799 * Z;
  const Lp = pqEncode(L), Mp = pqEncode(M), Sp = pqEncode(S);
  const Iz = 0.5 * Lp + 0.5 * Mp;
  const az = 3.524000 * Lp - 4.066708 * Mp + 0.542708 * Sp;
  const bz = 0.199076 * Lp + 1.096799 * Mp - 1.295875 * Sp;
  const Jz = ((1 + JZ_D) * Iz) / (1 + JZ_D * Iz) - JZ_D0;
  return [Jz, az, bz];
}
export const rgbToJzazbz = (r, g, b) => xyzToJzazbz(...srgbToXyz(r, g, b));

// CAM16-UCS (Li et al. 2017). sRGB→XYZ(scale 100)→CAM16(J,M,h)→UCS(J',a',b').
// Forward model = CIECAM02 correlates run in the CAT16-sharpened cone space.
const CAT16 = [[0.401288, 0.650173, -0.051461], [-0.250268, 1.204414, 0.045854], [-0.002079, 0.048952, 0.953127]];
const UCS_KL = 1.0, UCS_C1 = 0.007, UCS_C2 = 0.0228;
// Parameterized for verification; rgbToCam16Ucs uses sRGB defaults.
export function xyzToCam16Ucs(X, Y, Z, vc) {
  const La = vc.La, Yb = vc.Yb, F = vc.F, c = vc.c, Nc = vc.Nc;
  const W = vc.XYZw, Yw = W[1], discount = vc.discount;
  const n = Yb / Yw;
  const k = 1 / (5 * La + 1), k4 = k * k * k * k, five = 5 * La;
  const FL = 0.2 * k4 * five + 0.1 * (1 - k4) * (1 - k4) * Math.cbrt(five);
  const Nbb = 0.725 * Math.pow(1 / n, 0.2), Ncb = Nbb, zc = 1.48 + Math.sqrt(n);
  const D = discount ? 1 : Math.max(0, Math.min(1, F * (1 - (1 / 3.6) * Math.exp((-La - 42) / 92))));
  const m16 = v => CAT16[0][0] * v[0] + CAT16[0][1] * v[1] + CAT16[0][2] * v[2];
  const Rw = m16(W), Gw = CAT16[1][0] * W[0] + CAT16[1][1] * W[1] + CAT16[1][2] * W[2], Bw = CAT16[2][0] * W[0] + CAT16[2][1] * W[1] + CAT16[2][2] * W[2];
  const DR = [D * Yw / Rw + 1 - D, D * Yw / Gw + 1 - D, D * Yw / Bw + 1 - D];
  const pa = x => { const fx = Math.pow(FL * Math.abs(x) / 100, 0.42); return 400 * (x < 0 ? -1 : 1) * fx / (27.13 + fx) + 0.1; };
  const Raw_ = pa(DR[0] * Rw), Gaw_ = pa(DR[1] * Gw), Baw_ = pa(DR[2] * Bw);
  const Aw = (2 * Raw_ + Gaw_ + Baw_ / 20 - 0.305) * Nbb;
  const R = m16([X, Y, Z]), G = CAT16[1][0] * X + CAT16[1][1] * Y + CAT16[1][2] * Z, B = CAT16[2][0] * X + CAT16[2][1] * Y + CAT16[2][2] * Z;
  const Ra = pa(DR[0] * R), Ga = pa(DR[1] * G), Ba = pa(DR[2] * B);
  const a = Ra - 12 * Ga / 11 + Ba / 11, b = (Ra + Ga - 2 * Ba) / 9;
  const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  const et = 0.25 * (Math.cos(2 + h * Math.PI / 180) + 3.8);
  const A = (2 * Ra + Ga + Ba / 20 - 0.305) * Nbb;
  const J = 100 * Math.pow(A / Aw, c * zc);
  const t = ((50000 / 13) * Nc * Ncb * et * Math.sqrt(a * a + b * b)) / (Ra + Ga + 21 * Ba / 20);
  const C = Math.pow(t, 0.9) * Math.sqrt(J / 100) * Math.pow(1.64 - Math.pow(0.29, n), 0.73);
  const M = C * Math.pow(FL, 0.25);
  const Jp = (1 + 100 * UCS_C1) * J / (1 + UCS_C1 * J);
  const Mp = (1 / UCS_C2) * Math.log(1 + UCS_C2 * M);
  const hr = h * Math.PI / 180;
  return [Jp, Mp * Math.cos(hr), Mp * Math.sin(hr)];
}
// Default sRGB viewing conditions (Average surround, D65, La=64/π·0.2, Yb=20, adapting D).
const CAM_SRGB = { La: 64 / Math.PI * 0.2, Yb: 20, F: 1.0, c: 0.69, Nc: 1.0, XYZw: [95.047, 100.0, 108.883], discount: false };
export const rgbToCam16Ucs = (r, g, b) => {
  const [X, Y, Z] = srgbToXyz(r, g, b);
  return xyzToCam16Ucs(X * 100, Y * 100, Z * 100, CAM_SRGB);
};

// Mean perceptual distance of a reconstruction vs source, under four independent
// color-space families. ΔE00 (CIEDE2000, CIELAB), OKLab-Euclidean, Jzazbz-
// Euclidean, CAM16-UCS-Euclidean. a = source RGBA, b = recon RGBA.
export function judgeDistances(a, b) {
  let sDE00 = 0, sOk = 0, sJz = 0, sCam = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ar = a[i], ag = a[i + 1], ab = a[i + 2], br = b[i], bg = b[i + 1], bb = b[i + 2];
    const al = rgbToLab(ar, ag, ab), bl = rgbToLab(br, bg, bb);
    sDE00 += dE00(al[0], al[1], al[2], bl[0], bl[1], bl[2]);
    const ao = rgbToOklab(ar, ag, ab), bo = rgbToOklab(br, bg, bb);
    sOk += Math.hypot(ao[0] - bo[0], ao[1] - bo[1], ao[2] - bo[2]);
    const aj = rgbToJzazbz(ar, ag, ab), bj = rgbToJzazbz(br, bg, bb);
    sJz += Math.hypot(aj[0] - bj[0], aj[1] - bj[1], aj[2] - bj[2]);
    const ac = rgbToCam16Ucs(ar, ag, ab), bc = rgbToCam16Ucs(br, bg, bb);
    sCam += Math.hypot(ac[0] - bc[0], ac[1] - bc[1], ac[2] - bc[2]);
    n++;
  }
  n = n || 1;
  return { de00: sDE00 / n, oklab: sOk / n, jz: sJz / n, cam16ucs: sCam / n };
}

// ---- Byte sizes ----------------------------------------------------------
export const encBytes = s => new TextEncoder().encode(s).length;

// deflate-raw size via the browser's CompressionStream (stacks on RLE, so this
// is the real transmissible size). Returns Infinity if unavailable.
export async function deflateRawBytes(str) {
  try {
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter();
    w.write(new TextEncoder().encode(str)); w.close();
    const r = cs.readable.getReader(); let n = 0;
    for (;;) { const { done, value } = await r.read(); if (done) break; n += value.length; }
    return n;
  } catch { return Infinity; }
}
