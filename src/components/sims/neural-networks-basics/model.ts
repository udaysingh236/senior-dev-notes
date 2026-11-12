// Neural network training sim: a small network learns to tell spam from real emails, drawn as
// points by number of links (across) and money words (up). The shading is the network's spam
// chance at every spot; the chart on the right is training and validation loss per epoch.
// The reader changes the hidden neurons, the learning rate and the number of training emails.
import { createRng } from '../../sim/rng';
import { layer, svg, text, token, clear } from '../../sim/svg';
import type { SimFactory } from '../../sim/types';
import { Net, makeEmails, VALIDATION_SIZE, type Email } from './train-core';

const RATES = [0.03, 0.1, 0.3, 1, 3, 10, 30];
const EPOCHS_PER_TICK = 2;
const MAX_EPOCHS = 3000;
const CELLS = 12;
const PX = 8, PY = 30, PS = 188; // plot square
const CX = 226, CW = 166; // loss chart x and width (same top and height as the plot)
const LOSS_MAX = 1.5;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export const createNnModel: SimFactory = () => {
  let hidden = 6;
  let lr = 1;
  let nTrain = 120;
  let train: Email[] = [];
  let val: Email[] = [];
  let net: Net;
  let weightSeed = 1;
  let epoch = 0;
  let curve: { e: number; tr: number; va: number }[] = [];
  let bestVal = Infinity;
  let lastTrain = Infinity;
  let warnedOverfit = false;
  let warnedJump = false;
  let event: string | null = null;
  let dirtyPoints = true;

  function newNet(): void {
    net = new Net(hidden, createRng(1000 + weightSeed));
    epoch = 0;
    curve = [];
    bestVal = Infinity;
    lastTrain = Infinity;
    warnedOverfit = false;
    warnedJump = false;
    record();
  }

  function record(): void {
    const tr = net.loss(train);
    const va = net.loss(val);
    curve.push({ e: epoch, tr, va });
    if (va < bestVal) bestVal = va;
    if (!warnedJump && epoch > 0 && tr > lastTrain * 1.5 && tr > 0.3) {
      warnedJump = true;
      event = `epoch ${fmt(epoch)}: the training loss jumped up. The steps are too big: each one overshoots the bottom.`;
    }
    if (!warnedOverfit && epoch > 20 && va > bestVal * 1.25 && va - bestVal > 0.08 && tr < 0.35) {
      warnedOverfit = true;
      event = `epoch ${fmt(epoch)}: validation loss is rising while training loss keeps falling. The network is memorising its training emails.`;
    }
    lastTrain = tr;
  }

  const sx = (v: number) => PX + v * PS;
  const sy = (v: number) => PY + PS - v * PS;
  const cy = (loss: number) => PY + PS - (Math.min(loss, LOSS_MAX) / LOSS_MAX) * PS;
  const cx = (e: number) => CX + (e / MAX_EPOCHS) * CW;

  return {
    params: [
      { name: 'hidden', label: 'Hidden neurons', min: 0, max: 12, step: 1, value: 6, format: (v) => (v === 0 ? 'none (one neuron)' : `${v}`) },
      { name: 'rate', label: 'Learning rate', min: 0, max: RATES.length - 1, step: 1, value: 3, format: (v) => `${RATES[v]}` },
      { name: 'train', label: 'Training emails', min: 10, max: 150, step: 5, value: 120, format: (v) => `${v}` },
    ],

    reset(params, rng) {
      hidden = params.hidden;
      lr = RATES[params.rate];
      nTrain = params.train;
      val = makeEmails(VALIDATION_SIZE, rng); // the same validation emails for every setting
      train = makeEmails(nTrain, rng);
      weightSeed = 1;
      event = `${nTrain} training emails, ${VALIDATION_SIZE} validation emails kept aside. Press play to train.`;
      dirtyPoints = true;
      newNet();
    },

    step() {
      if (epoch >= MAX_EPOCHS) return;
      if (epoch === 0) event = 'training: every tick is 2 epochs, each one a pass over all the training emails';
      for (let i = 0; i < EPOCHS_PER_TICK; i++) {
        net.epoch(train, lr);
        epoch++;
      }
      if (epoch % 10 === 0) record();
      if (epoch >= MAX_EPOCHS) event = `finished ${fmt(MAX_EPOCHS)} epochs. Try fewer training emails with 12 hidden neurons, or a learning rate of 30.`;
    },

    render(view) {
      const base = layer(view, 'base');
      if (!base.hasChildNodes()) {
        text('Spam chance', { x: PX, y: 20, 'font-size': 16, 'font-weight': 700, fill: token('--viz-ink') }, base);
        text('Loss (lower is better)', { x: CX - 4, y: 20, 'font-size': 16, 'font-weight': 700, fill: token('--viz-ink') }, base);
        text('links →', { x: PX + PS / 2, y: PY + PS + 18, 'font-size': 15, 'text-anchor': 'middle', fill: token('--viz-muted') }, base);
        text('epochs → 3,000', { x: CX + CW, y: PY + PS + 18, 'font-size': 15, 'text-anchor': 'end', fill: token('--viz-muted') }, base);
        for (const v of [0, 0.5, 1, 1.5]) {
          svg('line', { x1: CX, x2: CX + CW, y1: cy(v), y2: cy(v), stroke: token('--viz-stroke'), 'stroke-width': 1, 'stroke-dasharray': v ? '2 4' : null }, base);
          text(v, { x: CX - 4, y: cy(v) + 5, 'font-size': 14, 'text-anchor': 'end', fill: token('--viz-muted') }, base);
        }
        svg('rect', { x: PX, y: PY, width: PS, height: PS, fill: 'none', stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
        // Legend
        svg('rect', { x: PX, y: 246, width: 9, height: 9, fill: token('--viz-bad') }, base);
        text('spam', { x: PX + 14, y: 255, 'font-size': 15, fill: token('--viz-ink') }, base);
        svg('circle', { cx: PX + 66, cy: 250.5, r: 4.5, fill: 'none', stroke: token('--viz-ok'), 'stroke-width': 2 }, base);
        text('not spam', { x: PX + 75, y: 255, 'font-size': 15, fill: token('--viz-ink') }, base);
        svg('line', { x1: CX - 20, x2: CX - 4, y1: 250, y2: 250, stroke: token('--viz-flow'), 'stroke-width': 2.5 }, base);
        text('training', { x: CX, y: 255, 'font-size': 15, fill: token('--viz-ink') }, base);
        svg('line', { x1: CX + 64, x2: CX + 80, y1: 250, y2: 250, stroke: token('--viz-warn'), 'stroke-width': 2.5, 'stroke-dasharray': '5 3' }, base);
        text('validation', { x: CX + 84, y: 255, 'font-size': 15, fill: token('--viz-ink') }, base);
      }

      // The network's spam chance over the whole square.
      const heat = layer(view, 'heat');
      if (!heat.hasChildNodes()) {
        const c = PS / CELLS;
        for (let r = 0; r < CELLS; r++)
          for (let k = 0; k < CELLS; k++) svg('rect', { x: PX + k * c, y: PY + r * c, width: c + 0.3, height: c + 0.3 }, heat);
        view.insertBefore(heat, base.nextSibling);
      }
      const cells = heat.children;
      for (let r = 0; r < CELLS; r++)
        for (let k = 0; k < CELLS; k++) {
          const p = net.predict((k + 0.5) / CELLS, 1 - (r + 0.5) / CELLS);
          const el = cells[r * CELLS + k];
          el.setAttribute('fill', p >= 0.5 ? token('--viz-bad') : token('--viz-ok'));
          el.setAttribute('fill-opacity', (0.06 + Math.abs(p - 0.5) * 0.5).toFixed(3));
        }

      // Training emails (drawn once per reset).
      const pts = layer(view, 'points');
      if (dirtyPoints) {
        clear(pts);
        for (const e of train) {
          if (e.spam) svg('rect', { x: sx(e.x) - 4, y: sy(e.y) - 4, width: 8, height: 8, fill: token('--viz-bad') }, pts);
          else svg('circle', { cx: sx(e.x), cy: sy(e.y), r: 4, fill: token('--viz-surface'), stroke: token('--viz-ok'), 'stroke-width': 2 }, pts);
        }
        text('↑ money words', { x: PX + 4, y: PY + 16, 'font-size': 14, fill: token('--viz-ink'), stroke: token('--viz-surface'), 'stroke-width': 3, 'paint-order': 'stroke' }, pts);
        dirtyPoints = false;
      }

      // Loss curves.
      const lines = layer(view, 'lines');
      clear(lines);
      const path = (key: 'tr' | 'va') => curve.map((p) => `${cx(p.e).toFixed(1)},${cy(p[key]).toFixed(1)}`).join(' ');
      if (curve.length > 1) {
        svg('polyline', { points: path('va'), fill: 'none', stroke: token('--viz-warn'), 'stroke-width': 2.5, 'stroke-dasharray': '5 3' }, lines);
        svg('polyline', { points: path('tr'), fill: 'none', stroke: token('--viz-flow'), 'stroke-width': 2.5 }, lines);
      }
    },

    stats() {
      const last = curve[curve.length - 1];
      return {
        Epoch: fmt(epoch),
        'Training loss': last.tr.toFixed(3),
        'Validation loss': last.va.toFixed(3),
        'Right on training': `${Math.round(net.accuracy(train) * 100)}%`,
        'Right on validation': `${Math.round(net.accuracy(val) * 100)}%`,
      };
    },

    log: () => event,

    actions: [
      {
        label: 'New starting weights',
        run() {
          weightSeed++;
          newNet();
          event = 'same emails, new random starting weights: training starts again from epoch 0';
        },
      },
    ],
  };
};
