// Runtime behind SimShell.astro: playback, sliders, stats and the event log for any SimModel.
import { createRng } from './rng';
import type { ParamSpec, SimFactory, SimModel, SimOptions } from './types';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
/** Never run more than this many model steps in one frame, so a slow device cannot spiral. */
const MAX_STEPS_PER_FRAME = 200;
/** Clamp long frame gaps (background tab, debugger) so time does not jump. */
const MAX_FRAME_MS = 100;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Mounts every not-yet-mounted SimShell on the page whose `name` matches. */
export function mountAll(name: string, factory: SimFactory, options: SimOptions = {}): void {
  for (const root of document.querySelectorAll<HTMLElement>(`[data-sim="${name}"]`)) {
    if (root.dataset.mounted) continue;
    root.dataset.mounted = 'true';
    try {
      mountSim(root, factory, options);
    } catch (err) {
      showError(root, err);
    }
  }
}

function showError(root: HTMLElement, err: unknown): void {
  console.error(err);
  const log = root.querySelector<HTMLElement>('[data-sim-log]');
  if (log) log.textContent = 'This simulation hit an error. Reloading the page usually fixes it.';
}

function readOptions(root: HTMLElement, defaults: SimOptions): Required<SimOptions> {
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' ? Number(v) : d);
  return {
    seed: num(root.dataset.seed, defaults.seed ?? 42),
    tickMs: num(root.dataset.tickMs, defaults.tickMs ?? 20),
    stepMs: num(root.dataset.stepMs, defaults.stepMs ?? 100),
    autoplay: root.dataset.autoplay ? root.dataset.autoplay === 'true' : (defaults.autoplay ?? true),
  };
}

