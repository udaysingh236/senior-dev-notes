// The forward pass and one backpropagation step from the page, worked by the computer.
// One email: 6 links, 4 money words, sender not in contacts. It is spam (label 1).
// Run: node forward-backward.mjs
const x = [6, 4, 0];                       // links, money words, known sender
const W = [[0.2, 0.5, -1.0],               // hidden neuron A
           [-0.3, 0.1, 2.0]];              // hidden neuron B
const bh = [-1.0, 0.5];
const V = [1.5, -2.0];                     // output neuron
let bo = -2.0;
const y = 1, lr = 0.1;

function forward() {
  const z = W.map((row, j) => row.reduce((s, w, i) => s + w * x[i], 0) + bh[j]);
  const h = z.map((zj) => Math.max(0, zj));                  // ReLU
  const score = V.reduce((s, v, j) => s + v * h[j], 0) + bo;
  const p = 1 / (1 + Math.exp(-score));                      // sigmoid
  return { z, h, score, p, loss: -Math.log(p) };             // log loss for a spam email
}

let { z, h, score, p, loss } = forward();
console.log(`hidden scores ${z[0].toFixed(2)}, ${z[1].toFixed(2)} -> after ReLU ${h[0].toFixed(2)}, ${h[1].toFixed(2)}`);
console.log(`output score ${score.toFixed(2)} -> spam chance ${p.toFixed(3)}, loss ${loss.toFixed(3)}`);

// Backward: start at the output and hand the blame back, layer by layer.
const dOut = p - y;                                          // sigmoid + log loss: blame = guess - truth
const gradV = h.map((hj) => dOut * hj);
const dH = z.map((zj, j) => (zj > 0 ? dOut * V[j] : 0));
const gradW = dH.map((d) => x.map((xi) => d * xi));
console.log(`blame at output ${dOut.toFixed(3)}; for A's output ${dH[0].toFixed(3)}, for B's ${Math.abs(dH[1]).toFixed(3)}`);
console.log(`gradients for A's weights: [${gradW[0].map((g) => g.toFixed(3)).join(', ')}]`);

// Update: every weight takes a small step against its gradient.
for (let j = 0; j < 2; j++) {
  V[j] -= lr * gradV[j];
  bh[j] -= lr * dH[j];
  W[j] = W[j].map((w, i) => w - lr * gradW[j][i]);
}
bo -= lr * dOut;
console.log(`A's new weights: [${W[0].map((w) => w.toFixed(3)).join(', ')}], output weight from A: ${V[0].toFixed(3)}`);

({ p, loss } = forward());
console.log(`after one step: spam chance ${p.toFixed(3)}, loss ${loss.toFixed(3)}`);
