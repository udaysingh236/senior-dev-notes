# Tokens, tokenization and context windows: runnable examples

The code behind the snippets on the
[Tokens, Tokenization and Context Windows](https://seniordevnotes.in/ai-engineering/tokens-and-context-windows/) page.
Python 3.11+ and Node 20+, standard library only, nothing to install.

| File | What it shows |
|---|---|
| `python/naive_split.py` / `js/naive-split.mjs` | The two first tries: one ID per word (unknown words are lost) and one ID per character (texts get long) |
| `python/bpe.py` / `js/bpe.mjs` | Byte-pair encoding from scratch: train 5 merges on a toy corpus, encode new words, decode losslessly; a Hindi word stays as 15 single bytes |
| `python/fit_history.py` / `js/fit-history.mjs` | Fitting a chat into a context window: keep the instructions, reserve room for the answer, drop the oldest whole messages |

## Run

```bash
python python/naive_split.py
python python/bpe.py
python python/fit_history.py
node js/naive-split.mjs
node js/bpe.mjs
node js/fit-history.mjs
```

Each Python/JavaScript pair prints identical output.

The real token counts on the page (5 tokens for "I love reading books.", 29 and 9 for its Hindi
translation, and the others) were measured with OpenAI's `tiktoken` 0.14.0 and its
`cl100k_base` and `o200k_base` encodings; they are not part of these examples because tiktoken is
a dependency.

Tested on 2026-11-12 with Python 3.13 and Node 22.22 on Linux.
