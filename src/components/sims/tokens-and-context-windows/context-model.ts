// Context window sim: a 40-question chat sent into a fixed window. Every request resends the
// instructions and the history the app keeps; when the next request would not fit, the app
// drops the oldest exchanges, folds them into a summary, or refuses.
// Fixed: 500 tokens of instructions, 1,000 kept free for the answer. Each exchange is half
// question, half answer.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { SimFactory } from '../../sim/types';

const QUESTIONS = 40;
const INSTR = 500;
const RESERVE = 1000;
const Q_PER_S = 2;
const STRATEGIES = ['drop oldest', 'summarise oldest', 'refuse'];
const SUMMARY_CAP = 1200;
const X0 = 4;
const W = 392;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

interface Req {
  sent: number; // input tokens this request
  billedSoFar: number; // all input tokens billed up to and including this request
}

export const createContextModel: SimFactory = () => {
  let windowSize = 8000;
  let ex = 400;
  let strategy = 0;
  let t = 0; // questions asked so far, fractional
  let asked = 0;
  let kept: number[] = []; // question numbers of the exchanges still sent in full
  let summary = 0; // tokens of the summary block
  let summarisedUpTo = 0;
  let droppedUpTo = 0;
  let refusedAt = 0;
  let billed = 0;
  let reqs: Req[] = [];
  let lastEvent: string | null = null;

  const budget = () => windowSize - RESERVE;
  const requestSize = () => INSTR + summary + kept.length * ex + ex / 2;

  function ask(q: number): void {
    // Make room for question q.
    if (requestSize() > budget()) {
      if (strategy === 2) {
        refusedAt = q;
        lastEvent = `question ${q} refused: it needs ${fmt(requestSize())} tokens, the window leaves ${fmt(budget())}. Start a new chat.`;
        return;
      }
      if (strategy === 0) {
        while (kept.length && requestSize() > budget()) droppedUpTo = kept.shift()!;
        lastEvent = `question ${q}: dropped everything up to exchange ${droppedUpTo}. The model can no longer see it.`;
      } else {
        // Compaction: fold the oldest half of the kept exchanges into the summary in one extra request.
        const n = Math.max(1, Math.floor(kept.length / 2));
        const chunk = kept.splice(0, n);
        summarisedUpTo = chunk[chunk.length - 1];
        billed += summary + chunk.length * ex; // the summary request reads the old summary and the chunk
        summary = Math.min(SUMMARY_CAP, Math.round(summary + 0.15 * chunk.length * ex));
        while (kept.length && requestSize() > budget()) {
          summarisedUpTo = kept.shift()!;
          summary = Math.min(SUMMARY_CAP, Math.round(summary + 0.15 * ex));
        }
        lastEvent = `question ${q}: exchanges up to ${summarisedUpTo} folded into a ${fmt(summary)}-token summary (one extra request)`;
      }
    } else if (q === 1) lastEvent = 'question 1: instructions + the question';
    const sent = requestSize();
    billed += sent;
    reqs.push({ sent, billedSoFar: billed });
    kept.push(q); // after the answer, this exchange joins the history
    asked = q;
  }

  return {
    params: [
      { name: 'window', label: 'Context window', min: 2000, max: 16000, step: 1000, value: 8000, format: (v) => `${fmt(v)} tokens` },
      { name: 'ex', label: 'One exchange', min: 200, max: 800, step: 100, value: 400, format: (v) => `${v} tokens` },
      { name: 'strategy', label: 'When it is full', min: 0, max: 2, step: 1, value: 0, format: (v) => STRATEGIES[v] },
    ],

    reset(params) {
      windowSize = params.window;
      ex = params.ex;
      strategy = params.strategy;
      t = 0;
      asked = 0;
      kept = [];
      summary = 0;
      summarisedUpTo = 0;
      droppedUpTo = 0;
      refusedAt = 0;
      billed = 0;
      reqs = [];
      lastEvent = `window ${fmt(windowSize)}: 500 for instructions, 1,000 kept for the answer, ${fmt(budget() - INSTR)} for the chat`;
    },

    step(dt) {
      if (refusedAt || asked >= QUESTIONS) return;
      t = Math.min(QUESTIONS, t + (dt / 1000) * Q_PER_S);
      while (asked < Math.floor(t) && !refusedAt) ask(asked + 1);
    },

    render(view) {
      const live = layer(view, 'live');
      clear(live);
      const px = (n: number) => (n / windowSize) * W;

      // The window bar for the latest request.
      text(asked ? `request for question ${asked}` : 'the window', { x: X0, y: 18, 'font-size': 15, fill: token('--viz-muted') }, live);
      svg('rect', { x: X0, y: 26, width: W, height: 36, rx: 4, fill: token('--viz-surface'), stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, live);
      let x = X0;
      const seg = (n: number, tone: string, label?: string) => {
        if (n <= 0) return;
        svg('rect', { x, y: 26, width: px(n), height: 36, fill: token(`--viz-${tone}-soft` as `--viz-${string}`), stroke: token(`--viz-${tone}` as `--viz-${string}`), 'stroke-width': 1 }, live);
        if (label && px(n) > label.length * 8.5) text(label, { x: x + px(n) / 2, y: 49, 'font-size': 14, 'text-anchor': 'middle', fill: token('--viz-ink') }, live);
        x += px(n);
      };
      seg(INSTR, 'store');
      seg(summary, 'warn', 'summary');
      const histKept = asked ? kept.slice(0, -1) : [];
      if (histKept.length) seg(histKept.length * ex, 'flow', `${histKept[0]}–${histKept[histKept.length - 1]}`);
      if (asked) seg(ex / 2, 'client');
      svg('rect', { x: X0 + W - px(RESERVE), y: 26, width: px(RESERVE), height: 36, fill: token('--viz-ok-soft'), stroke: token('--viz-ok'), 'stroke-width': 1 }, live);
      if (px(RESERVE) > 50) text('answer', { x: X0 + W - px(RESERVE) / 2, y: 49, 'font-size': 14, 'text-anchor': 'middle', fill: token('--viz-ink') }, live);

      const gone = Math.max(droppedUpTo, summarisedUpTo);
      const note = refusedAt
        ? `refused at question ${refusedAt}`
        : gone
          ? strategy === 0
            ? `exchanges 1–${gone} dropped: out of view`
            : `exchanges 1–${gone} survive only as a summary`
          : 'nothing left out yet';
      text(note, { x: X0, y: 82, 'font-size': 15, 'font-weight': 600, fill: token(refusedAt || (gone && strategy === 0) ? '--viz-bad' : gone ? '--viz-warn' : '--viz-ok') }, live);

      // Per-request input tokens, one bar per question.
      const C0 = 104;
      const C1 = 214;
      const bw = W / QUESTIONS;
      const yC = (n: number) => C1 - (n / windowSize) * (C1 - C0);
      text('input tokens sent per question', { x: X0, y: C0 - 4, 'font-size': 14, fill: token('--viz-muted') }, live);
      svg('line', { x1: X0, y1: yC(budget()), x2: X0 + W, y2: yC(budget()), stroke: token('--viz-bad'), 'stroke-dasharray': '5 4', 'stroke-width': 1.5 }, live);
      text('window − answer', { x: X0 + W - 2, y: yC(budget()) - 4, 'font-size': 13, 'text-anchor': 'end', fill: token('--viz-bad') }, live);
      svg('line', { x1: X0, y1: C1, x2: X0 + W, y2: C1, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, live);
      reqs.forEach((r, i) => {
        svg('rect', { x: X0 + i * bw + 1, y: yC(r.sent), width: bw - 2, height: C1 - yC(r.sent), fill: token('--viz-flow') }, live);
      });
      text('1', { x: X0 + bw / 2, y: C1 + 16, 'font-size': 13, 'text-anchor': 'middle', fill: token('--viz-muted') }, live);
      text(String(QUESTIONS), { x: X0 + W - bw / 2, y: C1 + 16, 'font-size': 13, 'text-anchor': 'middle', fill: token('--viz-muted') }, live);
      text('question', { x: X0 + W / 2, y: C1 + 16, 'font-size': 13, 'text-anchor': 'middle', fill: token('--viz-muted') }, live);

      const chat = asked * ex;
      text(`billed so far: ${fmt(billed)} input tokens`, { x: X0, y: 254, 'font-size': 16, 'font-weight': 700, fill: token('--viz-ink') }, live);
      text(`the chat itself: ${fmt(chat)} tokens${chat ? `, so ${(billed / chat).toFixed(1)}× over` : ''}`, { x: X0, y: 276, 'font-size': 15, fill: token('--viz-muted') }, live);
    },

    stats() {
      const last = reqs[reqs.length - 1];
      const oldest = kept.length ? (asked ? kept[0] : '–') : '–';
      return {
        question: `${asked} / ${QUESTIONS}`,
        'this request': last ? `${fmt(last.sent)} tokens` : '–',
        'oldest exchange in full': summary || droppedUpTo ? oldest : asked ? 1 : '–',
        'billed input': fmt(billed),
      };
    },

    log: () => lastEvent,
  };
};