export function mountSim(root: HTMLElement, factory: SimFactory, defaults: SimOptions = {}): void {
  const opts = readOptions(root, defaults);
  root.id ||= `sim-${root.dataset.sim}-${Math.random().toString(36).slice(2, 8)}`;
  const config = JSON.parse(root.dataset.config || '{}') as Record<string, unknown>;
  const model: SimModel = factory(config);

  const q = <E extends Element>(sel: string) => root.querySelector<E>(sel)!;
  const view = q<SVGSVGElement>('[data-sim-view]');
  const playBtn = q<HTMLButtonElement>('[data-sim-play]');
  const stepBtn = q<HTMLButtonElement>('[data-sim-step]');
  const resetBtn = q<HTMLButtonElement>('[data-sim-reset]');
  const speedSel = q<HTMLSelectElement>('[data-sim-speed]');
  const actionsBox = q<HTMLElement>('[data-sim-actions]');
  const paramsBox = q<HTMLElement>('[data-sim-params]');
  const statsBox = q<HTMLDListElement>('[data-sim-stats]');
  const logLine = q<HTMLElement>('[data-sim-log]');

  const values: Record<string, number> = Object.fromEntries(model.params.map((p) => [p.name, p.value]));
  let playing = false;
  let autoPaused = false;
  let userTookControl = false;
  let speed = 1;
  let acc = 0;
  let lastFrame = 0;
  let frame = 0;
  let failed = false;

  // ---------- drawing ----------

  let statKeys = '';
  function drawStats() {
    const stats = model.stats();
    const keys = Object.keys(stats).join('|');
    if (keys !== statKeys) {
      statKeys = keys;
      statsBox.replaceChildren(
        ...Object.keys(stats).map((k) => {
          const row = document.createElement('div');
          const dt = document.createElement('dt');
          const dd = document.createElement('dd');
          dt.textContent = k;
          row.append(dt, dd);
          return row;
        }),
      );
    }
    const dds = statsBox.querySelectorAll('dd');
    Object.values(stats).forEach((v, i) => {
      const s = String(v);
      if (dds[i].textContent !== s) dds[i].textContent = s;
    });
  }

  function draw() {
    if (failed) return;
    try {
      model.render(view);
      drawStats();
      const msg = model.log?.() ?? '';
      if (logLine.textContent !== msg) logLine.textContent = msg;
    } catch (err) {
      fail(err);
    }
  }

  function fail(err: unknown) {
    failed = true;
    pause();
    showError(root, err);
  }

  // ---------- time ----------

  function advance(ms: number) {
    acc += ms;
    let steps = 0;
    while (acc >= opts.tickMs && steps < MAX_STEPS_PER_FRAME) {
      model.step(opts.tickMs);
      acc -= opts.tickMs;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) acc = 0;
  }

  function loop(now: number) {
    if (!playing) return;
    const dt = Math.min(now - lastFrame, MAX_FRAME_MS);
    lastFrame = now;
    try {
      advance(dt * speed);
    } catch (err) {
      fail(err);
      return;
    }
    draw();
    frame = requestAnimationFrame(loop);
  }

  function setPlayingUi() {
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.querySelector('[data-label]')!.textContent = playing ? 'Pause' : 'Play';
    root.classList.toggle('is-playing', playing);
    // Announce events while stepping by hand; stay quiet while playing so screen readers are not flooded.
    logLine.setAttribute('aria-live', playing ? 'off' : 'polite');
  }

  function play() {
    if (playing || failed) return;
    playing = true;
    autoPaused = false;
    lastFrame = performance.now();
    setPlayingUi();
    frame = requestAnimationFrame(loop);
  }

  function pause() {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(frame);
    setPlayingUi();
  }

  function reset() {
    acc = 0;
    failed = false;
    try {
      model.reset({ ...values }, createRng(opts.seed));
    } catch (err) {
      fail(err);
      return;
    }
    draw();
  }

  // ---------- controls ----------

  playBtn.addEventListener('click', () => {
    userTookControl = true;
    playing ? pause() : play();
  });

  stepBtn.addEventListener('click', () => {
    userTookControl = true;
    pause();
    try {
      advance(opts.stepMs);
    } catch (err) {
      fail(err);
    }
    draw();
  });

  resetBtn.addEventListener('click', () => {
    reset();
  });

  speedSel.replaceChildren(
    ...SPEEDS.map((s) => {
      const o = document.createElement('option');
      o.value = String(s);
      o.textContent = `${s}×`;
      o.selected = s === 1;
      return o;
    }),
  );
  speedSel.addEventListener('change', () => {
    speed = Number(speedSel.value);
  });

  for (const action of model.actions ?? []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sim-btn sim-btn-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      try {
        action.run();
      } catch (err) {
        fail(err);
      }
      draw();
    });
    actionsBox.append(btn);
  }
  actionsBox.hidden = actionsBox.childElementCount === 0;

  paramsBox.replaceChildren(...model.params.map((p) => slider(p)));
  paramsBox.hidden = model.params.length === 0;

  function slider(p: ParamSpec): HTMLElement {
    const id = `${root.id}-${p.name}`;
    const wrap = document.createElement('div');
    wrap.className = 'sim-param';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = p.label;
    const out = document.createElement('output');
    out.htmlFor.add(id);
    const fmt = (v: number) => (p.format ? p.format(v) : `${v}${p.unit ? ` ${p.unit}` : ''}`);
    out.textContent = fmt(p.value);
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', id, min: p.min, max: p.max, step: p.step, value: p.value });
    input.setAttribute('aria-valuetext', fmt(p.value));
    input.addEventListener('input', () => {
      values[p.name] = Number(input.value);
      out.textContent = fmt(values[p.name]);
      input.setAttribute('aria-valuetext', out.textContent);
      reset();
    });
    const head = document.createElement('div');
    head.className = 'sim-param-head';
    head.append(label, out);
    wrap.append(head, input);
    return wrap;
  }

  // Space toggles play/pause when the sim (not one of its form controls) has focus.
  root.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a')) return;
    e.preventDefault();
    userTookControl = true;
    playing ? pause() : play();
  });

  // Pause when scrolled out of view; resume only if we were the ones who paused it.
  // "Visible" means a good share of the sim or of the screen, so tall sims on phones still count.
  const io = new IntersectionObserver(
    ([entry]) => {
      const seen = entry.intersectionRect.height;
      const visible =
        entry.isIntersecting &&
        seen >= Math.min(entry.boundingClientRect.height, window.innerHeight) * 0.35;
      if (!visible) {
        if (playing) {
          pause();
          autoPaused = true;
        }
      } else if (autoPaused) {
        play();
      } else if (opts.autoplay && !userTookControl && !reducedMotion.matches && !root.dataset.started) {
        root.dataset.started = 'true';
        play();
      }
    },
    { threshold: [0, 0.1, 0.2, 0.35, 0.5, 0.75, 1] },
  );
  io.observe(root);

  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      pause();
      autoPaused = false;
    }
  });

  root.classList.add('is-ready');
  setPlayingUi();
  reset();
}
