// Byte-level BPE on a small English + Hindi word list, for the BPE sim. Pure functions, no DOM.
// The word counts are illustrative, not measured: roughly "common words are common".

export type Piece = number[]; // bytes

const EN: Record<string, number> = {
  the: 60, of: 40, and: 40, to: 38, a: 35, in: 30, is: 28, I: 25, you: 20, it: 20, that: 18, for: 15,
  was: 15, with: 12, this: 12, have: 12, not: 12, are: 12, like: 10, my: 10, we: 10, they: 10, one: 10,
  love: 8, read: 8, book: 8, good: 8, very: 8, reading: 6, books: 6, time: 6, people: 6, day: 6, long: 5, train: 3,
};
const HI: Record<string, number> = {
  'है': 50, 'के': 45, 'में': 40, 'की': 40, 'और': 35, 'का': 35, 'को': 30, 'से': 30, 'यह': 25, 'मैं': 25,
  'नहीं': 20, 'हैं': 20, 'पर': 18, 'भी': 15, 'मुझे': 12, 'बहुत': 12, 'क्या': 12, 'था': 12, 'पसंद': 10,
  'किताब': 10, 'लिए': 10, 'आप': 10, 'हम': 10, 'किताबें': 8, 'पढ़ना': 8, 'अच्छा': 8, 'करना': 8, 'कोई': 8,
  'लोग': 8, 'पढ़': 6, 'साथ': 6, 'घर': 6, 'समय': 6, 'दिन': 6,
};

export const EN_SENTENCE = ['I', ' love', ' reading', ' books'];
export const HI_SENTENCE = ['मुझे', ' किताबें', ' पढ़ना', ' पसंद', ' है'];

const enc = new TextEncoder();
export const bytesOf = (s: string): number[] => [...enc.encode(s)];

export interface Merge {
  a: Piece;
  b: Piece;
  lang: 'en' | 'hi';
}

/** Corpus words with weights. Words appear with a leading space, plus the two sentence starters bare. */
function corpus(hindiShare: number): { bytes: number[]; weight: number; lang: 'en' | 'hi' }[] {
  const enTotal = Object.values(EN).reduce((s, v) => s + v, 0);
  const hiTotal = Object.values(HI).reduce((s, v) => s + v, 0);
  const share = Math.min(0.95, Math.max(0, hindiShare));
  const hiScale = share === 0 ? 0 : (share / (1 - share)) * (enTotal / hiTotal);
  const out: { bytes: number[]; weight: number; lang: 'en' | 'hi' }[] = [];
  for (const [w, c] of Object.entries(EN)) out.push({ bytes: bytesOf(' ' + w), weight: c, lang: 'en' });
  out.push({ bytes: bytesOf('I'), weight: 10, lang: 'en' });
  if (hiScale > 0) {
    for (const [w, c] of Object.entries(HI)) out.push({ bytes: bytesOf(' ' + w), weight: c * hiScale, lang: 'hi' });
    out.push({ bytes: bytesOf('मुझे'), weight: 5 * hiScale, lang: 'hi' });
  }
  return out;
}

const k = (p: Piece) => p.join(',');

export function mergePair(pieces: Piece[], a: Piece, b: Piece): Piece[] {
  const ka = k(a);
  const kb = k(b);
  const out: Piece[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (i + 1 < pieces.length && k(pieces[i]) === ka && k(pieces[i + 1]) === kb) {
      out.push([...pieces[i], ...pieces[i + 1]]);
      i++;
    } else out.push(pieces[i]);
  }
  return out;
}

/** Learn up to `max` merges. Each merge records which language contributed most to its count. */
export function train(hindiShare: number, max: number): Merge[] {
  let words = corpus(hindiShare).map((w) => ({ ...w, pieces: w.bytes.map((b) => [b]) as Piece[] }));
  const merges: Merge[] = [];
  for (let m = 0; m < max; m++) {
    const pairs = new Map<string, { a: Piece; b: Piece; count: number; en: number }>();
    for (const w of words) {
      for (let i = 0; i + 1 < w.pieces.length; i++) {
        const key = k(w.pieces[i]) + '|' + k(w.pieces[i + 1]);
        const e = pairs.get(key) ?? { a: w.pieces[i], b: w.pieces[i + 1], count: 0, en: 0 };
        e.count += w.weight;
        if (w.lang === 'en') e.en += w.weight;
        pairs.set(key, e);
      }
    }
    let best: { a: Piece; b: Piece; count: number; en: number } | null = null;
    for (const e of pairs.values()) if (!best || e.count > best.count + 1e-9) best = e;
    if (!best) break;
    merges.push({ a: best.a, b: best.b, lang: best.en * 2 >= best.count ? 'en' : 'hi' });
    const { a, b } = best;
    words = words.map((w) => ({ ...w, pieces: mergePair(w.pieces, a, b) }));
  }
  return merges;
}

/** Encode one word with the first `n` merges. */
export function encodeWord(word: string, merges: Merge[], n: number): Piece[] {
  let pieces: Piece[] = bytesOf(word).map((b) => [b]);
  for (let i = 0; i < Math.min(n, merges.length) && pieces.length > 1; i++) pieces = mergePair(pieces, merges[i].a, merges[i].b);
  return pieces;
}

const dec = new TextDecoder('utf-8', { fatal: true });
/** Text if the piece is whole characters, otherwise null (a fragment of a character). */
export function pieceText(p: Piece): string | null {
  try {
    return dec.decode(new Uint8Array(p)).replace(/ /g, '␣');
  } catch {
    return null;
  }
}
