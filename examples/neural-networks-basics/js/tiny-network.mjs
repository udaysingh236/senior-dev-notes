// A small network (3 inputs -> 8 hidden neurons -> 1 output) trained the way real ones are:
// scaled inputs, a training set and a separate validation set, and early stopping.
// Run: node tiny-network.mjs
import { DATA } from './load-emails.mjs';

const SCALE = [10, 6, 1]; // largest value of each input, so every input lies between 0 and 1
const HIDDEN = 8;

function* lcg(seed) {
  // Tiny seeded random numbers, identical in the Python and JavaScript versions.
  while (true) {
    seed = Number((BigInt(seed) * 1103515245n + 12345n) % 2147483648n); // BigInt: the product is too big for a float
    yield (2 * seed) / 2 ** 31 - 1;       // between -1 and 1
  }
}

const rand = lcg(42);
const nextRand = () => rand.next().value;
const net = {
  W: Array.from({ length: HIDDEN }, () => [nextRand(), nextRand(), nextRand()]), // hidden layer
  bh: Array(HIDDEN).fill(0),
  V: Array.from({ length: HIDDEN }, nextRand),                                  // output neuron
  bo: 0,
};

function forward(net, raw) {
  const x = raw.map((xi, i) => xi / SCALE[i]);
  const z = net.W.map((row, j) => row.reduce((s, w, i) => s + w * x[i], 0) + net.bh[j]);
  const h = z.map((zj) => Math.max(0, zj));                                     // ReLU
  const score = net.V.reduce((s, v, j) => s + v * h[j], 0) + net.bo;
  return { x, z, h, p: 1 / (1 + Math.exp(-score)) };                           // sigmoid
}

const avgLoss = (net, rows) =>
  rows.reduce((s, [l, m, k, y]) => {
    const p = forward(net, [l, m, k]).p;
    return s - Math.log(Math.max(1e-12, y ? p : 1 - p));
  }, 0) / rows.length;

const accuracy = (net, rows) =>
  rows.filter(([l, m, k, y]) => (forward(net, [l, m, k]).p >= 0.5) === Boolean(y)).length / rows.length;

function trainOneEmail(net, raw, y, lr) {
  const { x, z, h, p } = forward(net, raw);
  const dOut = p - y;                                        // blame at the output
  for (let j = 0; j < HIDDEN; j++) {
    const dH = z[j] > 0 ? dOut * net.V[j] : 0;               // back through ReLU
    net.V[j] -= lr * dOut * h[j];
    for (let i = 0; i < 3; i++) net.W[j][i] -= lr * dH * x[i];
    net.bh[j] -= lr * dH;
  }
  net.bo -= lr * dOut;
}

const lr = 0.2, patience = 300;
let best = Infinity, bestEpoch = 0, bestNet = structuredClone(net), epoch;
for (epoch = 1; epoch <= 20000; epoch++) {
  for (const [l, m, k, y] of DATA.train) trainOneEmail(net, [l, m, k], y, lr);
  const val = avgLoss(net, DATA.validation);
  if (val < best) {
    [best, bestEpoch, bestNet] = [val, epoch, structuredClone(net)]; // keep the best weights
  } else if (epoch - bestEpoch >= patience) {
    break;                                                           // early stopping
  }
  if ([1, 10, 100, 337, 600].includes(epoch)) {
    console.log(`epoch ${String(epoch).padStart(4)}: training loss ${avgLoss(net, DATA.train).toFixed(3)}, ` +
      `validation loss ${val.toFixed(3)}`);
  }
}

console.log(`stopped at epoch ${epoch}; kept the weights from epoch ${bestEpoch} (validation loss ${best.toFixed(3)})`);
const pct = (v) => `${Math.round(v * 100)}%`;
console.log(`right on ${pct(accuracy(bestNet, DATA.train))} of training emails, ` +
  `${pct(accuracy(bestNet, DATA.validation))} of validation emails`);
