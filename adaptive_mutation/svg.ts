/**
 * SVG rendering helpers for the adaptive mutation rate demo (audit #212).
 *
 * Three renderers:
 *
 * - {@link renderAdaptiveMutationSVG} — the headline SVG embedded at the
 *   top of the README. A combined chart that overlays the **measured**
 *   neuron / synapse trajectory from the latest run with the
 *   **analytic** topology-mutation probability curve, demonstrating
 *   how the adaptive policy tapers structural growth as size rises.
 * - {@link renderFitnessChartSvg} — best vs mean fitness per
 *   generation (#212 acceptance criterion).
 * - {@link renderTopologyChartSvg} — neuron and synapse counts per
 *   generation (#212 acceptance criterion).
 */
import {
  DEFAULT_POLICY_CONFIG,
  type EvolutionRow,
  topologyProbability,
} from "./adaptive_mutation.ts";

/** CSS class assigned to the topology-policy curve. */
export const TOPOLOGY_CURVE_CLASS = "topology-rate";

/** CSS class assigned to the measured size curve. */
export const SIZE_CURVE_CLASS = "size-curve";

/** CSS class assigned to the fitness-curve polyline. */
export const FITNESS_CURVE_CLASS = "best-fitness";

/** CSS class assigned to the neuron-count polyline. */
export const NEURON_CURVE_CLASS = "neuron-count";

/** CSS class assigned to the synapse-count polyline. */
export const SYNAPSE_CURVE_CLASS = "synapse-count";

/** Inputs to {@link renderAdaptiveMutationSVG}. */
export interface RenderAdaptiveMutationOptions {
  /** Per-generation telemetry rows. */
  rows: readonly EvolutionRow[];
  /** Held-out score quoted in the caption. */
  heldOutScore: number;
  /** Wall-clock duration of the run, in milliseconds. */
  wallClockMs: number;
  /** Total generations evolved. */
  generations: number;
  /** True when the run reached `targetError`. */
  solved: boolean;
}

const HEADLINE_WIDTH = 960;
const HEADLINE_HEIGHT = 460;
const HEADLINE_MARGIN = { top: 70, right: 80, bottom: 80, left: 70 };

interface Point {
  x: number;
  y: number;
}

