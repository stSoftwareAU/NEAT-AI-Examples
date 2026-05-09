/**
 * Shared dual-axis SVG renderer for NEAT per-generation fitness histories.
 *
 * Plots two series against generation index:
 *
 *   - best fitness on the left Y axis,
 *   - average (population mean) fitness on the right Y axis,
 *   - generation index along the X axis.
 *
 * The renderer is pure string emission — no DOM, no extra dependencies —
 * matching the convention of {@link ./evolution_chart.ts}. Output is
 * byte-identical for identical inputs.
 */

/** A single per-generation fitness sample. */
export interface FitnessSample {
  /** Zero-based generation index. */
  generation: number;
  /** Best fitness in this generation. */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  avgFitness: number;
}

/** Options controlling {@link renderFitnessChartSVG}. */
export interface RenderFitnessChartOptions {
  /** Total SVG width in user units. Default 800. */
  width?: number;
  /** Total SVG height in user units. Default 400. */
  height?: number;
  /** Chart title rendered at the top. Default "NEAT Fitness". */
  title?: string;
  /** Label for the best-fitness series. Default "best fitness". */
  bestLabel?: string;
  /** Label for the average-fitness series. Default "avg fitness". */
  avgLabel?: string;
  /**
   * Maximum number of samples to plot. When the input exceeds this size
   * the series is uniformly down-sampled, with the first and last
   * samples always preserved. Default 500.
   */
  maxSamples?: number;
}

/** Stroke colour for the best-fitness line (left axis). */
const BEST_COLOUR = "#1f77b4";
/** Stroke colour for the average-fitness line (right axis). */
const AVG_COLOUR = "#ff7f0e";

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 400;
const DEFAULT_MAX_SAMPLES = 500;

/** Plot-area inset from the SVG edges, leaving room for axes and legend. */
const MARGIN = { top: 40, right: 70, bottom: 60, left: 70 } as const;

/**
 * Render the fitness history as a dual-axis SVG string.
 *
 * Throws if `samples` is empty — callers are expected to skip rendering
 * when no generations have been captured.
 */
