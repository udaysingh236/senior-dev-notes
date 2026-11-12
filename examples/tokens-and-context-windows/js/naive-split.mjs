// Two first tries at splitting text, and why each breaks. Run: node naive-split.mjs

// Try 1: one ID per whole word, from a fixed word list built in advance.
const WORD_IDS = { i: 0, love: 1, reading: 2, books: 3, '.': 4 };
const UNKNOWN = 5; // every word not on the list gets this one ID

const splitWords = (text) =>
  text.toLowerCase().replaceAll('.', ' .').split(/\s+/).filter(Boolean).map((w) => WORD_IDS[w] ?? UNKNOWN);

// Try 2: one ID per character (each character has a standard number). Nothing is ever unknown.
const splitChars = (text) => [...text].map((c) => c.codePointAt(0));

for (const text of ['I love reading books.', 'I love rereading books.', 'मुझे किताबें पढ़ना पसंद है।']) {
  console.log(`'${text}'`);
  console.log(`  words: [${splitWords(text).join(', ')}]`);
  console.log(`  chars: ${splitChars(text).length} pieces`);
}
// 'I love reading books.'
//   words: [0, 1, 2, 3, 4]
//   chars: 21 pieces
// 'I love rereading books.'
//   words: [0, 1, 5, 3, 4]            <- "rereading" is lost: the model sees only "unknown"
//   chars: 23 pieces
// 'मुझे किताबें पढ़ना पसंद है।'
//   words: [5, 5, 5, 5, 5]            <- a whole Hindi sentence becomes five "unknown"s
//   chars: 27 pieces
