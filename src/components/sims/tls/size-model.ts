// What record sizes give away. A health site has twelve article pages; each one's response has a
// typical size, plus a little noise per visit (ads, personalised bits, compression). An observer on
// the path cannot decrypt anything, but TLS adds only a fixed overhead per record, so the bytes on
// the wire track the size of the page. The observer crawled the site beforehand and knows each
// page's typical encrypted size. For every visit it guesses the page whose typical size is closest
// to what it saw. Padding every response up to a multiple of the bucket size makes pages share a
// size, and the guess becomes a pick among the pages in that bucket.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

export const PAGES = [
  'hiv-test', 'pregnancy', 'diabetes', 'depression', 'ivf', 'rehab',
  'cardiology', 'dental', 'allergy', 'oncology', 'skin', 'vaccines',
];
const MAX_KB = 64;
const VISIT_MS = 700;

interface Visit {
  page: number;
  observed: number; // KB on the wire, after padding
  guess: number;
  at: number;
}

/** Pads a size up to the next multiple of the bucket; a bucket of 0 means no padding. */
export const pad = (kb: number, bucket: number) => (bucket > 0 ? Math.ceil(kb / bucket) * bucket : kb);

/** The observer's guess: the page whose padded typical size is nearest; ties broken at random. */
export function guess(observed: number, typical: number[], bucket: number, rng: Rng): number {
  let best: number[] = [];
  let bestGap = Infinity;
  typical.forEach((t, i) => {
    const gap = Math.abs(pad(t, bucket) - observed);
    if (gap < bestGap - 1e-9) {
      bestGap = gap;
      best = [i];
    } else if (Math.abs(gap - bestGap) <= 1e-9) best.push(i);
  });
  return best[Math.floor(rng.next() * best.length)];
}

export const createSizeModel: SimFactory = () => {
  let p: Record<string, number> = {};
  let rng: Rng;
  let typical: number[] = [];
  let visits: Visit[] = [];
  let now = 0;
  let next = 0;
  let right = 0;
  let count = 0;
  let realKb = 0;
  let wireKb = 0;
  let lastLog: string | null = null;

  const X0 = 8;
  const X1 = 392;
  const xAt = (kb: number) => X0 + (Math.min(kb, MAX_KB) / MAX_KB) * (X1 - X0);

  return {
    params: [
      { name: 'noise', label: 'Size variation per visit', min: 0, max: 20, step: 1, value: 3, unit: '%' },
      { name: 'bucket', label: 'Pad every response up to a multiple of', min: 0, max: 32, step: 1, value: 0, unit: 'KB' },
    ],

    reset(params, r) {
      p = params;
      rng = r;
      // Typical sizes between 6 and 52 KB, fixed by the seed, so every Reset has the same site.
      typical = PAGES.map(() => Math.round(rng.range(6, 52) * 10) / 10);
      visits = [];
      now = 0;
      next = 300;
      right = count = 0;
      realKb = wireKb = 0;
      lastLog = p.bucket ? `Every response is padded up to a multiple of ${p.bucket} KB.` : 'No padding: the wire carries each page at its own size.';
    },

    step(dt) {
      now += dt;
      while (now >= next) {
        const page = rng.int(0, PAGES.length - 1);
        const size = typical[page] * (1 + rng.range(-1, 1) * (p.noise / 100));
        const observed = pad(size, p.bucket);
        const g = guess(observed, typical, p.bucket, rng);
        visits.push({ page, observed, guess: g, at: next });
        if (visits.length > 40) visits.shift();
        count++;
        if (g === page) right++;
        realKb += size;
        wireKb += observed;
        lastLog = `visit: /${PAGES[page]}, ${observed.toFixed(1)} KB on the wire -> observer says /${PAGES[g]}: ${g === page ? 'RIGHT' : 'wrong'}`;
        next += VISIT_MS;
      }
    },

    render(view) {
      const base = layer(view, 'base');
      const key = `${p.bucket}`;
      if (base.getAttribute('data-k') !== key) {
        clear(base);
        base.setAttribute('data-k', key);
        text('typical size of each page (what the observer learned)', { x: X0, y: 20, 'font-size': 16, fill: token('--viz-muted') }, base);
        // Each page's typical size as a tick on the axis.
        typical.forEach((t) => {
          svg('line', { x1: xAt(t), y1: 30, x2: xAt(t), y2: 50, stroke: token('--viz-ink'), 'stroke-width': 2 }, base);
        });
        svg('line', { x1: X0, y1: 200, x2: X1, y2: 200, stroke: token('--viz-stroke'), 'stroke-width': 1.5 }, base);
        for (const kb of [0, 16, 32, 48, 64]) {
          text(`${kb} KB`, { x: xAt(kb), y: 224, 'font-size': 16, fill: token('--viz-muted'), 'text-anchor': kb === 0 ? 'start' : kb === 64 ? 'end' : 'middle' }, base);
        }
        if (p.bucket > 0) {
          for (let kb = p.bucket; kb < MAX_KB; kb += p.bucket) {
            svg('line', { x1: xAt(kb), y1: 56, x2: xAt(kb), y2: 200, stroke: token('--viz-warn'), 'stroke-width': 1.2, 'stroke-dasharray': '4 4' }, base);
          }
        }
      }
      const live = layer(view, 'live');
      clear(live);
      // Recent visits fall down the chart as they age; red = the observer named the page.
      visits.forEach((v) => {
        const age = (now - v.at) / (VISIT_MS * 40);
        const y = 66 + age * 128;
        const tone = v.guess === v.page ? 'bad' : 'ok';
        const x = xAt(v.observed);
        if (v.guess === v.page) svg('circle', { cx: x, cy: y, r: 6, fill: token(`--viz-${tone}`) }, live);
        else svg('rect', { x: x - 5, y: y - 5, width: 10, height: 10, fill: 'none', stroke: token(`--viz-${tone}`), 'stroke-width': 2 }, live);
      });
    },

    stats() {
      return {
        visits: count,
        'observer named the page': count ? `${Math.round((right / count) * 100)}%` : '–',
        'a blind guess would get': `${Math.round(100 / PAGES.length)}%`,
        'extra bytes from padding': realKb ? `${Math.round((wireKb / realKb - 1) * 100)}%` : '–',
      };
    },

    log: () => lastLog,
  };
};
