"""Two first tries at splitting text, and why each breaks. Run: python naive_split.py"""

# Try 1: one ID per whole word, from a fixed word list built in advance.
WORD_IDS = {"i": 0, "love": 1, "reading": 2, "books": 3, ".": 4}
UNKNOWN = 5  # every word not on the list gets this one ID


def split_words(text: str) -> list[int]:
    words = text.lower().replace(".", " .").split()
    return [WORD_IDS.get(w, UNKNOWN) for w in words]


# Try 2: one ID per character (each character has a standard number). Nothing is ever unknown.
def split_chars(text: str) -> list[int]:
    return [ord(c) for c in text]


for text in ["I love reading books.", "I love rereading books.", "मुझे किताबें पढ़ना पसंद है।"]:
    print(f"{text!r}")
    print(f"  words: {split_words(text)}")
    print(f"  chars: {len(split_chars(text))} pieces")
# 'I love reading books.'
#   words: [0, 1, 2, 3, 4]
#   chars: 21 pieces
# 'I love rereading books.'
#   words: [0, 1, 5, 3, 4]            <- "rereading" is lost: the model sees only "unknown"
#   chars: 23 pieces
# 'मुझे किताबें पढ़ना पसंद है।'
#   words: [5, 5, 5, 5, 5]            <- a whole Hindi sentence becomes five "unknown"s
#   chars: 27 pieces
