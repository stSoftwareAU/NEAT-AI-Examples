/**
 * SVG rendering helpers for the memetic evolution demo.
 *
 * Produces a single-axis line chart with two fitness curves overlaid:
 *
 * - **Blue** memetic fitness curve.
 * - **Grey** control fitness curve.
 * - **Green** vertical markers at the generations where memetic seeds
 *   were applied.
 *
 * The X axis is the generation number; the Y axis is the best
 * **true** fitness across the population (full-dataset MSE rather
 * than the noisy mini-batch).
 */
import type { EvolutionRow, FitnessRecord } from "./memetic_evolution.ts";

/** CSS class assigned to the best-fitness polyline in the fitness chart. */
export const FITNESS_CURVE_CLASS = "best-fitness";

/** CSS class assigned to the neuron-count polyline in the topology chart. */
export const NEURON_CURVE_CLASS = "neuron-count";

/** CSS class assigned to the synapse-count polyline in the topology chart. */
export const SYNAPSE_CURVE_CLASS = "synapse-count";

/** Width (in SVG user units) of the rendered chart. */
export const PLOT_WIDTH = 880;

/** Height (in SVG user units) of the rendered chart. */
export const PLOT_HEIGHT = 440;

/** CSS class assigned to each memetic seeding marker line. */
export const SEEDING_MARKER_CLASS = "seeding-marker";

/** CSS class assigned to the memetic fitness polyline. */
export const MEMETIC_CURVE_CLASS = "memetic-curve";

/** CSS class assigned to the control fitness polyline. */
export const CONTROL_CURVE_CLASS = "control-curve";

const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 64;
const MARGIN_LEFT = 80;
const MARGIN_RIGHT = 32;
const INNER_WIDTH = PLOT_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const INNER_HEIGHT = PLOT_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

/** Inputs to {@link renderMemeticSVG}. */
export interface RenderMemeticOptions {
  /** Memetic fitness records (one per generation). */
  memetic: readonly FitnessRecord[];
  /** Control fitness records (one per generation, same length as memetic). */
  control: readonly FitnessRecord[];
  /** Generations at which memetic seeding was applied. */
  seedingGenerations: readonly number[];
}

/**
 * Render the dual-curve fitness comparison as an SVG string. The
 * memetic curve is drawn on top so it remains visible when the two
 * curves overlap.
 */
export function renderMemeticSVG(options: RenderMemeticOptions): string {
  const { memetic, control, seedingGenerations } = options;
  if (memetic.length === 0 || control.length === 0) {
    throw new Error("memetic and control records must be non-empty");
  }
  if (memetic.length !== control.length) {
    throw new Error(
      `memetic (${memetic.length}) and control (${control.length}) must have equal length`,
    );
  }

  const totalGenerations = memetic.length;
  const xScale = (gen: number) =>
    MARGIN_LEFT + (gen / Math.max(1, totalGenerations - 1)) * INNER_WIDTH;

  const allFitness = [...memetic, ...control].map((r) => r.bestFitness);
  const yMinRaw = Math.min(...allFitness);
  const yMaxRaw = Math.max(...allFitness);
  const span = yMaxRaw - yMinRaw || 1;
  const yMin = yMinRaw - span * 0.05;
  const yMax = yMaxRaw + span * 0.05;
  const ySpan = yMax - yMin || 1;
  const yScale = (fitness: number) => {
    const norm = (fitness - yMin) / ySpan;
    return MARGIN_TOP + (1 - norm) * INNER_HEIGHT;
  };

  const memeticPoints = memetic
    .map((r) => `${xScale(r.generation).toFixed(2)},${yScale(r.bestFitness).toFixed(2)}`)
    .join(" ");
  const controlPoints = control
    .map((r) => `${xScale(r.generation).toFixed(2)},${yScale(r.bestFitness).toFixed(2)}`)
    .join(" ");

  const seedingMarkers = seedingGenerations
    .map((gen) => {
      const x = xScale(gen);
      return [
        `    <line class="${SEEDING_MARKER_CLASS}" x1="${x.toFixed(2)}" ` +
        `y1="${MARGIN_TOP.toFixed(2)}" x2="${x.toFixed(2)}" ` +
        `y2="${(MARGIN_TOP + INNER_HEIGHT).toFixed(2)}" ` +
        `stroke="#16a085" stroke-width="1" stroke-dasharray="4 3" opacity="0.55"/>`,
      ].join("\n");
    })
    .join("\n");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="Memetic vs control fitness curves">`,
    `  <title>Memetic Evolution — Seeding From the Fittest Archive</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="28" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
    `Memetic Evolution — Seeding From the Fittest Archive</text>`,
    `  <g class="plot-frame" font-family="sans-serif">`,
    `    <rect x="${MARGIN_LEFT}" y="${MARGIN_TOP}" width="${INNER_WIDTH}" ` +
    `height="${INNER_HEIGHT}" fill="#ffffff" stroke="#333" stroke-width="1"/>`,
    `  </g>`,
    renderYTicks(yMin, yMax),
    renderXTicks(totalGenerations, xScale),
    seedingMarkers,
    `  <polyline class="${CONTROL_CURVE_CLASS}" fill="none" stroke="#7f8c8d" ` +
    `stroke-width="1.6" points="${controlPoints}"/>`,
    `  <polyline class="${MEMETIC_CURVE_CLASS}" fill="none" stroke="#2e86de" ` +
    `stroke-width="2" points="${memeticPoints}"/>`,
    renderAxisLabels(),
    renderLegend(),
    `</svg>`,
    "",
  ].join("\n");
}

