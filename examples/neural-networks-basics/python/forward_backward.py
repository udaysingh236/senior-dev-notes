"""The forward pass and one backpropagation step from the page, worked by the computer.

One email: 6 links, 4 money words, sender not in contacts. It is spam (label 1).
Run: python3 forward_backward.py
"""
import math

x = [6, 4, 0]                                   # links, money words, known sender
W = [[0.2, 0.5, -1.0],                          # hidden neuron A
     [-0.3, 0.1, 2.0]]                          # hidden neuron B
bh = [-1.0, 0.5]
V, bo = [1.5, -2.0], -2.0                       # output neuron
y, lr = 1, 0.1


def forward():
    z = [sum(w * xi for w, xi in zip(row, x)) + b for row, b in zip(W, bh)]
    h = [max(0.0, zi) for zi in z]              # ReLU
    score = sum(v * hi for v, hi in zip(V, h)) + bo
    p = 1 / (1 + math.exp(-score))              # sigmoid
    return z, h, score, p, -math.log(p)         # log loss for a spam email


z, h, score, p, loss = forward()
print(f"hidden scores {z[0]:.2f}, {z[1]:.2f} -> after ReLU {h[0]:.2f}, {h[1]:.2f}")
print(f"output score {score:.2f} -> spam chance {p:.3f}, loss {loss:.3f}")

# Backward: start at the output and hand the blame back, layer by layer.
d_out = p - y                                   # sigmoid + log loss: blame = guess - truth
grad_V = [d_out * hj for hj in h]
d_h = [d_out * V[j] if z[j] > 0 else 0.0 for j in range(2)]
grad_W = [[d_h[j] * xi for xi in x] for j in range(2)]
print(f"blame at output {d_out:.3f}; for A's output {d_h[0]:.3f}, for B's {d_h[1]:.3f}")
print(f"gradients for A's weights: [{', '.join(f'{g + 0.0:.3f}' for g in grad_W[0])}]")

# Update: every weight takes a small step against its gradient.
for j in range(2):
    V[j] -= lr * grad_V[j]
    bh[j] -= lr * d_h[j]
    W[j] = [w - lr * g for w, g in zip(W[j], grad_W[j])]
bo -= lr * d_out
print(f"A's new weights: [{', '.join(f'{w:.3f}' for w in W[0])}], output weight from A: {V[0]:.3f}")

z, h, score, p, loss = forward()
print(f"after one step: spam chance {p:.3f}, loss {loss:.3f}")
