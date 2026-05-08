/**
 * Shared dual-axis SVG renderer for NEAT evolution histories.
 *
 * Examples that capture per-generation snapshots reuse this helper to
 * produce a single static SVG that visualises:
 *
 *   - score on the left Y axis,
 *   - neuron and synapse counts as two distinct lines on the right Y axis,
 *   - generation index along the X axis,
 *   - a final-generation annotation describing the last sample.
 *
 * The renderer is pure string emission — no DOM, no extra dependencies —
 * matching the convention of the per-example svg.ts modules.
 *
 * Every sample is plotted unless `samples.length > maxSamples`, in which
 * case the series is uniformly down-sampled while always preserving the
 * first and last samples. Output is byte-identical for identical inputs.
 */

/** A single point in a NEAT evolution history. */
export interface EvolutionSample {
  /** Zero-based generation index. */
  generation: number;
  /** Best fitness score at this generation. */
  score: number;
  /** Neuron count of the best creature at this generation. */
  neurons: number;
  /** Synapse count of the best creature at this generation. */
  synapses: number;
}

/** Options controlling {@link renderEvolutionChartSVG}. */
export interface RenderEvolutionChartOptions {
  /** Total SVG width in user units. Default 800. */
  width?: number;
  /** Total SVG height in user units. Default 400. */
  height?: number;
  /** Chart title rendered at the top. Default "NEAT Evolution". */
  title?: string;
  /** Label for the score series. Default "score". */
  scoreLabel?: string;
  /**
   * Maximum number of samples to plot. When the input exceeds this size
   * the series is uniformly down-sampled to fit, with the first and last
   * samples always preserved. Default 500.
   */
  maxSamples?: number;
}

/** Stroke colour for the score line (left axis). */
const SCORE_COLOUR = "#1f77b4";
/** Stroke colour for the neuron-count line (right axis). */
const NEURONS_COLOUR = "#2ca02c";
/** Stroke colour for the synapse-count line (right axis). */
const SYNAPSES_COLOUR = "#d62728";

/** Default chart dimensions. */
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 400;
const DEFAULT_MAX_SAMPLES = 500;

/** Plot-area inset from the SVG edges, leaving room for axes and legend. */
const MARGIN = { top: 40, right: 70, bottom: 60, left: 70 } as const;

/**
 * Render the evolution history as a single dual-axis SVG string.
 *
 * Throws if `samples` is empty — callers are expected to skip rendering
 * when no generations have been captured.
 */
export function renderEvolutionChartSVG(
  samples: readonly EvolutionSample[],
  options: RenderEvolutionChartOptions = {},
): string {
  if (samples.length === 0) {
    throw new Error("renderEvolutionChartSVG requires at least one sample");
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? "NEAT Evolution";
  const scoreLabel = options.scoreLabel ?? "score";
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;

  const plotted = downsample(samples, maxSamples);

  const plotX = MARGIN.left;
  const plotY = MARGIN.top;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);

  // X axis maps generation index. Use the full input range so the
  // chart's X position remains meaningful even after down-sampling.
  const genMin = samples[0].generation;
  const genMax = samples[samples.length - 1].generation;

  const scoreMin = minBy(samples, (s) => s.score);
  const scoreMax = maxBy(samples, (s) => s.score);

  // Combined scale for neurons and synapses on the right axis so the two
  // lines share a common reference. Lower bound clamped to 0 — counts
  // are non-negative and a zero baseline reads more clearly.
  const countMax = Math.max(
    maxBy(samples, (s) => s.neurons),
    maxBy(samples, (s) => s.synapses),
  );
  const countMin = 0;

  const xScale = makeScale(genMin, genMax, plotX, plotX + plotW);
  const yScoreScale = makeScale(scoreMin, scoreMax, plotY + plotH, plotY);
  const yCountScale = makeScale(countMin, countMax, plotY + plotH, plotY);

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

  // Plot frame.
  lines.push(
    `  <rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" ` +
      `fill="#ffffff" stroke="#333333" stroke-width="1"/>`,
  );

  lines.push(renderXAxis(genMin, genMax, xScale, plotY + plotH));
  lines.push(renderLeftAxis(scoreMin, scoreMax, yScoreScale, plotX, scoreLabel));
  lines.push(renderRightAxis(countMin, countMax, yCountScale, plotX + plotW));

  // Series — score on left axis, neurons + synapses on right axis.
  lines.push(
    renderSeries(
      "score-line",
      "score-point",
      SCORE_COLOUR,
      plotted,
      xScale,
      (s) => yScoreScale(s.score),
    ),
  );
  lines.push(
    renderSeries(
      "neurons-line",
      "neurons-point",
      NEURONS_COLOUR,
      plotted,
      xScale,
      (s) => yCountScale(s.neurons),
    ),
  );
  lines.push(
    renderSeries(
      "synapses-line",
      "synapses-point",
      SYNAPSES_COLOUR,
      plotted,
      xScale,
      (s) => yCountScale(s.synapses),
    ),
  );

  lines.push(renderLegend(plotX, plotY, scoreLabel));
  lines.push(
    renderFinalAnnotation(
      samples[samples.length - 1],
      xScale,
      yScoreScale,
      plotX,
      plotY,
      plotW,
    ),
  );

  lines.push(`</svg>`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Down-sampling
// ---------------------------------------------------------------------------

/**
 * Uniformly down-sample `samples` to at most `maxSamples` points while
 * always preserving the first and last samples exactly. When the input
 * already fits, returns the array as-is (cast to a fresh readonly view).
 */
function downsample(
  samples: readonly EvolutionSample[],
  maxSamples: number,
): readonly EvolutionSample[] {
  if (maxSamples < 2) {
    // Always preserve at least the first and last; ignore unhelpful caps.
    maxSamples = 2;
  }
  if (samples.length <= maxSamples) {
    return samples;
  }
  const out: EvolutionSample[] = [];
  // Pick `maxSamples` evenly spaced indices across [0, last]. Using
  // integer rounding keeps the choice deterministic for identical input.
  const last = samples.length - 1;
  for (let i = 0; i < maxSamples; i++) {
    const idx = Math.round((i * last) / (maxSamples - 1));
    out.push(samples[idx]);
  }
  // Belt-and-braces: ensure first and last are exactly preserved even
  // under any future rounding change.
  out[0] = samples[0];
  out[out.length - 1] = samples[last];
  return out;
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
 * `[rangeMin, rangeMax]`. When the domain is degenerate (min === max) the
 * scale collapses to the centre of the range, avoiding divide-by-zero.
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

// ---------------------------------------------------------------------------
// Axis and series rendering
// ---------------------------------------------------------------------------

function renderXAxis(
  genMin: number,
  genMax: number,
  xScale: (v: number) => number,
  baseY: number,
): string {
  const ticks = niceTicks(genMin, genMax, 8, true);
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
  // Axis label.
  const labelX = xScale((genMin + genMax) / 2);
  out.push(
    `    <text x="${fmt(labelX)}" y="${fmt(baseY + 36)}" text-anchor="middle" ` +
      `font-weight="bold">generation</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderLeftAxis(
  scoreMin: number,
  scoreMax: number,
  yScale: (v: number) => number,
  baseX: number,
  scoreLabel: string,
): string {
  const ticks = niceTicks(scoreMin, scoreMax, 5, false);
  const out: string[] = [];
  out.push(
    `  <g class="left-axis" font-family="sans-serif" font-size="11" fill="${SCORE_COLOUR}">`,
  );
  for (const t of ticks) {
    const y = yScale(t);
    out.push(
      `    <line x1="${fmt(baseX - 4)}" y1="${fmt(y)}" x2="${fmt(baseX)}" y2="${fmt(y)}" ` +
        `stroke="${SCORE_COLOUR}" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX - 8)}" y="${fmt(y)}" text-anchor="end" ` +
        `dominant-baseline="middle">${formatScore(t)}</text>`,
    );
  }
  const midY = (yScale(scoreMin) + yScale(scoreMax)) / 2;
  out.push(
    `    <text x="${fmt(baseX - 48)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(-90 ${fmt(baseX - 48)} ${fmt(midY)})">${escapeText(scoreLabel)}</text>`,
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
  samples: readonly EvolutionSample[],
  xScale: (v: number) => number,
  yScale: (s: EvolutionSample) => number,
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
        `cy="${fmt(yScale(s))}" r="1.8" fill="${colour}"/>`,
    );
  }
  out.push(`  </g>`);
  return out.join("\n");
}

