"""A small network (3 inputs -> 8 hidden neurons -> 1 output) trained the way real ones are:
scaled inputs, a training set and a separate validation set, and early stopping.

Run: python3 tiny_network.py
"""
import copy
import json
import math
from pathlib import Path

DATA = json.loads((Path(__file__).parent.parent / "emails.json").read_text())
SCALE = [10, 6, 1]   # largest value of each input, so every input lies between 0 and 1
HIDDEN = 8


def lcg(seed: int):
    """Tiny seeded random numbers, identical in the Python and JavaScript versions."""
    while True:
        seed = (seed * 1103515245 + 12345) % 2**31
        yield 2 * seed / 2**31 - 1        # between -1 and 1


rand = lcg(42)
net = {
    "W": [[next(rand) for _ in range(3)] for _ in range(HIDDEN)],  # hidden layer, one row per neuron
    "bh": [0.0] * HIDDEN,
    "V": [next(rand) for _ in range(HIDDEN)],                      # output neuron
    "bo": 0.0,
}


def forward(net, x):
    x = [xi / s for xi, s in zip(x, SCALE)]
    z = [sum(w * xi for w, xi in zip(row, x)) + b for row, b in zip(net["W"], net["bh"])]
    h = [max(0.0, zi) for zi in z]                                  # ReLU
    score = sum(v * hi for v, hi in zip(net["V"], h)) + net["bo"]
    return x, z, h, 1 / (1 + math.exp(-score))                      # sigmoid


def avg_loss(net, rows):
    total = 0.0
    for *x, y in rows:
        p = forward(net, x)[3]
        total += -math.log(max(1e-12, p if y else 1 - p))
    return total / len(rows)


def accuracy(net, rows):
    return sum((forward(net, x)[3] >= 0.5) == bool(y) for *x, y in rows) / len(rows)


def train_one_email(net, x, y, lr):
    xs, z, h, p = forward(net, x)
    d_out = p - y                                                   # blame at the output
    for j in range(HIDDEN):
        d_h = d_out * net["V"][j] if z[j] > 0 else 0.0              # back through ReLU
        net["V"][j] -= lr * d_out * h[j]
        for i in range(3):
            net["W"][j][i] -= lr * d_h * xs[i]
        net["bh"][j] -= lr * d_h
    net["bo"] -= lr * d_out


lr, patience = 0.2, 300
best, best_epoch, best_net = float("inf"), 0, copy.deepcopy(net)
for epoch in range(1, 20001):
    for *x, y in DATA["train"]:
        train_one_email(net, x, y, lr)
    val = avg_loss(net, DATA["validation"])
    if val < best:
        best, best_epoch, best_net = val, epoch, copy.deepcopy(net)  # keep the best weights
    elif epoch - best_epoch >= patience:
        break                                                        # early stopping
    if epoch in (1, 10, 100, 337, 600):
        print(f"epoch {epoch:4}: training loss {avg_loss(net, DATA['train']):.3f}, "
              f"validation loss {val:.3f}")

print(f"stopped at epoch {epoch}; kept the weights from epoch {best_epoch} "
      f"(validation loss {best:.3f})")
print(f"right on {accuracy(best_net, DATA['train']):.0%} of training emails, "
      f"{accuracy(best_net, DATA['validation']):.0%} of validation emails")
