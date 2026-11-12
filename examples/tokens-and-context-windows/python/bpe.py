"""Byte-pair encoding (BPE) from scratch: train on a tiny corpus, then encode and decode.

Real tokenizers (tiktoken, Llama 3, Claude) work the same way at heart, with three differences:
they train on terabytes of text, they learn 100,000 to 200,000+ merges, and they first split text
into words with a regular expression. Run: python bpe.py
"""
from collections import Counter

# Training text: words and how often they appear. Counts are made up for the demo.
CORPUS = {"read": 6, "reads": 3, "reading": 4, "bread": 2, "red": 3}


def train(word_counts: dict[str, int], num_merges: int) -> list[tuple[bytes, bytes]]:
    """Learn merges: repeatedly join the most frequent pair of neighbouring pieces."""
    # Every word starts as a list of single bytes ("read" -> [b"r", b"e", b"a", b"d"]).
    words = {w: [bytes([b]) for b in w.encode("utf-8")] for w in word_counts}
    merges: list[tuple[bytes, bytes]] = []
    for _ in range(num_merges):
        pairs: Counter[tuple[bytes, bytes]] = Counter()
        for w, pieces in words.items():
            for a, b in zip(pieces, pieces[1:]):
                pairs[(a, b)] += word_counts[w]  # a pair counts once per time its word appears
        if not pairs:
            break
        best = max(pairs, key=pairs.get)  # ties: the pair seen first wins
        merges.append(best)
        print(f"merge {len(merges)}: {best[0].decode()!r} + {best[1].decode()!r}"
              f" -> {(best[0] + best[1]).decode()!r}  (seen {pairs[best]} times)")
        words = {w: merge_pair(p, best) for w, p in words.items()}
    return merges


def merge_pair(pieces: list[bytes], pair: tuple[bytes, bytes]) -> list[bytes]:
    """Replace every neighbouring (a, b) in pieces with the single piece a + b."""
    out, i = [], 0
    while i < len(pieces):
        if i + 1 < len(pieces) and (pieces[i], pieces[i + 1]) == pair:
            out.append(pieces[i] + pieces[i + 1])
            i += 2
        else:
            out.append(pieces[i])
            i += 1
    return out


def encode(word: str, merges: list[tuple[bytes, bytes]]) -> list[bytes]:
    """Split a new word: start from bytes, replay the merges in the order they were learned."""
    pieces = [bytes([b]) for b in word.encode("utf-8")]
    for pair in merges:
        pieces = merge_pair(pieces, pair)
    return pieces


def show(piece: bytes) -> str:
    """Text if the piece is whole characters, else its bytes in hex (part of a character)."""
    try:
        return piece.decode("utf-8")
    except UnicodeDecodeError:
        return "<" + piece.hex(" ") + ">"


if __name__ == "__main__":
    merges = train(CORPUS, num_merges=5)
    # Vocabulary = 256 single bytes + one new entry per merge.
    print(f"vocabulary size: 256 + {len(merges)} = {256 + len(merges)}")
    for word in ["reading", "bread", "ready", "thread", "पढ़ना"]:
        pieces = encode(word, merges)
        shown = [show(p) for p in pieces]
        print(f"{word!r}: {len(word.encode('utf-8'))} bytes -> {len(pieces)} tokens {shown}")
        assert b"".join(pieces).decode("utf-8") == word  # lossless: decoding gives the word back