function buildPolyline(points: readonly Point[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

/**
 * Render the headline two-axis chart. The left Y axis shows the
 * **measured** creature size (neurons + synapses) per generation; the
 * right Y axis shows the **analytic** topology-mutation probability
 * curve `p(topology) = base / (1 + size / scale)` evaluated against
 * each generation's measured size. The two curves should diverge: the
 * size curve climbs as NEAT grows the network, and the policy curve
 * collapses toward zero as a result.
 */
export function renderAdaptiveMutationSVG(
  options: RenderAdaptiveMutationOptions,
): string {
  const { rows, heldOutScore, wallClockMs, generations, solved } = options;
  if (rows.length === 0) {
    throw new Error("renderAdaptiveMutationSVG requires at least one row");
  }

  const innerW = HEADLINE_WIDTH - HEADLINE_MARGIN.left - HEADLINE_MARGIN.right;
  const innerH = HEADLINE_HEIGHT - HEADLINE_MARGIN.top - HEADLINE_MARGIN.bottom;
  const innerX = HEADLINE_MARGIN.left;
  const innerY = HEADLINE_MARGIN.top;

  const minGen = rows[0].generation;
  const maxGen = rows[rows.length - 1].generation;
  const genSpan = Math.max(1, maxGen - minGen);

  const sizes = rows.map((r) => r.neuronCount + r.synapseCount);
  const maxSize = Math.max(...sizes, 1);
  const policyValues = sizes.map((s) => topologyProbability(s, DEFAULT_POLICY_CONFIG));
  const maxPolicy = Math.max(DEFAULT_POLICY_CONFIG.baseTopologyProb, ...policyValues);

  const xScale = (g: number) => innerX + ((g - minGen) / genSpan) * innerW;
  const sizeY = (s: number) => innerY + innerH - (s / maxSize) * innerH;
  const policyY = (p: number) => innerY + innerH - (p / maxPolicy) * innerH;

  const sizePts = rows.map((r, i) => ({
    x: xScale(r.generation),
    y: sizeY(sizes[i]),
  }));
  const policyPts = rows.map((r, i) => ({
    x: xScale(r.generation),
    y: policyY(policyValues[i]),
  }));

  const leftTicks: string[] = [];
  const rightTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const ly = innerY + innerH - t * innerH;
    leftTicks.push(
      `    <line x1="${innerX.toFixed(2)}" y1="${ly.toFixed(2)}" ` +
        `x2="${(innerX + innerW).toFixed(2)}" y2="${ly.toFixed(2)}" ` +
        `stroke="#eeeeee" stroke-width="0.6"/>`,
      `    <text x="${(innerX - 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="end" font-family="sans-serif" font-size="10" fill="#2ca02c">` +
        `${(t * maxSize).toFixed(0)}</text>`,
    );
    rightTicks.push(
      `    <text x="${(innerX + innerW + 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="start" font-family="sans-serif" font-size="10" fill="#e67e22">` +
        `${(t * maxPolicy).toFixed(2)}</text>`,
    );
  }

  const seconds = (wallClockMs / 1000).toFixed(1);
  const captionLines = [
    `Generations: ${generations}` + (solved ? " (solved)" : ""),
    `Wall-clock: ${seconds}s`,
    `Held-out -MSE: ${heldOutScore.toFixed(4)}`,
  ];

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${HEADLINE_WIDTH} ${HEADLINE_HEIGHT}" ` +
      `width="${HEADLINE_WIDTH}" height="${HEADLINE_HEIGHT}" role="img" ` +
      `aria-label="Adaptive mutation rate — measured topology vs analytic policy curve">`,
  );
  lines.push(`  <title>Adaptive Mutation Rate — Policy in Action</title>`);
  lines.push(`  <rect width="${HEADLINE_WIDTH}" height="${HEADLINE_HEIGHT}" fill="#fafafa"/>`);
  lines.push(
    `  <text x="${HEADLINE_WIDTH / 2}" y="28" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
      `Adaptive Mutation Rate — Topology Growth vs Policy Curve</text>`,
  );
  lines.push(
    `  <text x="${HEADLINE_WIDTH / 2}" y="48" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="11" fill="#555">` +
      `Measured size (neurons+synapses) climbs while the analytic ` +
      `p(topology) collapses toward zero.</text>`,
  );
  lines.push(leftTicks.join("\n"));
  lines.push(rightTicks.join("\n"));
  // Axis labels.
  lines.push(
    `  <text x="${(innerX - 46).toFixed(2)}" y="${(innerY + innerH / 2).toFixed(2)}" ` +
      `text-anchor="middle" dominant-baseline="middle" ` +
      `transform="rotate(-90 ${(innerX - 46).toFixed(2)} ${(innerY + innerH / 2).toFixed(2)})" ` +
      `font-family="sans-serif" font-size="11" fill="#2ca02c">size (neurons + synapses)</text>`,
  );
  lines.push(
    `  <text x="${(innerX + innerW + 50).toFixed(2)}" y="${(innerY + innerH / 2).toFixed(2)}" ` +
      `text-anchor="middle" dominant-baseline="middle" ` +
      `transform="rotate(90 ${(innerX + innerW + 50).toFixed(2)} ${
        (innerY + innerH / 2).toFixed(2)
      })" ` +
      `font-family="sans-serif" font-size="11" fill="#e67e22">p(topology mutation)</text>`,
  );
  // Curves.
  lines.push(
    `  <polyline class="${SIZE_CURVE_CLASS}" fill="none" stroke="#2ca02c" stroke-width="2" ` +
      `points="${buildPolyline(sizePts)}"/>`,
  );
  lines.push(
    `  <polyline class="${TOPOLOGY_CURVE_CLASS}" fill="none" stroke="#e67e22" stroke-width="2" ` +
      `stroke-dasharray="6 3" points="${buildPolyline(policyPts)}"/>`,
  );
  // Generation axis labels.
  lines.push(
    `  <text x="${innerX.toFixed(2)}" y="${(innerY + innerH + 26).toFixed(2)}" ` +
      `font-family="sans-serif" font-size="11" fill="#333">gen ${minGen}</text>`,
  );
  lines.push(
    `  <text x="${(innerX + innerW).toFixed(2)}" y="${(innerY + innerH + 26).toFixed(2)}" ` +
      `text-anchor="end" font-family="sans-serif" font-size="11" fill="#333">gen ${maxGen}</text>`,
  );
  // Caption box.
  const captionX = innerX + 12;
  const captionY = innerY + 12;
  lines.push(
    `  <rect x="${captionX.toFixed(2)}" y="${captionY.toFixed(2)}" width="200" height="56" ` +
      `fill="#ffffff" fill-opacity="0.92" stroke="#cccccc"/>`,
  );
  for (let i = 0; i < captionLines.length; i++) {
    lines.push(
      `  <text x="${(captionX + 8).toFixed(2)}" y="${(captionY + 16 + i * 14).toFixed(2)}" ` +
        `font-family="sans-serif" font-size="11" fill="#222">${captionLines[i]}</text>`,
    );
  }
  // Legend.
  const legendX = HEADLINE_WIDTH / 2 - 220;
  const legendY = HEADLINE_HEIGHT - 30;
  lines.push(
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#333">`,
    `    <line x1="${legendX}" y1="${legendY}" x2="${legendX + 22}" y2="${legendY}" ` +
      `stroke="#2ca02c" stroke-width="2"/>`,
    `    <text x="${legendX + 28}" y="${legendY + 4}">measured size (left axis)</text>`,
    `    <line x1="${legendX + 220}" y1="${legendY}" x2="${legendX + 242}" y2="${legendY}" ` +
      `stroke="#e67e22" stroke-width="2" stroke-dasharray="6 3"/>`,
    `    <text x="${legendX + 248}" y="${legendY + 4}">analytic p(topology) (right axis)</text>`,
    `  </g>`,
  );
  lines.push(`</svg>`);
  lines.push("");
  return lines.join("\n");
}

