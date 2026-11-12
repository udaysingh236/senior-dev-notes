// Naive spam filter: rules written by hand. Run: node rules-filter.mjs
import { DATA } from './load-emails.mjs';

function looksLikeSpam(links, moneyWords, knownSender) {
  // Rules a person might write after reading a few spam emails.
  if (knownSender) return false;           // "people I know never send spam"
  return links >= 5 || moneyWords >= 3;    // "lots of links or lots of money talk"
}

const emails = [...DATA.train, ...DATA.validation];
const right = emails.filter(([l, m, k, y]) => looksLikeSpam(l, m, k) === Boolean(y)).length;
console.log(`rules right on ${Math.round((100 * right) / emails.length)}% of ${emails.length} emails`);
for (const [l, m, k, y] of emails) {
  if (looksLikeSpam(l, m, k) !== Boolean(y)) {
    console.log(`  wrong: links=${l} money_words=${m} known_sender=${k} -> really ${y ? 'spam' : 'not spam'}`);
  }
}