function renderYTicks(yMin: number, yMax: number): string {
  const ticks = 5;
  const lines: string[] = [`  <g class="ticks-y" font-family="sans-serif">`];
  for (let i = 0; i < ticks; i++) {
    const t = i / (ticks - 1);
    const fitness = yMin + t * (yMax - yMin);
    const norm = (fitness - yMin) / (yMax - yMin || 1);
    const y = MARGIN_TOP + (1 - norm) * INNER_HEIGHT;
    lines.push(
      `    <line x1="${MARGIN_LEFT.toFixed(2)}" y1="${y.toFixed(2)}" ` +
        `x2="${(MARGIN_LEFT - 5).toFixed(2)}" y2="${y.toFixed(2)}" ` +
        `stroke="#333" stroke-width="1"/>`,
    );
    lines.push(
      `    <text x="${(MARGIN_LEFT - 8).toFixed(2)}" y="${(y + 4).toFixed(2)}" ` +
        `text-anchor="end" font-size="11" fill="#333">${fitness.toFixed(3)}</text>`,
    );
  }
  lines.push(`  </g>`);
  return lines.join("\n");
}

function renderXTicks(totalGenerations: number, xScale: (gen: number) => number): string {
  const ticks = 6;
  const lines: string[] = [`  <g class="ticks-x" font-family="sans-serif">`];
  for (let i = 0; i < ticks; i++) {
    const t = i / (ticks - 1);
    const gen = Math.round(t * (totalGenerations - 1));
    const x = xScale(gen);
    lines.push(
      `    <line x1="${x.toFixed(2)}" y1="${(MARGIN_TOP + INNER_HEIGHT).toFixed(2)}" ` +
        `x2="${x.toFixed(2)}" y2="${(MARGIN_TOP + INNER_HEIGHT + 5).toFixed(2)}" ` +
        `stroke="#333" stroke-width="1"/>`,
    );
    lines.push(
      `    <text x="${x.toFixed(2)}" y="${(MARGIN_TOP + INNER_HEIGHT + 20).toFixed(2)}" ` +
        `text-anchor="middle" font-size="11" fill="#333">${gen}</text>`,
    );
  }
  lines.push(`  </g>`);
  return lines.join("\n");
}

function renderAxisLabels(): string {
  const baseY = MARGIN_TOP + INNER_HEIGHT;
  const xMid = MARGIN_LEFT + INNER_WIDTH / 2;
  return [
    `  <g class="axis-labels" font-family="sans-serif" font-size="12" fill="#333">`,
    `    <text x="${xMid}" y="${baseY + 44}" text-anchor="middle">generation</text>`,
    `    <text x="${MARGIN_LEFT - 56}" y="${MARGIN_TOP + INNER_HEIGHT / 2}" ` +
    `text-anchor="middle" dominant-baseline="middle" ` +
    `transform="rotate(-90 ${MARGIN_LEFT - 56} ${MARGIN_TOP + INNER_HEIGHT / 2})">` +
    `best true fitness (-MSE)</text>`,
    `  </g>`,
  ].join("\n");
}

function renderLegend(): string {
  const x = MARGIN_LEFT + INNER_WIDTH - 240;
  const y = MARGIN_TOP + 12;
  return [
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#333">`,
    `    <rect x="${x - 6}" y="${y - 12}" width="232" height="60" ` +
    `fill="#ffffff" fill-opacity="0.9" stroke="#cccccc" stroke-width="0.5"/>`,
    `    <line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" stroke="#2e86de" stroke-width="2"/>`,
    `    <text x="${x + 28}" y="${y + 4}">memetic (with archive seeding)</text>`,
    `    <line x1="${x}" y1="${y + 16}" x2="${x + 22}" y2="${y + 16}" ` +
    `stroke="#7f8c8d" stroke-width="1.6"/>`,
    `    <text x="${x + 28}" y="${y + 20}">control (no seeding)</text>`,
    `    <line x1="${x}" y1="${y + 32}" x2="${x + 22}" y2="${y + 32}" ` +
    `stroke="#16a085" stroke-width="1" stroke-dasharray="4 3" opacity="0.55"/>`,
    `    <text x="${x + 28}" y="${y + 36}">memetic seeding generation</text>`,
    `  </g>`,
  ].join("\n");
}

