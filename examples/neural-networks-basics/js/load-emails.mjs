// Shared loader for emails.json: each email is [links, moneyWords, knownSender, isSpam].
import { readFileSync } from 'node:fs';

export const DATA = JSON.parse(readFileSync(new URL('../emails.json', import.meta.url), 'utf8'));
