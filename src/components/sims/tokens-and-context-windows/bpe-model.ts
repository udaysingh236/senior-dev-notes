// BPE sim: learn merges one by one from a small English + Hindi word list and watch two sentences
// with the same meaning shrink. The reader sets how much of the training text is Hindi and how
// many merges (vocabulary entries) to learn. See bpe-core.ts for the training itself.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { SimFactory } from '../../sim/types';
import { EN_SENTENCE, HI_SENTENCE, bytesOf, encodeWord, pieceText, train, type Merge, type Piece } from './bpe-core';

const PX = 5.4; // width of one byte
const X0 = 4;
const MERGES_PER_S = 30;

const sentenceBytes = (ws: string[]) => ws.reduce((s, w) => s + bytesOf(w).length, 0);
const EN_BYTES = sentenceBytes(EN_SENTENCE);
const HI_BYTES = sentenceBytes(HI_SENTENCE);

export const createBpeModel: SimFactory = () => {
  let merges: Merge[] = [];
  let budget = 80;
  let share = 0.1;
  let learned = 0; // fractional, advances while playing
  let shown = -1;
  let en: Piece[] = [];
  let hi: Piece[] = [];
  let lastEvent: string | null = null;

  const target = () => Math.min(budget, merges.length);

  function encodeAt(n: number): void {
    en = EN_SENTENCE.flatMap((w) => encodeWord(w, merges, n));
    hi = HI_SENTENCE.flatMap((w) => encodeWord(w, merges, n));
    shown = n;
  }

  function describe(m: Merge): string {
    const a = pieceText(m.a);
    const b = pieceText(m.b);
    if (a !== null && b !== null) return `'${a}' + '${b}'`;
    return `${m.a.length + m.b.length} bytes of one Hindi letter`;
  }

  function chips(g: SVGGElement, pieces: Piece[], y: number, tone: 'flow' | 'warn'): void {
    let x = X0;
    for (const p of pieces) {
      const w = p.length * PX;
      svg('rect', { x: x + 0.5, y, width: Math.max(1, w - 1), height: 34, rx: 3, fill: token(`--viz-${tone}-soft`), stroke: token(`--viz-${tone}`), 'stroke-width': 1.5 }, g);
      const t = pieceText(p);
      if (t !== null && !/^\p{M}/u.test(t) && t.length * 9 <= w - 4) {
        text(t, { x: x + w / 2, y: y + 23, 'font-size': 15, 'text-anchor': 'middle', fill: token('--viz-ink'), 'font-family': 'var(--sl-font-mono)' }, g);
      }
      x += w;
    }
  }

  return {
    params: [
      { name: 'share', label: 'Hindi in training text', min: 0, max: 50, step: 5, value: 10, unit: '%' },
      { name: 'budget', label: 'Merges to learn', min: 0, max: 200, step: 10, value: 80, format: (v) => `${v} (vocabulary ${256 + v})` },
    ],

    reset(params) {
      share = params.share / 100;
      budget = params.budget;
      merges = train(share, 200);
      learned = 0;
      encodeAt(0);
      lastEvent = `training text: ${100 - params.share}% English, ${params.share}% Hindi. Both sentences start as single bytes.`;
    },

    step(dt) {
      if (learned >= target()) return;
      learned = Math.min(target(), learned + (dt / 1000) * MERGES_PER_S);
      const n = Math.floor(learned);
      if (n !== shown) {
        encodeAt(n);
        if (n > 0) {
          const m = merges[n - 1];
          lastEvent = `merge ${n}: ${describe(m)} (${m.lang === 'en' ? 'mostly English' : 'mostly Hindi'} text)`;
        }
        if (n === target() && budget > merges.length) lastEvent = `all ${merges.length} possible merges learned: every training word is one token`;
      }
    },

    render(view) {
      const base = layer(view, 'base');
      if (!base.hasChildNodes()) {
        svg('line', { x1: X0 + EN_BYTES * PX, y1: 28, x2: X0 + EN_BYTES * PX, y2: 72, stroke: token('--viz-stroke'), 'stroke-dasharray': '3 3' }, base);
        svg('line', { x1: X0 + HI_BYTES * PX, y1: 110, x2: X0 + HI_BYTES * PX, y2: 154, stroke: token('--viz-stroke'), 'stroke-dasharray': '3 3' }, base);
      }
      const live = layer(view, 'live');
      clear(live);
      text(`I love reading books: ${en.length} token${en.length === 1 ? '' : 's'}`, { x: X0, y: 20, 'font-size': 16, 'font-weight': 700, fill: token('--viz-ink') }, live);
      chips(live, en, 32, 'flow');
      text(`${EN_BYTES} bytes`, { x: X0 + EN_BYTES * PX + 8, y: 55, 'font-size': 15, fill: token('--viz-muted') }, live);
      text(`मुझे किताबें पढ़ना पसंद है: ${hi.length} tokens`, { x: X0, y: 102, 'font-size': 16, 'font-weight': 700, fill: token('--viz-ink') }, live);
      chips(live, hi, 114, 'warn');
      text(`${HI_BYTES} bytes`, { x: X0 + HI_BYTES * PX - 2, y: 172, 'font-size': 15, 'text-anchor': 'end', fill: token('--viz-muted') }, live);

      const ratio = hi.length / en.length;
      text(`Hindi needs ${ratio.toFixed(1)}× the tokens`, { x: X0, y: 204, 'font-size': 17, 'font-weight': 700, fill: token(ratio > 3 ? '--viz-bad' : ratio > 1.5 ? '--viz-warn' : '--viz-ok') }, live);
      const n = shown;
      const hiMerges = merges.slice(0, n).filter((m) => m.lang === 'hi').length;
      text(`${n} merges learned: ${n - hiMerges} from English, ${hiMerges} from Hindi`, { x: X0, y: 230, 'font-size': 15, fill: token('--viz-muted') }, live);
      // A thin bar showing how the learned merges were shared out.
      const W = 392;
      const enW = n ? ((n - hiMerges) / Math.max(n, 1)) * W : 0;
      svg('rect', { x: X0, y: 240, width: W, height: 10, rx: 3, fill: token('--viz-surface'), stroke: token('--viz-stroke') }, live);
      if (n) {
        svg('rect', { x: X0, y: 240, width: enW, height: 10, rx: 3, fill: token('--viz-flow') }, live);
        svg('rect', { x: X0 + enW, y: 240, width: W - enW, height: 10, rx: 3, fill: token('--viz-warn') }, live);
      }
    },

    stats() {
      return {
        'merges learned': `${shown} / ${target()}`,
        vocabulary: 256 + shown,
        'English tokens': en.length,
        'Hindi tokens': hi.length,
      };
    },

    log: () => lastEvent,

    actions: [
      {
        label: 'Learn all merges now',
        run() {
          learned = target();
          encodeAt(target());
          lastEvent = `${target()} merges learned`;
        },
      },
    ],
  };
};
