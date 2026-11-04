// Three plans for the same query, racing over the same table of 120 pages (50 rows each):
//   full scan     reads every page once, in page order
//   index scan    walks the index in key order and fetches the heap page of every matching row
//   bitmap scan   collects the matching rows' pages from the index first, then reads each page once,
//                 in page order
// Reading costs: the next page in order costs 1 (a sequential read), any other page costs
// "random read cost" (Postgres calls it random_page_cost, default 4), and the page already in hand
// costs nothing. Every lane spends the same cost budget per millisecond, so cost decides who finishes
// first. A simplified model: no cache, so a page read a second time is paid for again.
import { clear, layer, svg, text, token } from '../../sim/svg';
import type { Rng, SimFactory } from '../../sim/types';

const PAGES = 120;
const ROWS_PER_PAGE = 50;
const ROWS = PAGES * ROWS_PER_PAGE;
const COLS = 10;
const CELL = 11;
const GAP = 1;
const LANE_W = COLS * (CELL + GAP) - GAP;
const LANE_X = [0, 140, 280];
const GRID_Y = 30;
const GRID_H = (PAGES / COLS) * (CELL + GAP) - GAP;
const COST_PER_MS = 0.02; // the full scan's 120 units take 6 simulated seconds
const ENTRIES_PER_LEAF = 200;

interface Lane {
  title: string;
  order: number[]; // heap pages in the order this plan visits them
  costs: number[]; // cost of each visit
  total: number;
  next: number; // index into order
  budget: number;
  spent: number;
  reads: Uint16Array; // times each page was read
  current: number | null;
  doneAt: number | null;
}

function readCosts(order: number[], randomCost: number): number[] {
  let last = -1; // reading starts at the beginning of the table, so page 0 is a sequential read
  return order.map((page) => {
    const cost = page === last ? 0 : page === last + 1 ? 1 : randomCost;
    last = page;
    return cost;
  });
}

