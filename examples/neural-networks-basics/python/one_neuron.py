"""One neuron that learns its weights from labelled emails, with gradient descent.

Each email is [links, money_words, known_sender, is_spam].
Run: python3 one_neuron.py
"""
import json
import math
from pathlib import Path

DATA = json.loads((Path(__file__).parent.parent / "emails.json").read_text())


def sigmoid(z: float) -> float:
    return 1 / (1 + math.exp(-z))  # squashes any score into 0..1


def predict(w: list[float], b: float, x: list[int]) -> float:
    score = sum(wi * xi for wi, xi in zip(w, x)) + b  # weighted sum plus bias
    return sigmoid(score)                              # chance of spam


def accuracy(w, b, rows) -> float:
    return sum((predict(w, b, r[:3]) >= 0.5) == bool(r[3]) for r in rows) / len(rows)


w, b = [0.0, 0.0, 0.0], 0.0   # start knowing nothing: every email scores 50%
learning_rate = 0.05
for epoch in range(1, 2001):
    grad_w, grad_b, loss = [0.0, 0.0, 0.0], 0.0, 0.0
    for *x, y in DATA["train"]:
        p = predict(w, b, x)
        loss += -math.log(p if y else 1 - p)  # log loss: big when confidently wrong
        error = p - y                          # how far off, and in which direction
        for i in range(3):
            grad_w[i] += error * x[i]          # this weight's share of the blame
        grad_b += error
    n = len(DATA["train"])
    w = [wi - learning_rate * g / n for wi, g in zip(w, grad_w)]  # step downhill
    b -= learning_rate * grad_b / n
    if epoch in (1, 10, 100, 2000):
        print(f"epoch {epoch:4}: average loss {loss / n:.3f}")

print(f"weights: [{', '.join(f'{v:.2f}' for v in w)}] bias: {b:.2f}")
print(f"right on {accuracy(w, b, DATA['train']):.0%} of training emails, "
      f"{accuracy(w, b, DATA['validation']):.0%} of validation emails")
