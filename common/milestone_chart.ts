/**
 * Shared SVG renderer for `evolveRL()` milestone statistics.
 *
 * `Creature.evolveRL()` emits `evolverl_milestone` events whose payload is
 * captured per-checkpoint as a {@link MilestoneSample}. The milestone
 * stream is sparse and non-uniformly spaced (typically 1, 2, 5, 10, 20,
 * 50, 100, 200, 500, 1000, then powers of ten), so this renderer plots
 * each sample at its actual generation and offers an optional log-X
 * mapping for the wide dynamic range.
 *
 * Series:
 *   - `bestScore` (left axis, blue)
 *   - `meanEpisodeSteps` (left axis, orange)
 *   - `bestNeurons` (right axis, green)
 *   - `bestSynapses` (right axis, red)
 *
 * Pure string emission — no DOM, no extra dependencies. Output is
 * byte-identical for identical inputs.
 */

/** A single milestone sample emitted by `Creature.evolveRL`. */
export interface MilestoneSample {
  /** Milestone generation (e.g. 1, 10, 100, 1000). */
  generation: number;
  /** Best fitness score at this milestone. */
  bestScore: number;
  /** Neuron count of the best creature at this milestone. */
  bestNeurons: number;
  /** Synapse count of the best creature at this milestone. */
  bestSynapses: number;
  /** Mean episode steps across the milestone evaluation. */
  meanEpisodeSteps: number;
  /** Wall-clock duration of the generation that produced this milestone (ms). */
  generationWallClockMs: number;
}

/** Options controlling {@link renderMilestoneChartSVG}. */
export interface RenderMilestoneChartOptions {
  /** Total SVG width in user units. Default 800. */
  width?: number;
  /** Total SVG height in user units. Default 400. */
  height?: number;
  /** Chart title rendered at the top. Default "evolveRL Milestones". */
  title?: string;
  /**
   * Plot generation on a base-10 logarithmic X axis. Recommended for the
   * canonical 1, 10, 100, 1000, … milestone schedule. Default `false`.
   */
  logX?: boolean;
  /**
   * Render a caption block summarising the final score, topology size and
   * the total wall-clock duration (sum of `generationWallClockMs`).
   * Default `false`.
   */
  caption?: boolean;
}

/** Stroke colour for the best-score line (left axis). */
const SCORE_COLOUR = "#1f77b4";
/** Stroke colour for the mean-episode-steps line (left axis). */
const STEPS_COLOUR = "#ff7f0e";
/** Stroke colour for the neuron-count line (right axis). */
const NEURONS_COLOUR = "#2ca02c";
/** Stroke colour for the synapse-count line (right axis). */
const SYNAPSES_COLOUR = "#d62728";

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 400;

/** Plot-area inset from the SVG edges, leaving room for axes and legend. */
const MARGIN = { top: 40, right: 70, bottom: 60, left: 70 } as const;

/**
 * Render the milestone history as a dual-axis SVG string.
 *
 * Throws if `samples` is empty — callers are expected to skip rendering
 * when no milestones have been captured.
 */
