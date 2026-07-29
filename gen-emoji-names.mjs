// Generate assets/emoji-names.js: the iamcal short_name for each codepoint in
// assets/emoji-list.js (window.IMGOJI_EMOJI), with underscores replaced by spaces,
// in the same order. Misses (e.g. brand-new emoji not yet in iamcal) -> "" so the
// classifier filters them out. Re-run any time emoji-list.js changes.
import fs from 'fs';
import path from 'path';

const root = path.resolve('.');
const listSrc = fs.readFileSync(path.join(root, 'assets/emoji-list.js'), 'utf8');
const cps = listSrc.match(/=\[([^\]]+)\]/)[1].split(',').map((x) => Number(x.trim()));
console.log('palette codepoints:', cps.length);

const url = 'https://cdn.jsdelivr.net/gh/iamcal/emoji-data@master/emoji.json';
const data = await fetch(url).then((r) => r.json());
// Map the base codepoint (first segment of unified) -> short_name, preferring the
// simplest form (bare hex over HEX-FE0F over longer ZWJ sequences) so our bare
// codepoints match emoji iamcal stores with a FE0F variation selector.
const map = new Map();
for (const e of data) {
  if (!e.unified || !e.short_name) continue;
  const segs = e.unified.split('-');
  const base = segs[0].toUpperCase();
  const prio = segs.length; // 1 = bare, 2 = +FE0F/pair, ...
  const prev = map.get(base);
  if (!prev || prio < prev.prio) map.set(base, { sn: e.short_name, prio });
}
console.log('iamcal base-codepoint entries:', map.size);

// Manual overrides for codepoints whose iamcal short_name misleads the zero-shot
// classifier. Keyed by uppercase hex. Edit THIS map, not the generated files.
const OVERRIDE = {
  '1F453': 'glasses',            // 👓 "eyeglasses"  -> plain "glasses" (canonical eyewear term)
  '1F942': 'champagne clinking', // 🥂 "clinking glasses" -> avoid the word "glasses" entirely
};

// Prohibition signs (red circle + slash) excluded from classification: near-identical glyphs whose
// labels leak via the object term ("no bicycles" matches on "bicycles", etc.), adding only noise.
// Blanked to "" → empty keyword → skipped by classify.html & semantic.js. (They remain in the color
// palette; removing them there too is a separate change.)
const EXCLUDE = new Set(['1F4F5','1F6AB','1F6AD','1F6AF','1F6B1','1F6B3','1F6B7']);
// 📵 no mobile phones  🚫 no entry  🚭 no smoking  🚯 do not litter  🚱 non-potable water  🚳 no bicycles  🚷 no pedestrians

// Resolve the display name for a codepoint: excluded → null, else override, else iamcal short_name.
const nameOf = (cp) => {
  const hex = cp.toString(16).toUpperCase();
  if (EXCLUDE.has(hex)) return null;
  if (OVERRIDE[hex]) return OVERRIDE[hex];
  const m = map.get(hex);
  return m ? m.sn.replace(/_/g, ' ') : null;
};

const names = [];
let hit = 0;
const misses = [];
for (const cp of cps) {
  const name = nameOf(cp);
  if (name != null) { names.push(name); hit++; }
  else { names.push(''); misses.push('U+' + cp.toString(16).toUpperCase()); }
}

// per-emoji candidate terms: just the full name. We deliberately do NOT split compound
// names into bare head nouns — that was net-harmful. Of ~1271 bare terms it emitted,
// ~212 collided with another emoji's full name (🚳 "bicycles" vs 🚲 "bicycle", 🍏 "apple"
// vs 🍎, 🌾 "rice" vs 🍚, …) and ~224 were stop-word noise ("no", "and", …). The
// max-over-terms classifier (src/semantic.js) then let the wrong emoji win. CLIP matches
// full phrases fine, so the head nouns were redundant at best. Add curated synonyms to
// OVERRIDE-ish per-emoji logic here if a specific name turns out weak for CLIP.
const kw = cps.map((cp) => {
  const name = nameOf(cp);
  return name ? [name] : [];
});

const out =
  '// Auto-generated from assets/emoji-list.js codepoints + iamcal/emoji-data short_names.\n' +
  '// Parallel to window.IMGOJI_EMOJI (same order). Underscores replaced with spaces.\n' +
  '// Empty string = codepoint not present in iamcal (skip). Regenerate: node gen-emoji-names.mjs\n' +
  'window.IMGOJI_NAMES=[' + names.map((n) => JSON.stringify(n)).join(',') + '];\n';
fs.writeFileSync(path.join(root, 'assets/emoji-names.js'), out);

console.log(`matched: ${hit}/${cps.length} (${(100 * hit / cps.length).toFixed(1)}%)`);
if (misses.length) console.log('misses (' + misses.length + '):', misses.slice(0, 30).join(' '), misses.length > 30 ? '...' : '');
console.log('sample:', names.filter(Boolean).slice(0, 12).join(' | '));

const totalTerms = kw.reduce((a, k) => a + k.length, 0);
const kwOut =
  '// Auto-generated: per-emoji candidate terms (name + iamcal keywords), parallel to window.IMGOJI_EMOJI.\n' +
  '// Each entry is a JSON array of phrases; the classifier takes the max CLIP score over them.\n' +
  '// Regenerate: node gen-emoji-names.mjs\n' +
  'window.IMGOJI_KW=[' + kw.map((k) => '[' + k.map((t) => JSON.stringify(t)).join(',') + ']').join(',') + '];\n';
fs.writeFileSync(path.join(root, 'assets/emoji-keywords.js'), kwOut);
console.log(`keywords: ${kw.filter((k) => k.length).length}/${kw.length} emoji, ${totalTerms} terms (avg ${(totalTerms / kw.length).toFixed(1)})`);
console.log('kw sample:', kw.filter((k) => k.length > 1).slice(0, 6).map((k) => k.join(', ')).join('  |  '));