export function renderFitnessChartSVG(
  samples: readonly FitnessSample[],
  options: RenderFitnessChartOptions = {},
): string {
  if (samples.length === 0) {
    throw new Error("renderFitnessChartSVG requires at least one sample");
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? "NEAT Fitness";
  const bestLabel = options.bestLabel ?? "best fitness";
  const avgLabel = options.avgLabel ?? "avg fitness";
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;

  const plotted = downsample(samples, maxSamples);

  const plotX = MARGIN.left;
  const plotY = MARGIN.top;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);

  const genMin = samples[0].generation;
  const genMax = samples[samples.length - 1].generation;

  const bestMin = minBy(samples, (s) => s.bestFitness);
  const bestMax = maxBy(samples, (s) => s.bestFitness);
  const avgMin = minBy(samples, (s) => s.avgFitness);
  const avgMax = maxBy(samples, (s) => s.avgFitness);

  const xScale = makeScale(genMin, genMax, plotX, plotX + plotW);
  const yBestScale = makeScale(bestMin, bestMax, plotY + plotH, plotY);
  const yAvgScale = makeScale(avgMin, avgMax, plotY + plotH, plotY);

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

  lines.push(renderXAxis(genMin, genMax, xScale, plotY + plotH));
  lines.push(renderLeftAxis(bestMin, bestMax, yBestScale, plotX, bestLabel));
  lines.push(renderRightAxis(avgMin, avgMax, yAvgScale, plotX + plotW, avgLabel));

  lines.push(
    renderSeries(
      "best-line",
      "best-point",
      BEST_COLOUR,
      plotted,
      xScale,
      (s) => yBestScale(s.bestFitness),
    ),
  );
  lines.push(
    renderSeries(
      "avg-line",
      "avg-point",
      AVG_COLOUR,
      plotted,
      xScale,
      (s) => yAvgScale(s.avgFitness),
    ),
  );

  lines.push(renderLegend(plotX, plotY, bestLabel, avgLabel));
  lines.push(
    renderFinalAnnotation(
      samples[samples.length - 1],
      xScale,
      yBestScale,
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
 * always preserving the first and last samples.
 */
function downsample(
  samples: readonly FitnessSample[],
  maxSamples: number,
): readonly FitnessSample[] {
  if (maxSamples < 2) maxSamples = 2;
  if (samples.length <= maxSamples) return samples;
  const out: FitnessSample[] = [];
  const last = samples.length - 1;
  for (let i = 0; i < maxSamples; i++) {
    const idx = Math.round((i * last) / (maxSamples - 1));
    out.push(samples[idx]);
  }
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
 * Linear scale mapping `[domainMin, domainMax]` onto
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
  const labelX = xScale((genMin + genMax) / 2);
  out.push(
    `    <text x="${fmt(labelX)}" y="${fmt(baseY + 36)}" text-anchor="middle" ` +
      `font-weight="bold">generation</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderLeftAxis(
  bestMin: number,
  bestMax: number,
  yScale: (v: number) => number,
  baseX: number,
  bestLabel: string,
): string {
  const ticks = niceTicks(bestMin, bestMax, 5, false);
  const out: string[] = [];
  out.push(
    `  <g class="left-axis" font-family="sans-serif" font-size="11" fill="${BEST_COLOUR}">`,
  );
  for (const t of ticks) {
    const y = yScale(t);
    out.push(
      `    <line x1="${fmt(baseX - 4)}" y1="${fmt(y)}" x2="${fmt(baseX)}" y2="${fmt(y)}" ` +
        `stroke="${BEST_COLOUR}" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX - 8)}" y="${fmt(y)}" text-anchor="end" ` +
        `dominant-baseline="middle">${formatScore(t)}</text>`,
    );
  }
  const midY = (yScale(bestMin) + yScale(bestMax)) / 2;
  out.push(
    `    <text x="${fmt(baseX - 48)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(-90 ${fmt(baseX - 48)} ${fmt(midY)})">${escapeText(bestLabel)}</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderRightAxis(
  avgMin: number,
  avgMax: number,
  yScale: (v: number) => number,
  baseX: number,
  avgLabel: string,
): string {
  const ticks = niceTicks(avgMin, avgMax, 5, false);
  const out: string[] = [];
  out.push(
    `  <g class="right-axis" font-family="sans-serif" font-size="11" fill="${AVG_COLOUR}">`,
  );
  for (const t of ticks) {
    const y = yScale(t);
    out.push(
      `    <line x1="${fmt(baseX)}" y1="${fmt(y)}" x2="${fmt(baseX + 4)}" y2="${fmt(y)}" ` +
        `stroke="${AVG_COLOUR}" stroke-width="1"/>`,
    );
    out.push(
      `    <text x="${fmt(baseX + 8)}" y="${fmt(y)}" text-anchor="start" ` +
        `dominant-baseline="middle">${formatScore(t)}</text>`,
    );
  }
  const midY = (yScale(avgMin) + yScale(avgMax)) / 2;
  out.push(
    `    <text x="${fmt(baseX + 48)}" y="${fmt(midY)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(90 ${fmt(baseX + 48)} ${fmt(midY)})">${escapeText(avgLabel)}</text>`,
  );
  out.push(`  </g>`);
  return out.join("\n");
}

function renderSeries(
  lineClass: string,
  pointClass: string,
  colour: string,
  samples: readonly FitnessSample[],
  xScale: (v: number) => number,
  yScale: (s: FitnessSample) => number,
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

function renderLegend(
  plotX: number,
  plotY: number,
  bestLabel: string,
  avgLabel: string,
): string {
  const x = plotX + 12;
  const y = plotY + 12;
  const items: Array<[string, string]> = [
    [BEST_COLOUR, bestLabel],
    [AVG_COLOUR, avgLabel],
  ];
  const out: string[] = [];
  out.push(
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222222">`,
  );
  out.push(
    `    <rect x="${fmt(x - 6)}" y="${fmt(y - 10)}" width="140" height="40" ` +
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
  last: FitnessSample,
  xScale: (v: number) => number,
  yBestScale: (v: number) => number,
  plotX: number,
  plotY: number,
  plotW: number,
): string {
  const cx = xScale(last.generation);
  const cy = yBestScale(last.bestFitness);
  const labelX = Math.min(cx - 8, plotX + plotW - 12);
  const labelY = Math.max(cy - 12, plotY + 12);
  const text = `gen ${last.generation}: best=${escapeText(formatScore(last.bestFitness))}, ` +
    `avg=${escapeText(formatScore(last.avgFitness))}`;
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

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 100) / 100).toString();
}

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