const TELEMETRY_SVG_WIDTH = 720;
const TELEMETRY_SVG_HEIGHT = 320;
const TELEMETRY_MARGIN = { top: 36, right: 70, bottom: 44, left: 60 };

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
    `aria-label="Adaptive mutation — best vs mean fitness per generation">`,
    `  <title>Adaptive Mutation — Best vs Mean Fitness</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Adaptive Mutation — Best vs Mean Fitness</text>`,
    yTicks.join("\n"),
    `  <polyline class="${FITNESS_CURVE_CLASS}" fill="none" stroke="#1f77b4" stroke-width="2" ` +
    `points="${buildPolyline(bestPts)}"/>`,
    `  <polyline class="mean-fitness" fill="none" stroke="#ff7f0e" stroke-width="1.4" ` +
    `stroke-dasharray="4 3" points="${buildPolyline(meanPts)}"/>`,
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
    `aria-label="Adaptive mutation — neuron and synapse counts per generation">`,
    `  <title>Adaptive Mutation — Topology Growth</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `Adaptive Mutation — Topology Growth</text>`,
    leftTicks.join("\n"),
    rightTicks.join("\n"),
    `  <polyline class="${NEURON_CURVE_CLASS}" fill="none" stroke="#2ca02c" stroke-width="2" ` +
    `points="${buildPolyline(neuronPts)}"/>`,
    `  <polyline class="${SYNAPSE_CURVE_CLASS}" fill="none" stroke="#d62728" stroke-width="2" ` +
    `stroke-dasharray="6 3" points="${buildPolyline(synapsePts)}"/>`,
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
