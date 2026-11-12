// Byte-pair encoding (BPE) from scratch: train on a tiny corpus, then encode and decode.
// Same algorithm and output as python/bpe.py. Run: node bpe.mjs

// Training text: words and how often they appear. Counts are made up for the demo.
const CORPUS = { read: 6, reads: 3, reading: 4, bread: 2, red: 3 };

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const key = (bytes) => bytes.join(','); // arrays are compared by value through this key

/** Learn merges: repeatedly join the most frequent pair of neighbouring pieces. */
function train(wordCounts, numMerges) {
  // Every word starts as a list of single bytes ("read" -> [[114], [101], [97], [100]]).
  let words = Object.keys(wordCounts).map((w) => [w, [...enc.encode(w)].map((b) => [b])]);
  const merges = [];
  for (let m = 0; m < numMerges; m++) {
    const pairs = new Map(); // key -> { pair, count }, in the order pairs are first seen
    for (const [w, pieces] of words) {
      for (let i = 0; i + 1 < pieces.length; i++) {
        const k = key(pieces[i]) + '|' + key(pieces[i + 1]);
        const entry = pairs.get(k) ?? { pair: [pieces[i], pieces[i + 1]], count: 0 };
        entry.count += wordCounts[w]; // a pair counts once per time its word appears
        pairs.set(k, entry);
      }
    }
    if (pairs.size === 0) break;
    let best = null;
    for (const entry of pairs.values()) if (!best || entry.count > best.count) best = entry; // ties: first seen wins
    merges.push(best.pair);
    const [a, b] = best.pair;
    console.log(`merge ${merges.length}: '${show(a)}' + '${show(b)}' -> '${show([...a, ...b])}'  (seen ${best.count} times)`);
    words = words.map(([w, p]) => [w, mergePair(p, best.pair)]);
  }
  return merges;
}

/** Replace every neighbouring (a, b) in pieces with the single piece a + b. */
function mergePair(pieces, [a, b]) {
  const out = [];
  for (let i = 0; i < pieces.length; i++) {
    if (i + 1 < pieces.length && key(pieces[i]) === key(a) && key(pieces[i + 1]) === key(b)) {
      out.push([...pieces[i], ...pieces[i + 1]]);
      i++;
    } else out.push(pieces[i]);
  }
  return out;
}

/** Split a new word: start from bytes, replay the merges in the order they were learned. */
function encode(word, merges) {
  let pieces = [...enc.encode(word)].map((b) => [b]);
  for (const pair of merges) pieces = mergePair(pieces, pair);
  return pieces;
}

/** Text if the piece is whole characters, else its bytes in hex (part of a character). */
function show(piece) {
  try {
    return dec.decode(new Uint8Array(piece));
  } catch {
    return '<' + piece.map((b) => b.toString(16).padStart(2, '0')).join(' ') + '>';
  }
}

const merges = train(CORPUS, 5);
console.log(`vocabulary size: 256 + ${merges.length} = ${256 + merges.length}`);
for (const word of ['reading', 'bread', 'ready', 'thread', 'पढ़ना']) {
  const pieces = encode(word, merges);
  console.log(`'${word}': ${enc.encode(word).length} bytes -> ${pieces.length} tokens [${pieces.map((p) => `'${show(p)}'`).join(', ')}]`);
  if (dec.decode(new Uint8Array(pieces.flat())) !== word) throw new Error('not lossless'); // decoding gives the word back
}
