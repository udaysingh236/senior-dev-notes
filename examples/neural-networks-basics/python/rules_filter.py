"""Naive spam filter: rules written by hand.

Each email is [links, money_words, known_sender, is_spam].
Run: python3 rules_filter.py
"""
import json
from pathlib import Path

DATA = json.loads((Path(__file__).parent.parent / "emails.json").read_text())


def looks_like_spam(links: int, money_words: int, known_sender: int) -> bool:
    # Rules a person might write after reading a few spam emails.
    if known_sender:
        return False                      # "people I know never send spam"
    return links >= 5 or money_words >= 3  # "lots of links or lots of money talk"


def accuracy(rows: list[list[int]]) -> float:
    right = sum(looks_like_spam(l, m, k) == bool(y) for l, m, k, y in rows)
    return right / len(rows)


emails = DATA["train"] + DATA["validation"]
print(f"rules right on {accuracy(emails):.0%} of {len(emails)} emails")
for l, m, k, y in emails:
    if looks_like_spam(l, m, k) != bool(y):
        print(f"  wrong: links={l} money_words={m} known_sender={k} -> really {'spam' if y else 'not spam'}")