function renderLegend(plotX: number, plotY: number, scoreLabel: string): string {
  const x = plotX + 12;
  const y = plotY + 12;
  const items: Array<[string, string]> = [
    [SCORE_COLOUR, scoreLabel],
    [NEURONS_COLOUR, "neurons"],
    [SYNAPSES_COLOUR, "synapses"],
  ];
  const out: string[] = [];
  out.push(
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222222">`,
  );
  out.push(
    `    <rect x="${fmt(x - 6)}" y="${fmt(y - 10)}" width="130" height="56" ` +
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

function renderFinalAnnotation(
  last: EvolutionSample,
  xScale: (v: number) => number,
  yScoreScale: (v: number) => number,
  plotX: number,
  plotY: number,
  plotW: number,
): string {
  const cx = xScale(last.generation);
  const cy = yScoreScale(last.score);
  // Place the label inside the plot, biased upper-left of the point so
  // it does not overflow the right edge.
  const labelX = Math.min(cx - 8, plotX + plotW - 12);
  const labelY = Math.max(cy - 12, plotY + 12);
  const text = `gen ${last.generation}: ${escapeText(formatScore(last.score))}, ` +
    `${last.neurons} neurons, ${last.synapses} synapses`;
  return [
    `  <g class="final-annotation" font-family="sans-serif" font-size="12" fill="#222222">`,
    `    <line x1="${fmt(cx)}" y1="${fmt(cy)}" x2="${fmt(labelX)}" y2="${fmt(labelY)}" ` +
    `stroke="#666666" stroke-width="0.8" stroke-dasharray="2,2"/>`,
    `    <circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="3.5" fill="#222222"/>`,
    `    <text x="${fmt(labelX)}" y="${fmt(labelY)}" text-anchor="end">${text}</text>`,
    `  </g>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tick generation and number formatting
// ---------------------------------------------------------------------------

/**
 * Produce roughly `target` evenly spaced tick values across `[min, max]`.
 * When `integerOnly` is true (X axis, count axis), ticks are rounded to
 * integers and de-duplicated. When the range is degenerate the function
 * returns the single value as the only tick.
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
    if (integerOnly) {
      out.push(Math.round(v));
    } else {
      out.push(v);
    }
  }
  if (out.length === 0) out.push(integerOnly ? Math.round(min) : min);
  // Always include the final value so the right edge is labelled.
  const lastTick = integerOnly ? Math.round(max) : max;
  if (out[out.length - 1] !== lastTick) out.push(lastTick);
  return integerOnly ? Array.from(new Set(out)) : out;
}

/** Round a step size to a "nice" 1/2/5 × 10^k multiple. */
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
  // Three decimals is plenty for fitness scores while remaining stable
  // across runs.
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
