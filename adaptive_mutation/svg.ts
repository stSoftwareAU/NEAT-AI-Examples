/**
 * Headline SVG renderer for the adaptive mutation rate demo
 * (audit #212, rewired #263/#264, chart rewire #286).
 *
 * Under #286 the per-generation chunked telemetry loop was removed in
 * favour of a single `creature.evolveDir(...)` call charted from its
 * return value. The headline SVG now consumes the
 * {@link EvolveDirSummary} captured by the demo plus the documented
 * analytic policy curve (see {@link topologyProbability}) — the
 * analytic curve remains the narrative, and the measured trajectory is
 * replaced by seed-vs-final topology bars sourced from the summary.
 */
import type { EvolveDirSummary } from "../common/evolve_dir_summary.ts";
import { DEFAULT_POLICY_CONFIG, topologyProbability } from "./adaptive_mutation.ts";

/** CSS class assigned to the analytic topology-policy curve. */
export const TOPOLOGY_CURVE_CLASS = "topology-rate";

/** CSS class assigned to the seed-vs-final topology bar group. */
export const TOPOLOGY_BARS_CLASS = "seed-vs-final";

/** Inputs to {@link renderAdaptiveMutationSVG}. */
export interface RenderAdaptiveMutationOptions {
  /** Summary captured around the single `evolveDir` call. */
  summary: EvolveDirSummary;
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
const HEADLINE_HEIGHT = 640;
const HEADLINE_MARGIN = { top: 70, right: 80, bottom: 80, left: 70 };
/** Gap between the upper (policy curve) and lower (topology bars) panels. */
const HEADLINE_PANEL_GAP = 50;

interface Point {
  x: number;
  y: number;
}

function buildPolyline(points: readonly Point[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

/**
 * Render the headline two-panel chart for the adaptive mutation demo.
 *
 *   - Upper panel: the documented analytic topology-mutation
 *     probability curve `p(topology) = base / (1 + size / scale)`
 *     sampled across `[0, max(finalSize, sizeScale * 4)]` so the curve
 *     visibly decays past the final creature's size.
 *   - Lower panel: seed-vs-final topology bars (neurons and synapses)
 *     sourced from the supplied {@link EvolveDirSummary}.
 */
export function renderAdaptiveMutationSVG(
  options: RenderAdaptiveMutationOptions,
): string {
  const { summary, heldOutScore, wallClockMs, generations, solved } = options;

  const totalInnerH = HEADLINE_HEIGHT - HEADLINE_MARGIN.top - HEADLINE_MARGIN.bottom -
    HEADLINE_PANEL_GAP;
  const innerW = HEADLINE_WIDTH - HEADLINE_MARGIN.left - HEADLINE_MARGIN.right;
  const upperH = Math.round(totalInnerH * 0.55);
  const lowerH = totalInnerH - upperH;
  const innerX = HEADLINE_MARGIN.left;
  const upperY = HEADLINE_MARGIN.top;
  const lowerY = upperY + upperH + HEADLINE_PANEL_GAP;

  // Upper panel: analytic policy curve. Sample size across a range
  // that comfortably covers the final creature's actual size so the
  // viewer can see where the run landed on the curve.
  const finalSize = summary.finalNeurons + summary.finalSynapses;
  const seedSize = summary.seedNeurons + summary.seedSynapses;
  const maxSize = Math.max(finalSize, DEFAULT_POLICY_CONFIG.sizeScale * 4, 1);
  const sampleCount = 80;
  const policyPts: Point[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const size = (i / sampleCount) * maxSize;
    const p = topologyProbability(size, DEFAULT_POLICY_CONFIG);
    const x = innerX + (size / maxSize) * innerW;
    const y = upperY + upperH - (p / DEFAULT_POLICY_CONFIG.baseTopologyProb) * upperH;
    policyPts.push({ x, y });
  }

  // Annotate the seed and final sizes against the policy curve.
  const seedPolicyP = topologyProbability(seedSize, DEFAULT_POLICY_CONFIG);
  const finalPolicyP = topologyProbability(finalSize, DEFAULT_POLICY_CONFIG);
  const sizeToX = (size: number) => innerX + (Math.min(size, maxSize) / maxSize) * innerW;
  const probToY = (p: number) =>
    upperY + upperH - (p / DEFAULT_POLICY_CONFIG.baseTopologyProb) * upperH;
  const seedMark = { x: sizeToX(seedSize), y: probToY(seedPolicyP) };
  const finalMark = { x: sizeToX(finalSize), y: probToY(finalPolicyP) };

  // Upper panel axis ticks (probability on the left axis).
  const upperTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const ly = upperY + upperH - t * upperH;
    upperTicks.push(
      `    <line x1="${innerX.toFixed(2)}" y1="${ly.toFixed(2)}" ` +
        `x2="${(innerX + innerW).toFixed(2)}" y2="${ly.toFixed(2)}" ` +
        `stroke="#eeeeee" stroke-width="0.6"/>`,
      `    <text x="${(innerX - 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="end" font-family="sans-serif" font-size="10" fill="#e67e22">` +
        `${(t * DEFAULT_POLICY_CONFIG.baseTopologyProb).toFixed(2)}</text>`,
    );
  }
  // X-axis size ticks at 0 / 25% / 50% / 75% / max.
  const upperXTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const tx = innerX + t * innerW;
    upperXTicks.push(
      `    <line x1="${tx.toFixed(2)}" y1="${(upperY + upperH).toFixed(2)}" ` +
        `x2="${tx.toFixed(2)}" y2="${(upperY + upperH + 4).toFixed(2)}" ` +
        `stroke="#999999" stroke-width="0.6"/>`,
      `    <text x="${tx.toFixed(2)}" y="${(upperY + upperH + 16).toFixed(2)}" ` +
        `text-anchor="middle" font-family="sans-serif" font-size="10" fill="#555">` +
        `${Math.round(t * maxSize)}</text>`,
    );
  }

  // Lower panel: seed-vs-final topology bars.
  const groupW = innerW / 2;
  const neuronsGroup = drawTopologyBars(
    innerX,
    lowerY,
    groupW,
    lowerH,
    "neurons",
    summary.seedNeurons,
    summary.finalNeurons,
  );
  const synapsesGroup = drawTopologyBars(
    innerX + groupW,
    lowerY,
    groupW,
    lowerH,
    "synapses",
    summary.seedSynapses,
    summary.finalSynapses,
  );

  const seconds = (wallClockMs / 1000).toFixed(1);
  const captionLines = [
    `Generations: ${generations}` + (solved ? " (solved)" : ""),
    `Wall-clock: ${seconds}s`,
    `Final error: ${summary.finalError.toFixed(4)}`,
    `Held-out -MSE: ${heldOutScore.toFixed(4)}`,
  ];

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${HEADLINE_WIDTH} ${HEADLINE_HEIGHT}" ` +
      `width="${HEADLINE_WIDTH}" height="${HEADLINE_HEIGHT}" role="img" ` +
      `aria-label="Adaptive mutation — analytic policy curve and seed-vs-final topology">`,
  );
  lines.push(`  <title>Adaptive Mutation Rate — Single evolveDir Summary</title>`);
  lines.push(`  <rect width="${HEADLINE_WIDTH}" height="${HEADLINE_HEIGHT}" fill="#fafafa"/>`);
  lines.push(
    `  <text x="${HEADLINE_WIDTH / 2}" y="28" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
      `Adaptive Mutation Rate — Analytic Policy and Topology Growth</text>`,
  );
  lines.push(
    `  <text x="${HEADLINE_WIDTH / 2}" y="48" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="11" fill="#555">` +
      `p(topology) decays as size grows; seed → final bars show NEAT's measured topology growth.` +
      `</text>`,
  );
  lines.push(upperTicks.join("\n"));
  lines.push(upperXTicks.join("\n"));
  // Upper panel axis labels.
  lines.push(
    `  <text x="${(innerX - 50).toFixed(2)}" y="${(upperY + upperH / 2).toFixed(2)}" ` +
      `text-anchor="middle" dominant-baseline="middle" ` +
      `transform="rotate(-90 ${(innerX - 50).toFixed(2)} ${(upperY + upperH / 2).toFixed(2)})" ` +
      `font-family="sans-serif" font-size="11" fill="#e67e22">p(topology mutation)</text>`,
  );
  lines.push(
    `  <text x="${(innerX + innerW / 2).toFixed(2)}" y="${(upperY + upperH + 34).toFixed(2)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555">` +
      `size (neurons + synapses)</text>`,
  );
  // Analytic policy polyline.
  lines.push(
    `  <polyline class="${TOPOLOGY_CURVE_CLASS}" fill="none" stroke="#e67e22" stroke-width="2" ` +
      `stroke-dasharray="6 3" points="${buildPolyline(policyPts)}"/>`,
  );
  // Seed / final markers on the policy curve.
  lines.push(
    `  <circle class="seed-mark" cx="${seedMark.x.toFixed(2)}" cy="${seedMark.y.toFixed(2)}" ` +
      `r="5" fill="#9ecae1" stroke="#333" stroke-width="1"/>`,
    `  <text x="${(seedMark.x + 8).toFixed(2)}" y="${(seedMark.y - 6).toFixed(2)}" ` +
      `font-family="sans-serif" font-size="10" fill="#333">seed (size ${seedSize})</text>`,
    `  <circle class="final-mark" cx="${finalMark.x.toFixed(2)}" cy="${finalMark.y.toFixed(2)}" ` +
      `r="5" fill="#1f77b4" stroke="#333" stroke-width="1"/>`,
    `  <text x="${(finalMark.x + 8).toFixed(2)}" y="${(finalMark.y + 14).toFixed(2)}" ` +
      `font-family="sans-serif" font-size="10" fill="#333">final (size ${finalSize})</text>`,
  );
  // Panel headings.
  lines.push(
    `  <text x="${innerX.toFixed(2)}" y="${(upperY - 6).toFixed(2)}" ` +
      `font-family="sans-serif" font-size="11" font-weight="bold" fill="#333">` +
      `Analytic topology-mutation policy curve</text>`,
  );
  lines.push(
    `  <text x="${innerX.toFixed(2)}" y="${(lowerY - 6).toFixed(2)}" ` +
      `font-family="sans-serif" font-size="11" font-weight="bold" fill="#333">` +
      `Seed → final topology (neurons and synapses)</text>`,
  );
  lines.push(
    `  <g class="${TOPOLOGY_BARS_CLASS}">`,
    neuronsGroup,
    synapsesGroup,
    `  </g>`,
  );
  // Caption box.
  const captionX = innerX + 12;
  const captionY = upperY + 12;
  lines.push(
    `  <rect x="${captionX.toFixed(2)}" y="${captionY.toFixed(2)}" width="220" height="74" ` +
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
      `stroke="#e67e22" stroke-width="2" stroke-dasharray="6 3"/>`,
    `    <text x="${legendX + 28}" y="${legendY + 4}">analytic p(topology)</text>`,
    `    <rect x="${legendX + 180}" y="${legendY - 6}" width="14" height="12" fill="#9ecae1"/>`,
    `    <text x="${legendX + 198}" y="${legendY + 4}">seed</text>`,
    `    <rect x="${legendX + 250}" y="${legendY - 6}" width="14" height="12" fill="#1f77b4"/>`,
    `    <text x="${legendX + 268}" y="${legendY + 4}">final</text>`,
    `  </g>`,
  );
  lines.push(`</svg>`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Draw a seed-vs-final bar pair for a single topology metric (neurons
 * or synapses) inside the supplied bounding box. The pair shares a
 * common ceiling so seed and final bars are directly comparable.
 */
function drawTopologyBars(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  seed: number,
  final: number,
): string {
  const out: string[] = [];
  const labelStripH = 28;
  const barAreaH = Math.max(1, h - labelStripH);
  const ceiling = Math.max(1, seed, final) * 1.15;
  const slotW = w / 2;
  const barW = slotW * 0.45;

  const seedBarH = (seed / ceiling) * barAreaH;
  const seedBarX = x + (slotW - barW) / 2;
  const seedBarY = y + barAreaH - seedBarH;
  out.push(
    `    <rect class="topo-bar topo-bar-seed-${label}" ` +
      `x="${seedBarX.toFixed(2)}" y="${seedBarY.toFixed(2)}" ` +
      `width="${barW.toFixed(2)}" height="${seedBarH.toFixed(2)}" fill="#9ecae1"/>`,
    `    <text x="${(seedBarX + barW / 2).toFixed(2)}" y="${(seedBarY - 4).toFixed(2)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" ` +
      `fill="#222">${seed}</text>`,
    `    <text x="${(seedBarX + barW / 2).toFixed(2)}" y="${(y + barAreaH + 14).toFixed(2)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="10" fill="#555">seed</text>`,
  );

  const finalBarH = (final / ceiling) * barAreaH;
  const finalBarX = x + slotW + (slotW - barW) / 2;
  const finalBarY = y + barAreaH - finalBarH;
  out.push(
    `    <rect class="topo-bar topo-bar-final-${label}" ` +
      `x="${finalBarX.toFixed(2)}" y="${finalBarY.toFixed(2)}" ` +
      `width="${barW.toFixed(2)}" height="${finalBarH.toFixed(2)}" fill="#1f77b4"/>`,
    `    <text x="${(finalBarX + barW / 2).toFixed(2)}" y="${(finalBarY - 4).toFixed(2)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" ` +
      `fill="#222">${final}</text>`,
    `    <text x="${(finalBarX + barW / 2).toFixed(2)}" y="${(y + barAreaH + 14).toFixed(2)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="10" fill="#555">final</text>`,
  );

  out.push(
    `    <text x="${(x + w / 2).toFixed(2)}" y="${(y + barAreaH + 28).toFixed(2)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" ` +
      `fill="#333">${label}</text>`,
  );
  return out.join("\n");
}