const TELEMETRY_SVG_WIDTH = 720;
const TELEMETRY_SVG_HEIGHT = 320;
const TELEMETRY_MARGIN = { top: 36, right: 70, bottom: 44, left: 60 };

interface ChartPoint {
  x: number;
  y: number;
}

function buildChartPolyline(points: readonly ChartPoint[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

/**
 * Render a two-line chart: best fitness (blue) and mean fitness
 * (orange) versus generation. Throws if `rows` is empty.
 */
export function renderFitnessChartSvg(rows: readonly EvolutionRow[]): string {
  if (rows.length === 0) {
    throw new Error("renderFitnessChartSvg requires at least one row");
  }
  const innerW = TELEMETRY_SVG_WIDTH - TELEMETRY_MARGIN.left - TELEMETRY_MARGIN.right;
  const innerH = TELEMETRY_SVG_HEIGHT - TELEMETRY_MARGIN.top - TELEMETRY_MARGIN.bottom;
  const innerX = TELEMETRY_MARGIN.left;
  const innerY = TELEMETRY_MARGIN.top;

  const minGen = rows[0].generation;
  const maxGen = rows[rows.length - 1].generation;
  const genSpan = Math.max(1, maxGen - minGen);

  const allFitness = rows.flatMap((r) => [r.bestFitness, r.meanFitness]).filter(
    Number.isFinite,
  );
  const minF = allFitness.length > 0 ? Math.min(...allFitness) : 0;
  const maxF = allFitness.length > 0 ? Math.max(...allFitness) : 1;
  const fSpan = (maxF - minF) || 1;

  const xScale = (g: number) => innerX + ((g - minGen) / genSpan) * innerW;
  const yScale = (f: number) => innerY + innerH - ((f - minF) / fSpan) * innerH;
  const safeY = (f: number): number => Number.isFinite(f) ? yScale(f) : (innerY + innerH);

  const bestPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: safeY(r.bestFitness),
  }));
  const meanPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: safeY(r.meanFitness),
  }));

  const yTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const v = minF + t * fSpan;
    const ty = innerY + innerH - t * innerH;
    yTicks.push(
      `    <line x1="${innerX.toFixed(2)}" y1="${ty.toFixed(2)}" ` +
        `x2="${(innerX + innerW).toFixed(2)}" y2="${ty.toFixed(2)}" ` +
        `stroke="#eeeeee" stroke-width="0.6"/>`,
      `    <text x="${(innerX - 6).toFixed(2)}" y="${(ty + 3.5).toFixed(2)}" ` +
        `text-anchor="end" font-family="sans-serif" font-size="10" fill="#444">` +
        `${v.toFixed(3)}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TELEMETRY_SVG_WIDTH} ${TELEMETRY_SVG_HEIGHT}" ` +
    `width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" role="img" ` +
    `aria-label="Memetic evolution — best vs mean fitness per generation">`,
    `  <title>Memetic Evolution — Best vs Mean Fitness</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Memetic Evolution — Best vs Mean Fitness</text>`,
    yTicks.join("\n"),
    `  <polyline class="${FITNESS_CURVE_CLASS}" fill="none" stroke="#1f77b4" stroke-width="2" ` +
    `points="${buildChartPolyline(bestPts)}"/>`,
    `  <polyline class="mean-fitness" fill="none" stroke="#ff7f0e" stroke-width="1.4" ` +
    `stroke-dasharray="4 3" points="${buildChartPolyline(meanPts)}"/>`,
    `  <text x="${innerX.toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `font-family="sans-serif" font-size="11" fill="#333">gen ${minGen}</text>`,
    `  <text x="${(innerX + innerW).toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `text-anchor="end" font-family="sans-serif" font-size="11" fill="#333">gen ${maxGen}</text>`,
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222">`,
    `    <rect x="${(innerX + innerW - 178).toFixed(2)}" y="${(innerY + 6).toFixed(2)}" ` +
    `width="172" height="44" fill="#ffffff" fill-opacity="0.9" stroke="#cccccc"/>`,
    `    <line x1="${(innerX + innerW - 168).toFixed(2)}" y1="${(innerY + 18).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 144).toFixed(2)}" y2="${(innerY + 18).toFixed(2)}" ` +
    `stroke="#1f77b4" stroke-width="2"/>`,
    `    <text x="${(innerX + innerW - 138).toFixed(2)}" y="${(innerY + 21).toFixed(2)}">` +
    `best fitness</text>`,
    `    <line x1="${(innerX + innerW - 168).toFixed(2)}" y1="${(innerY + 36).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 144).toFixed(2)}" y2="${(innerY + 36).toFixed(2)}" ` +
    `stroke="#ff7f0e" stroke-width="1.4" stroke-dasharray="4 3"/>`,
    `    <text x="${(innerX + innerW - 138).toFixed(2)}" y="${(innerY + 39).toFixed(2)}">` +
    `mean fitness</text>`,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}

