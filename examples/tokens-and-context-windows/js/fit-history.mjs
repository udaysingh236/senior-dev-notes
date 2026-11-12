// Fit a chat into a context window: keep the instructions, reserve room for the answer,
// drop the oldest whole messages. Same logic and output as python/fit_history.py.
// Run: node fit-history.mjs

/** Rough count: about 4 bytes of UTF-8 per token. Use the provider's counter when it matters. */
export const estimateTokens = (text) => Math.ceil(new TextEncoder().encode(text).length / 4);

/** Returns { kept: the newest messages that fit, used: tokens for system + kept messages }. */
export function fitHistory(system, messages, window, reserveOutput, count = estimateTokens) {
  const budget = window - reserveOutput - count(system);
  const newest = count(messages.at(-1).text);
  if (newest > budget) {
    // Never cut the user's new message silently: tell the caller.
    throw new Error(`new message needs ${newest} tokens, only ${budget} available`);
  }
  const kept = [];
  let used = 0;
  for (const msg of [...messages].reverse()) { // walk from newest to oldest
    const cost = count(msg.text);
    if (used + cost > budget) break;            // this message and everything older is dropped
    kept.unshift(msg);
    used += cost;
  }
  while (kept.length && kept[0].role !== 'user') used -= count(kept.shift().text); // start with a question
  return { kept, used: count(system) + used };
}

// A toy counter (one word = one token) keeps the numbers round. Real code passes the
// provider's tokenizer or count-tokens API instead.
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const system = 'rule '.repeat(500);              // instructions: 500 tokens
const chat = [];
for (let turn = 1; turn <= 20; turn++) {         // 20 finished exchanges of 200 + 200 tokens
  chat.push({ role: 'user', text: `q${turn} `.repeat(200) });
  chat.push({ role: 'assistant', text: `a${turn} `.repeat(200) });
}
chat.push({ role: 'user', text: 'q21 '.repeat(200) }); // the new question

const { kept, used } = fitHistory(system, chat, 8_000, 1_000, words);
console.log(`messages in chat: ${chat.length}, kept: ${kept.length}, dropped: ${chat.length - kept.length}`);
console.log(`oldest kept message starts with: ${kept[0].text.split(' ')[0]}`);
console.log(`tokens sent: ${used}, room left for the answer: ${8_000 - used}`);
console.log(`estimate for 'I love reading books.': ${estimateTokens('I love reading books.')}`);
console.log(`estimate for the Hindi sentence: ${estimateTokens('मुझे किताबें पढ़ना पसंद है।')}`);
