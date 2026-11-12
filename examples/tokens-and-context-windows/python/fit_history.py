"""Fit a chat into a context window: keep the instructions, reserve room for the answer,
drop the oldest whole messages. Run: python fit_history.py"""
import math
from typing import Callable


def estimate_tokens(text: str) -> int:
    """Rough count: about 4 bytes of UTF-8 per token. Use the provider's counter when it matters."""
    return math.ceil(len(text.encode("utf-8")) / 4)


def fit_history(system: str, messages: list[dict], window: int, reserve_output: int,
                count: Callable[[str], int] = estimate_tokens) -> tuple[list[dict], int]:
    """Return (the newest messages that fit, tokens used by system + kept messages)."""
    budget = window - reserve_output - count(system)
    newest = count(messages[-1]["text"])
    if newest > budget:
        # Never cut the user's new message silently: tell the caller.
        raise ValueError(f"new message needs {newest} tokens, only {budget} available")
    kept, used = [], 0
    for msg in reversed(messages):           # walk from newest to oldest
        cost = count(msg["text"])
        if used + cost > budget:
            break                             # this message and everything older is dropped
        kept.append(msg)
        used += cost
    kept.reverse()
    while kept and kept[0]["role"] != "user":  # a history should start with a question
        used -= count(kept[0]["text"])
        kept.pop(0)
    return kept, count(system) + used


if __name__ == "__main__":
    # A toy counter (one word = one token) keeps the numbers round. Real code passes the
    # provider's tokenizer or count-tokens API instead.
    words = lambda text: len(text.split())
    system = "rule " * 500                        # instructions: 500 tokens
    chat = []
    for turn in range(1, 21):                     # 20 finished exchanges of 200 + 200 tokens
        chat.append({"role": "user", "text": f"q{turn} " * 200})
        chat.append({"role": "assistant", "text": f"a{turn} " * 200})
    chat.append({"role": "user", "text": "q21 " * 200})  # the new question

    kept, used = fit_history(system, chat, window=8_000, reserve_output=1_000, count=words)
    print(f"messages in chat: {len(chat)}, kept: {len(kept)}, dropped: {len(chat) - len(kept)}")
    print(f"oldest kept message starts with: {kept[0]['text'].split()[0]}")
    print(f"tokens sent: {used}, room left for the answer: {8_000 - used}")
    print(f"estimate for 'I love reading books.': {estimate_tokens('I love reading books.')}")
    print(f"estimate for the Hindi sentence: {estimate_tokens('मुझे किताबें पढ़ना पसंद है।')}")
