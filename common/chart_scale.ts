/**
 * Shared chart-geometry maths for the SVG chart renderers.
 *
 * Every renderer in `common/` maps sparse milestone data onto
 * deterministic SVG coordinates using the same rules, so those rules
 * live here once rather than being copy-pasted per chart (issue #776):
 *
 *   - **Extents** — {@link minBy} / {@link maxBy} over an accessor.
 *   - **Scales** — {@link makeScale} (linear, collapsing to the range
 *     centre on a degenerate domain) and {@link makeXScale} (adds the
 *     optional base-10 log mapping used for the 1, 10, 100, … milestone
 *     cadence).
 *   - **Ticks** — {@link niceTicks} (linear/integer ticks),
 *     {@link logTicks} (powers of ten plus the bounds) and
 *     {@link niceStep} (the 1–2–5 step progression).
 *
 * Pure maths — no DOM, no SVG strings, no dependencies. A change to any
 * of these rules now lands in one place for every chart.
 */

/** Smallest value of `get` across `arr`; `Infinity` when `arr` is empty. */
export function minBy<T>(arr: readonly T[], get: (t: T) => number): number {
  let best = Infinity;
  for (const item of arr) {
    const v = get(item);
    if (v < best) best = v;
  }
  return best;
}

/** Largest value of `get` across `arr`; `-Infinity` when `arr` is empty. */
export function maxBy<T>(arr: readonly T[], get: (t: T) => number): number {
  let best = -Infinity;
  for (const item of arr) {
    const v = get(item);
    if (v > best) best = v;
  }
  return best;
}

/**
 * Build a linear scale mapping `[domainMin, domainMax]` onto
 * `[rangeMin, rangeMax]`. Collapses to the centre of the range when the
 * domain is degenerate.
 *
 * `rangeMin > rangeMax` is supported and is how the Y axes are built —
 * SVG's y coordinate grows downward.
 */
export function makeScale(
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): (v: number) => number {
  const dSpan = domainMax - domainMin;
  if (dSpan === 0) {
    const mid = (rangeMin + rangeMax) / 2;
    return () => mid;
  }
  const rSpan = rangeMax - rangeMin;
  return (v: number) => rangeMin + ((v - domainMin) / dSpan) * rSpan;
}

/**
 * Build an X scale that maps generation onto `[rangeMin, rangeMax]`.
 * In log mode, generation values are passed through `Math.log10` after
 * clamping to a minimum of 1 (avoids `log(0)`). Linear mode delegates
 * to {@link makeScale}.
 */
export function makeXScale(
  genMin: number,
  genMax: number,
  rangeMin: number,
  rangeMax: number,
  logX: boolean,
): (v: number) => number {
  if (!logX) {
    return makeScale(genMin, genMax, rangeMin, rangeMax);
  }
  const lMin = Math.log10(Math.max(1, genMin));
  const lMax = Math.log10(Math.max(1, genMax));
  const linear = makeScale(lMin, lMax, rangeMin, rangeMax);
  return (v: number) => linear(Math.log10(Math.max(1, v)));
}

/**
 * Produce roughly `target` evenly spaced tick values across `[min, max]`.
 * When `integerOnly` is true (count axis), ticks are rounded to integers
 * and de-duplicated. When the range is degenerate the function returns
 * the single value as the only tick. The upper bound is always the last
 * tick.
 */
export function niceTicks(
  min: number,
  max: number,
  target: number,
  integerOnly: boolean,
): number[] {
  if (min === max) {
    return [integerOnly ? Math.round(min) : min];
  }
  const span = max - min;
  const rawStep = span / Math.max(1, target);
  const step = integerOnly ? Math.max(1, Math.round(rawStep)) : niceStep(rawStep);
  const out: number[] = [];
  const start = integerOnly ? Math.ceil(min / step) * step : min;
  for (let v = start; v <= max + 1e-9; v += step) {
    if (integerOnly) out.push(Math.round(v));
    else out.push(v);
  }
  if (out.length === 0) out.push(integerOnly ? Math.round(min) : min);
  const lastTick = integerOnly ? Math.round(max) : max;
  if (out[out.length - 1] !== lastTick) out.push(lastTick);
  return integerOnly ? Array.from(new Set(out)) : out;
}

/**
 * Produce powers-of-ten tick values across `[min, max]`, with the bounds
 * themselves added when they are not already on a decade boundary. The
 * lower bound is clamped to 1 because the log axis cannot represent 0.
 */
export function logTicks(min: number, max: number): number[] {
  const lo = Math.max(1, min);
  const hi = Math.max(lo, max);
  const startExp = Math.floor(Math.log10(lo));
  const endExp = Math.ceil(Math.log10(hi));
  const out: number[] = [];
  for (let e = startExp; e <= endExp; e++) {
    const v = Math.pow(10, e);
    if (v >= lo && v <= hi) out.push(v);
  }
  if (out.length === 0 || out[0] !== lo) out.unshift(lo);
  if (out[out.length - 1] !== hi) out.push(hi);
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

/**
 * Round a raw step up onto the 1–2–5–10 progression so tick labels land
 * on human-readable values. A non-positive raw step falls back to 1.
 */
export function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const frac = raw / base;
  let nice: number;
  if (frac < 1.5) nice = 1;
  else if (frac < 3) nice = 2;
  else if (frac < 7) nice = 5;
  else nice = 10;
  return nice * base;
}