/**
 * Render the neuron / synapse count chart for the README. Two lines
 * share an X axis; the right Y axis shows synapse counts on a separate
 * scale so the synapse line does not compress the neuron line into
 * invisibility.
 */
export function renderTopologyChartSvg(rows: readonly EvolutionRow[]): string {
  if (rows.length === 0) {
    throw new Error("renderTopologyChartSvg requires at least one row");
  }
  const innerW = TELEMETRY_SVG_WIDTH - TELEMETRY_MARGIN.left - TELEMETRY_MARGIN.right;
  const innerH = TELEMETRY_SVG_HEIGHT - TELEMETRY_MARGIN.top - TELEMETRY_MARGIN.bottom;
  const innerX = TELEMETRY_MARGIN.left;
  const innerY = TELEMETRY_MARGIN.top;

  const minGen = rows[0].generation;
  const maxGen = rows[rows.length - 1].generation;
  const genSpan = Math.max(1, maxGen - minGen);

  const neurons = rows.map((r) => r.neuronCount);
  const synapses = rows.map((r) => r.synapseCount);
  const maxNeurons = Math.max(...neurons, 1);
  const maxSynapses = Math.max(...synapses, 1);

  const xScale = (g: number) => innerX + ((g - minGen) / genSpan) * innerW;
  const neuronY = (n: number) => innerY + innerH - (n / maxNeurons) * innerH;
  const synapseY = (s: number) => innerY + innerH - (s / maxSynapses) * innerH;

  const neuronPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: neuronY(r.neuronCount),
  }));
  const synapsePts = rows.map((r) => ({
    x: xScale(r.generation),
    y: synapseY(r.synapseCount),
  }));

  const leftTicks: string[] = [];
  const rightTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const ly = innerY + innerH - t * innerH;
    leftTicks.push(
      `    <text x="${(innerX - 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="end" font-family="sans-serif" font-size="10" fill="#2ca02c">` +
        `${(t * maxNeurons).toFixed(0)}</text>`,
    );
    rightTicks.push(
      `    <text x="${(innerX + innerW + 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="start" font-family="sans-serif" font-size="10" fill="#d62728">` +
        `${(t * maxSynapses).toFixed(0)}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TELEMETRY_SVG_WIDTH} ${TELEMETRY_SVG_HEIGHT}" ` +
    `width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" role="img" ` +
    `aria-label="Memetic evolution — neuron and synapse counts per generation">`,
    `  <title>Memetic Evolution — Topology Growth</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Memetic Evolution — Topology Growth</text>`,
    leftTicks.join("\n"),
    rightTicks.join("\n"),
    `  <polyline class="${NEURON_CURVE_CLASS}" fill="none" stroke="#2ca02c" stroke-width="2" ` +
    `points="${buildChartPolyline(neuronPts)}"/>`,
    `  <polyline class="${SYNAPSE_CURVE_CLASS}" fill="none" stroke="#d62728" stroke-width="2" ` +
    `stroke-dasharray="6 3" points="${buildChartPolyline(synapsePts)}"/>`,
    `  <text x="${innerX.toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `font-family="sans-serif" font-size="11" fill="#333">gen ${minGen}</text>`,
    `  <text x="${(innerX + innerW).toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `text-anchor="end" font-family="sans-serif" font-size="11" fill="#333">gen ${maxGen}</text>`,
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222">`,
    `    <rect x="${(innerX + innerW - 198).toFixed(2)}" y="${(innerY + 6).toFixed(2)}" ` +
    `width="190" height="44" fill="#ffffff" fill-opacity="0.9" stroke="#cccccc"/>`,
    `    <line x1="${(innerX + innerW - 188).toFixed(2)}" y1="${(innerY + 18).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 164).toFixed(2)}" y2="${(innerY + 18).toFixed(2)}" ` +
    `stroke="#2ca02c" stroke-width="2"/>`,
    `    <text x="${(innerX + innerW - 158).toFixed(2)}" y="${(innerY + 21).toFixed(2)}">` +
    `neurons (left axis)</text>`,
    `    <line x1="${(innerX + innerW - 188).toFixed(2)}" y1="${(innerY + 36).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 164).toFixed(2)}" y2="${(innerY + 36).toFixed(2)}" ` +
    `stroke="#d62728" stroke-width="2" stroke-dasharray="6 3"/>`,
    `    <text x="${(innerX + innerW - 158).toFixed(2)}" y="${(innerY + 39).toFixed(2)}">` +
    `synapses (right axis)</text>`,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}
