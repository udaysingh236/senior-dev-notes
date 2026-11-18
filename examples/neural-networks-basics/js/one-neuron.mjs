// One neuron that learns its weights from labelled emails, with gradient descent.
// Run: node one-neuron.mjs
import { DATA } from './load-emails.mjs';

const sigmoid = (z) => 1 / (1 + Math.exp(-z)); // squashes any score into 0..1

function predict(w, b, x) {
  const score = w.reduce((sum, wi, i) => sum + wi * x[i], 0) + b; // weighted sum plus bias
  return sigmoid(score);                                          // chance of spam
}

const accuracy = (w, b, rows) =>
  rows.filter((r) => (predict(w, b, r.slice(0, 3)) >= 0.5) === Boolean(r[3])).length / rows.length;

let w = [0, 0, 0], b = 0; // start knowing nothing: every email scores 50%
const learningRate = 0.05;
for (let epoch = 1; epoch <= 2000; epoch++) {
  const gradW = [0, 0, 0];
  let gradB = 0, loss = 0;
  for (const [l, m, k, y] of DATA.train) {
    const x = [l, m, k];
    const p = predict(w, b, x);
    loss += -Math.log(y ? p : 1 - p); // log loss: big when confidently wrong
    const error = p - y;               // how far off, and in which direction
    for (let i = 0; i < 3; i++) gradW[i] += error * x[i]; // this weight's share of the blame
    gradB += error;
  }
  const n = DATA.train.length;
  w = w.map((wi, i) => wi - (learningRate * gradW[i]) / n); // step downhill
  b -= (learningRate * gradB) / n;
  if ([1, 10, 100, 2000].includes(epoch)) {
    console.log(`epoch ${String(epoch).padStart(4)}: average loss ${(loss / n).toFixed(3)}`);
  }
}

console.log(`weights: [${w.map((v) => v.toFixed(2)).join(', ')}] bias: ${b.toFixed(2)}`);
const pct = (v) => `${Math.round(v * 100)}%`;
console.log(`right on ${pct(accuracy(w, b, DATA.train))} of training emails, ` +
  `${pct(accuracy(w, b, DATA.validation))} of validation emails`);
