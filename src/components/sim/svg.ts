// Small helpers for drawing sims in plain SVG, without a framework.

const SVG_NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number | boolean | null | undefined>;

/** Sets attributes; null, undefined and false remove the attribute. */
export function setAttrs<E extends Element>(el: E, attrs: Attrs): E {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) el.removeAttribute(key);
    else el.setAttribute(key, String(value));
  }
  return el;
}

/** Creates an SVG element: svg('rect', { x: 0, y: 0, width: 10, height: 10 }, parent). */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const el = setAttrs(document.createElementNS(SVG_NS, tag), attrs);
  parent?.append(el);
  return el;
}

/** Creates an SVG <text> element with content. */
export function text(content: string | number, attrs: Attrs = {}, parent?: Element): SVGTextElement {
  const el = svg('text', attrs, parent);
  el.textContent = String(content);
  return el;
}

/** Removes every child. */
export function clear(el: Element): void {
  el.replaceChildren();
}

/**
 * Returns the child group with a given key, creating it on first use. Lets render() keep
 * static layers (axes, labels) and only redraw the moving parts each frame.
 */
export function layer(view: SVGSVGElement, key: string, attrs: Attrs = {}): SVGGElement {
  let g = view.querySelector<SVGGElement>(`:scope > g[data-layer="${key}"]`);
  if (!g) g = svg('g', { ...attrs, 'data-layer': key }, view);
  return g;
}

/**
 * A theme token as an attribute value: fill={token('--viz-ok')}. Using var() keeps colours
 * live, so the sim follows a light/dark switch without re-rendering.
 */
export function token(name: `--viz-${string}`): string {
  return `var(${name})`;
}

/** "1.25 s" for 1250 ms; "850 ms" below one second. */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(2))} s` : `${Math.round(ms)} ms`;
}

/** "t=1.2s" style timestamp for event logs. */
export function stamp(ms: number): string {
  return `t=${(ms / 1000).toFixed(1)}s`;
}

/** Percentage with no decimals, safe when the total is zero. */
export function percent(part: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((part / total) * 100)}%`;
}

/** Clamps a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