export const createScanModel: SimFactory = () => {
  let t = 0;
  let lanes: Lane[] = [];
  let matched = 0;
  let hasMatch = new Uint8Array(PAGES);
  let touched = 0;
  let lastEvent: string | null = null;

  function lane(title: string, order: number[], randomCost: number, indexCost: number): Lane {
    const costs = readCosts(order, randomCost);
    const total = indexCost + costs.reduce((a, b) => a + b, 0);
    // The index part (tree descent and leaf pages) is paid up front.
    return {
      title, order, costs, total, next: 0, budget: -indexCost, spent: indexCost,
      reads: new Uint16Array(PAGES), current: null, doneAt: null,
    };
  }

  function rowsInIndexOrder(count: number, correlation: number, rng: Rng): number[] {
    // Each matching row is either where index order would put it (a run of consecutive rows
    // starting at a random place) or on a random page. "Correlation" is the share of the first kind.
    const start = rng.int(0, ROWS - count);
    const pages: number[] = [];
    for (let j = 0; j < count; j++) {
      const ordered = rng.chance(correlation);
      pages.push(ordered ? Math.floor((start + j) / ROWS_PER_PAGE) : rng.int(0, PAGES - 1));
    }
    return pages;
  }

  return {
    params: [
      { name: 'selectivity', label: 'Rows matched', min: 0.5, max: 30, step: 0.5, value: 2, unit: '%' },
      { name: 'correlation', label: 'Rows stored in index order', min: 0, max: 100, step: 10, value: 0, unit: '%' },
      { name: 'randomCost', label: 'Random read cost', min: 1, max: 4, step: 0.1, value: 4, unit: '×' },
    ],

    reset(params, rng) {
      t = 0;
      matched = Math.max(1, Math.round((ROWS * params.selectivity) / 100));
      const indexOrder = rowsInIndexOrder(matched, params.correlation / 100, rng);
      hasMatch = new Uint8Array(PAGES);
      for (const page of indexOrder) hasMatch[page] = 1;
      const bitmapOrder = [...new Set(indexOrder)].sort((a, b) => a - b);
      touched = bitmapOrder.length;
      const descent = 2 * params.randomCost + Math.ceil(matched / ENTRIES_PER_LEAF);
      lanes = [
        lane('full scan', Array.from({ length: PAGES }, (_, i) => i), params.randomCost, 0),
        lane('index scan', indexOrder, params.randomCost, descent),
        lane('bitmap scan', bitmapOrder, params.randomCost, descent),
      ];
      lastEvent = `${matched} of ${ROWS.toLocaleString('en-US')} rows match, on ${touched} of ${PAGES} pages.`;
    },

    step(dt) {
      t += dt;
      for (const l of lanes) {
        if (l.doneAt !== null) continue;
        l.budget += dt * COST_PER_MS;
        while (l.next < l.order.length && l.budget >= l.costs[l.next]) {
          const page = l.order[l.next];
          l.budget -= l.costs[l.next];
          l.spent += l.costs[l.next];
          if (l.costs[l.next] > 0) {
            l.reads[page] += 1;
            if (l.reads[page] === 2) lastEvent = `t=${(t / 1000).toFixed(1)}s ${l.title}: page ${page} read a second time`;
          }
          l.current = page;
          l.next += 1;
        }
        if (l.next >= l.order.length && l.budget >= 0) {
          l.doneAt = t;
          l.current = null;
          lastEvent = `t=${(t / 1000).toFixed(1)}s ${l.title} done, cost ${Math.round(l.total)}`;
        }
      }
    },

    render(view) {
      const base = layer(view, 'base');
      if (!base.childElementCount) {
        lanes.forEach((l, i) => text(l.title, { x: LANE_X[i], y: 20, 'font-size': 18, 'font-weight': 700, fill: token('--viz-ink') }, base));
        text('green: page with a match · grey: read for nothing', { x: 200, y: 262, 'font-size': 15, 'text-anchor': 'middle', fill: token('--viz-muted') }, base);
        text('amber, crossed: read again', { x: 200, y: 280, 'font-size': 15, 'text-anchor': 'middle', fill: token('--viz-muted') }, base);
      }
      const live = layer(view, 'live');
      clear(live);
      const cheapest = Math.min(...lanes.map((l) => l.total));
      lanes.forEach((l, li) => {
        const x0 = LANE_X[li];
        for (let p = 0; p < PAGES; p++) {
          const x = x0 + (p % COLS) * (CELL + GAP);
          const y = GRID_Y + Math.floor(p / COLS) * (CELL + GAP);
          const reads = l.reads[p];
          const fill = reads === 0 ? 'none' : reads > 1 ? token('--viz-warn-soft') : hasMatch[p] ? token('--viz-ok-soft') : token('--viz-stroke');
          const stroke = l.current === p ? token('--viz-flow') : reads > 1 ? token('--viz-warn') : reads && hasMatch[p] ? token('--viz-ok') : token('--viz-stroke');
          svg('rect', { x, y, width: CELL, height: CELL, rx: 2, fill, stroke, 'stroke-width': l.current === p ? 2.5 : 1 }, live);
          if (reads > 1) svg('path', { d: `M${x + 2} ${y + CELL - 2} L${x + CELL - 2} ${y + 2}`, stroke: token('--viz-warn'), 'stroke-width': 1.5 }, live);
        }
        const barY = GRID_Y + GRID_H + 10;
        const done = Math.min(1, l.spent / l.total);
        svg('rect', { x: x0, y: barY, width: LANE_W, height: 8, rx: 4, fill: 'none', stroke: token('--viz-stroke'), 'stroke-width': 1 }, live);
        svg('rect', { x: x0, y: barY, width: LANE_W * done, height: 8, rx: 4, fill: token(l.doneAt !== null ? '--viz-ok' : '--viz-flow') }, live);
        const best = l.total === cheapest;
        text(`cost ${Math.round(l.total).toLocaleString('en-US')}`, {
          x: x0, y: barY + 30, 'font-size': 18, 'font-weight': best ? 700 : 400,
          fill: token(best ? '--viz-ok' : '--viz-ink'),
        }, live);
        const reads = l.reads.reduce((a, b) => a + b, 0);
        text(`${reads} reads`, { x: x0, y: barY + 52, 'font-size': 16, fill: token('--viz-muted') }, live);
      });
    },

    stats() {
      const [full, index, bitmap] = lanes;
      const name = lanes.reduce((a, b) => (b.total < a.total ? b : a)).title;
      return {
        time: `${(t / 1000).toFixed(1)} s`,
        'rows matched': `${matched} of ${ROWS.toLocaleString('en-US')}`,
        'pages with a match': `${touched} of ${PAGES} (${Math.round((100 * touched) / PAGES)}%)`,
        'cost: full / index / bitmap': `${Math.round(full.total)} / ${Math.round(index.total)} / ${Math.round(bitmap.total)}`,
        cheapest: name,
      };
    },

    log: () => lastEvent,
  };
};