export function renderMilestoneChartSVG(
  samples: readonly MilestoneSample[],
  options: RenderMilestoneChartOptions = {},
): string {
  if (samples.length === 0) {
    throw new Error("renderMilestoneChartSVG requires at least one sample");
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? "evolveRL Milestones";
  const logX = options.logX ?? false;
  const caption = options.caption ?? false;

  // Sort defensively by generation so plotting is stable regardless of
  // input order. Use a copy — never mutate the caller's array.
  const ordered = [...samples].sort((a, b) => a.generation - b.generation);

  const plotX = MARGIN.left;
  const plotY = MARGIN.top;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);

  const genMin = ordered[0].generation;
  const genMax = ordered[ordered.length - 1].generation;

  const scoreMin = minBy(ordered, (s) => s.bestScore);
  const scoreMax = maxBy(ordered, (s) => s.bestScore);
  const stepsMin = minBy(ordered, (s) => s.meanEpisodeSteps);
  const stepsMax = maxBy(ordered, (s) => s.meanEpisodeSteps);

  // Combined left-axis range so score and step series share a reference.
  const leftMin = Math.min(scoreMin, stepsMin);
  const leftMax = Math.max(scoreMax, stepsMax);

  // Shared right-axis range for the two count series, clamped to zero.
  const countMax = Math.max(
    maxBy(ordered, (s) => s.bestNeurons),
    maxBy(ordered, (s) => s.bestSynapses),
  );
  const countMin = 0;

  const xScale = makeXScale(genMin, genMax, plotX, plotX + plotW, logX);
  const yLeftScale = makeScale(leftMin, leftMax, plotY + plotH, plotY);
  const yRightScale = makeScale(countMin, countMax, plotY + plotH, plotY);

  const lines: string[] = [];

  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}" role="img" ` +
      `aria-label="${escapeAttr(title)} dual-axis chart">`,
    `  <title>${escapeText(title)}</title>`,
    `  <rect width="${width}" height="${height}" fill="#fafafa"/>`,
    `  <text x="${width / 2}" y="24" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
      escapeText(title) +
      `</text>`,
  );

  lines.push(
    `  <rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" ` +
      `fill="#ffffff" stroke="#333333" stroke-width="1"/>`,
  );

  lines.push(renderXAxis(genMin, genMax, xScale, plotY + plotH, logX));
  lines.push(renderLeftAxis(leftMin, leftMax, yLeftScale, plotX));
  lines.push(renderRightAxis(countMin, countMax, yRightScale, plotX + plotW));

  // Series — left axis first, then right axis.
  lines.push(
    renderSeries(
      "best-score-line",
      "best-score-point",
      SCORE_COLOUR,
      ordered,
      xScale,
      (s) => yLeftScale(s.bestScore),
    ),
  );
  lines.push(
    renderSeries(
      "mean-steps-line",
      "mean-steps-point",
      STEPS_COLOUR,
      ordered,
      xScale,
      (s) => yLeftScale(s.meanEpisodeSteps),
    ),
  );
  lines.push(
    renderSeries(
      "neurons-line",
      "neurons-point",
      NEURONS_COLOUR,
      ordered,
      xScale,
      (s) => yRightScale(s.bestNeurons),
    ),
  );
  lines.push(
    renderSeries(
      "synapses-line",
      "synapses-point",
      SYNAPSES_COLOUR,
      ordered,
      xScale,
      (s) => yRightScale(s.bestSynapses),
    ),
  );

  lines.push(renderLegend(plotX, plotY));

  if (caption) {
    lines.push(renderCaption(ordered, width, height));
  }

  lines.push(`</svg>`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Scaling helpers
// ---------------------------------------------------------------------------

function minBy<T>(arr: readonly T[], get: (t: T) => number): number {
  let best = Infinity;
  for (const item of arr) {
    const v = get(item);
    if (v < best) best = v;
  }
  return best;
}

function maxBy<T>(arr: readonly T[], get: (t: T) => number): number {
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
 */
function makeScale(
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
 * clamping to a minimum of 1 (avoids log(0)). Linear mode delegates to
 * {@link makeScale}.
 */
function makeXScale(
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

// ---------------------------------------------------------------------------
// Axis and series rendering
// ---------------------------------------------------------------------------

function renderXAxis(
  genMin: number,
  genMax: number,
  xScale: (v: number) => number,
  baseY: number,
  logX: boolean,
): string {
  const ticks = logX ? logTicks(genMin, genMax) : niceTicks(genMin, genMax, 8, true);
  const out: string[] = [];
  out.push(
    `  <g class="x-axis" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of ticks) {
    const x = xScale(t);
    out.push(
      `    <line x1="${fmt(x)}" y1="${fmt(baseY)}" x2="${fmt(x)}" y2="${fmt(baseY + 4)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(x)}" y="${fmt(baseY + 18)}" text-anchor="middle">${t}</text>`,
    );
  }
  const labelX = (xScale(genMin) + xScale(genMax)) / 2;
  const label = logX ? "generation (log scale)" : "generation";
  out.push(
    `    <text x="${fmt(labelX)}" y="${fmt(baseY + 36)}" text-anchor="middle" ` +
      `font-weight="bold">${escapeText(label)}</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderLeftAxis(
  leftMin: number,
  leftMax: number,
  yScale: (v: number) => number,
  baseX: number,
): string {
  const ticks = niceTicks(leftMin, leftMax, 5, false);
  const out: string[] = [];
  out.push(
    `  <g class="left-axis" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of ticks) {
    const y = yScale(t);
    out.push(
      `    <line x1="${fmt(baseX - 4)}" y1="${fmt(y)}" x2="${fmt(baseX)}" y2="${fmt(y)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX - 8)}" y="${fmt(y)}" text-anchor="end" ` +
        `dominant-baseline="middle">${formatScore(t)}</text>`,
    );
  }
  const midY = (yScale(leftMin) + yScale(leftMax)) / 2;
  out.push(
    `    <text x="${fmt(baseX - 48)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(-90 ${fmt(baseX - 48)} ${fmt(midY)})">score / mean steps</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderRightAxis(
  countMin: number,
  countMax: number,
  yScale: (v: number) => number,
  baseX: number,
): string {
  const ticks = niceTicks(countMin, countMax, 5, true);
  const out: string[] = [];
  out.push(
    `  <g class="right-axis" font-family="sans-serif" font-size="11" fill="#333333">`,
  );
  for (const t of ticks) {
    const y = yScale(t);
    out.push(
      `    <line x1="${fmt(baseX)}" y1="${fmt(y)}" x2="${fmt(baseX + 4)}" y2="${fmt(y)}" ` +
        `stroke="#333333" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX + 8)}" y="${fmt(y)}" text-anchor="start" ` +
        `dominant-baseline="middle">${t}</text>`,
    );
  }
  const midY = (yScale(countMin) + yScale(countMax)) / 2;
  out.push(
    `    <text x="${fmt(baseX + 48)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(90 ${fmt(baseX + 48)} ${fmt(midY)})">neurons / synapses</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderSeries(
  lineClass: string,
  pointClass: string,
  colour: string,
  samples: readonly MilestoneSample[],
  xScale: (v: number) => number,
  yScale: (s: MilestoneSample) => number,
): string {
  const points = samples.map((s) => `${fmt(xScale(s.generation))},${fmt(yScale(s))}`);
  const out: string[] = [];
  out.push(`  <g class="${lineClass}">`);
  out.push(
    `    <polyline fill="none" stroke="${colour}" stroke-width="1.5" ` +
      `points="${points.join(" ")}"/>`,
  );
  for (const s of samples) {
    out.push(
      `    <circle class="${pointClass}" cx="${fmt(xScale(s.generation))}" ` +
        `cy="${fmt(yScale(s))}" r="2.4" fill="${colour}"/>`,
    );
  }
  out.push(`  </g>`);
  return out.join("\n");
}

function renderLegend(plotX: number, plotY: number): string {
  const x = plotX + 12;
  const y = plotY + 12;
  const items: Array<[string, string]> = [
    [SCORE_COLOUR, "best score"],
    [STEPS_COLOUR, "mean episode steps"],
    [NEURONS_COLOUR, "neurons"],
    [SYNAPSES_COLOUR, "synapses"],
  ];
  const out: string[] = [];
  out.push(
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222222">`,
  );
  out.push(
    `    <rect x="${fmt(x - 6)}" y="${fmt(y - 10)}" width="160" height="72" ` +
      `fill="#ffffff" fill-opacity="0.85" stroke="#cccccc" stroke-width="0.5"/>`,
  );
  items.forEach(([colour, label], i) => {
    const itemY = y + i * 16;
    out.push(
      `    <line x1="${fmt(x)}" y1="${fmt(itemY)}" x2="${fmt(x + 18)}" y2="${fmt(itemY)}" ` +
        `stroke="${colour}" stroke-width="2"/>`,
    );
    out.push(
      `    <text x="${fmt(x + 24)}" y="${fmt(itemY + 4)}">${escapeText(label)}</text>`,
    );
  });
  out.push(`  </g>`);
  return out.join("\n");
}

function renderCaption(
  samples: readonly MilestoneSample[],
  width: number,
  height: number,
): string {
  const last = samples[samples.length - 1];
  const totalMs = samples.reduce((acc, s) => acc + s.generationWallClockMs, 0);
  const text = `final score ${formatScore(last.bestScore)} · ` +
    `${last.bestNeurons} neurons · ${last.bestSynapses} synapses · ` +
    `${totalMs} ms total`;
  return [
    `  <g class="caption" font-family="sans-serif" font-size="12" fill="#222222">`,
    `    <text x="${fmt(width / 2)}" y="${fmt(height - 6)}" text-anchor="middle">` +
    escapeText(text) + `</text>`,
    `  </g>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tick generation and number formatting
// ---------------------------------------------------------------------------

/**
 * Produce roughly `target` evenly spaced tick values across `[min, max]`.
 * When `integerOnly` is true (count axis), ticks are rounded to integers
 * and de-duplicated. When the range is degenerate the function returns
 * the single value as the only tick.
 */
function niceTicks(min: number, max: number, target: number, integerOnly: boolean): number[] {
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
 * themselves added when they are not already on a decade boundary.
 */
function logTicks(min: number, max: number): number[] {
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

function niceStep(raw: number): number {
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

/** Round a numeric coordinate to two decimal places for compact, deterministic output. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 100) / 100).toString();
}

/** Format a score value to a short, deterministic string. */
function formatScore(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 1000) / 1000).toString();
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
