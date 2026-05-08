/**
 * SVG rendering helpers for the neuron-pruning demo.
 *
 * Produces a single SVG composed of:
 *
 * - **A topology panel** — every neuron drawn as a circle, every original
 *   synapse drawn as a thin grey line. Pruned neurons are filled in pale
 *   grey with a dashed outline so the eye picks them out at a glance, and
 *   their incident edges are dimmed.
 * - **Bias-fold arrows** — one curved coral arrow per `(prunedNeuron,
 *   downstreamTarget)` pair, with an arrowhead at the target end. These
 *   make it clear which downstream neurons absorbed the constant
 *   contribution of each pruned neuron.
 * - **A summary panel** — pre/post neuron count, pre/post score, and a
 *   compact table of pruned neurons with their bias-fold targets.
 * - **A legend** — explains the original-edge / pruned-edge / bias-fold
 *   conventions.
 *
 * Output is byte-deterministic for identical inputs — no timestamps, no
 * random values, no embedded run paths. Numeric coordinates are rounded
 * to two decimal places throughout for stable diffs.
 */
import type { PrunedNeuronRecord, TopologySnapshot } from "./neuron_pruning.ts";

/** SVG canvas width. */
export const PLOT_WIDTH = 960;
/** SVG canvas height. */
export const PLOT_HEIGHT = 540;

/** CSS class assigned to original (non-pruned) synapse lines. */
export const ORIGINAL_EDGE_CLASS = "edge-original";
/** CSS class assigned to incident-on-pruned synapse lines. */
export const PRUNED_EDGE_CLASS = "edge-pruned";
/** CSS class assigned to bias-fold arrows. */
export const BIAS_FOLD_CLASS = "bias-fold";
/** CSS class assigned to pruned neuron circles. */
export const PRUNED_NEURON_CLASS = "neuron-pruned";
/** CSS class assigned to surviving neuron circles. */
export const KEPT_NEURON_CLASS = "neuron-kept";

/** Inputs to {@link renderNeuronPruningSVG}. */
export interface RenderNeuronPruningOptions {
  /** Topology snapshot from `runNeuronPruningDemo`. */
  topology: TopologySnapshot;
  /** Neuron count before pruning. */
  preNeuronCount: number;
  /** Neuron count after pruning. */
  postNeuronCount: number;
  /** Held-out score before pruning. */
  preScore: number;
  /** Held-out score after pruning. */
  postScore: number;
  /** Per-pruned-neuron audit entries. */
  pruned: ReadonlyArray<PrunedNeuronRecord>;
}

const PANEL_TOP = 60;
const PANEL_HEIGHT = 380;
const SIDE_PADDING = 24;
const TOPOLOGY_WIDTH_RATIO = 0.62;

/**
 * Render the neuron-pruning summary as an SVG string. Throws when the
 * topology snapshot is internally inconsistent (e.g. pruned indices that
 * fall outside the neuron range).
 */
export function renderNeuronPruningSVG(options: RenderNeuronPruningOptions): string {
  const { topology, preNeuronCount, postNeuronCount, preScore, postScore, pruned } = options;
  const total = topology.inputCount + topology.hiddenCount + topology.outputCount;
  if (total !== preNeuronCount) {
    throw new Error(
      `topology neuron count (${total}) does not match preNeuronCount (${preNeuronCount})`,
    );
  }
  for (const idx of topology.prunedIndices) {
    if (idx < 0 || idx >= total) {
      throw new Error(`pruned index ${idx} out of range [0, ${total})`);
    }
  }

  const topologyWidth = (PLOT_WIDTH - 2 * SIDE_PADDING) * TOPOLOGY_WIDTH_RATIO;
  const summaryX = SIDE_PADDING + topologyWidth + 12;
  const summaryWidth = PLOT_WIDTH - SIDE_PADDING - summaryX;

  const topologyPanel = renderTopologyPanel({
    x: SIDE_PADDING,
    y: PANEL_TOP,
    width: topologyWidth,
    height: PANEL_HEIGHT,
    topology,
  });

  const summaryPanel = renderSummaryPanel({
    x: summaryX,
    y: PANEL_TOP,
    width: summaryWidth,
    height: PANEL_HEIGHT,
    preNeuronCount,
    postNeuronCount,
    preScore,
    postScore,
    pruned,
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="Neuron pruning: constant-activation removal with bias fold">`,
    `  <title>Neuron Pruning — Constant-Activation Removal With Bias Fold</title>`,
    `  <defs>`,
    `    <marker id="bias-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" ` +
    `markerHeight="6" orient="auto-start-reverse">`,
    `      <path d="M0,0 L10,5 L0,10 z" fill="#e57373"/>`,
    `    </marker>`,
    `  </defs>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="32" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="18" font-weight="bold" fill="#222">` +
    `Neuron Pruning — Constant-Activation Removal With Bias Fold</text>`,
    topologyPanel,
    summaryPanel,
    renderLegend(SIDE_PADDING + 12, PLOT_HEIGHT - 76),
    `</svg>`,
    "",
  ].join("\n");
}

interface TopologyPanelOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  topology: TopologySnapshot;
}

function renderTopologyPanel(opts: TopologyPanelOpts): string {
  const { x, y, width, height, topology } = opts;
  const innerPad = 18;
  const titleHeight = 22;

  const drawX = x + innerPad;
  const drawY = y + titleHeight + innerPad;
  const drawW = width - 2 * innerPad;
  const drawH = height - titleHeight - 2 * innerPad;

  const inputCount = topology.inputCount;
  const hiddenCount = topology.hiddenCount;
  const outputCount = topology.outputCount;
  const outStart = inputCount + hiddenCount;

  const layerXs = [
    drawX,
    drawX + drawW / 2,
    drawX + drawW,
  ];
  const positions = new Map<number, { x: number; y: number }>();
  const place = (count: number, startIdx: number, layerX: number) => {
    if (count === 0) return;
    if (count === 1) {
      positions.set(startIdx, { x: layerX, y: drawY + drawH / 2 });
      return;
    }
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      positions.set(startIdx + i, { x: layerX, y: drawY + t * drawH });
    }
  };
  place(inputCount, 0, layerXs[0]);
  place(hiddenCount, inputCount, layerXs[1]);
  place(outputCount, outStart, layerXs[2]);

  const prunedSet = new Set(topology.prunedIndices);

  // Draw synaptic edges. Originals first (kept) then pruned-incident
  // edges so the dimmed lines do not visually overpower the kept ones.
  const edgeLines: string[] = [];
  const sortedEdges = [...topology.edges].sort((a, b) => {
    if (a.pruned !== b.pruned) return a.pruned ? 1 : -1;
    if (a.from !== b.from) return a.from - b.from;
    return a.to - b.to;
  });
  for (const edge of sortedEdges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    if (edge.pruned) {
      edgeLines.push(
        `    <line class="${PRUNED_EDGE_CLASS}" x1="${from.x.toFixed(2)}" ` +
          `y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}" ` +
          `stroke="#bdbdbd" stroke-width="0.6" stroke-opacity="0.5" stroke-dasharray="2 2"/>`,
      );
    } else {
      edgeLines.push(
        `    <line class="${ORIGINAL_EDGE_CLASS}" x1="${from.x.toFixed(2)}" ` +
          `y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}" ` +
          `stroke="#555" stroke-width="0.7" stroke-opacity="0.8"/>`,
      );
    }
  }

  // Draw bias-fold arrows. Use a quadratic Bézier with a control point
  // offset perpendicular to the line so multiple folds from the same
  // source do not overlap.
  const sortedFolds = [...topology.biasFolds].sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    return a.to - b.to;
  });
  const foldLines: string[] = [];
  for (const fold of sortedFolds) {
    const from = positions.get(fold.from);
    const to = positions.get(fold.to);
    if (!from || !to) continue;
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    // Perpendicular offset so the curve bows away from the straight line.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.max(Math.hypot(dx, dy), 1e-6);
    const offset = 14;
    const cx = midX + (-dy / len) * offset;
    const cy = midY + (dx / len) * offset;
    foldLines.push(
      `    <path class="${BIAS_FOLD_CLASS}" d="M${from.x.toFixed(2)},${from.y.toFixed(2)} ` +
        `Q${cx.toFixed(2)},${cy.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}" ` +
        `fill="none" stroke="#e57373" stroke-width="1.2" stroke-opacity="0.85" ` +
        `marker-end="url(#bias-arrow)"/>`,
    );
  }

  // Draw neurons. Pruned neurons get a pale fill and dashed stroke.
  const neuronCircles: string[] = [];
  const labels: string[] = [];
  for (const [idx, p] of positions.entries()) {
    const isPruned = prunedSet.has(idx);
    let fill = "#7fb069";
    if (idx < inputCount) fill = "#4d82a3";
    else if (idx >= outStart) fill = "#d18b48";
    if (isPruned) fill = "#e0e0e0";
    const cls = isPruned ? PRUNED_NEURON_CLASS : KEPT_NEURON_CLASS;
    const stroke = isPruned ? "#9e9e9e" : "#222";
    const dash = isPruned ? ' stroke-dasharray="2 2"' : "";
    neuronCircles.push(
      `    <circle class="${cls}" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="6" ` +
        `fill="${fill}" stroke="${stroke}" stroke-width="0.8"${dash}/>`,
    );
    if (isPruned) {
      labels.push(
        `    <text x="${p.x.toFixed(2)}" y="${(p.y - 9).toFixed(2)}" text-anchor="middle" ` +
          `font-family="sans-serif" font-size="9" fill="#666">#${idx}</text>`,
      );
    }
  }

  return [
    `  <g class="topology">`,
    `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" ` +
    `height="${height.toFixed(2)}" fill="#ffffff" stroke="#cccccc" stroke-width="0.8"/>`,
    `    <text x="${(x + width / 2).toFixed(2)}" y="${(y + 18).toFixed(2)}" ` +
    `text-anchor="middle" font-family="sans-serif" font-size="13" ` +
    `font-weight="bold" fill="#222">Topology — pruned neurons greyed out, ` +
    `bias-fold arrows in coral</text>`,
    edgeLines.join("\n"),
    foldLines.join("\n"),
    neuronCircles.join("\n"),
    labels.join("\n"),
    `  </g>`,
  ].join("\n");
}

interface SummaryPanelOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  preNeuronCount: number;
  postNeuronCount: number;
  preScore: number;
  postScore: number;
  pruned: ReadonlyArray<PrunedNeuronRecord>;
}

function renderSummaryPanel(opts: SummaryPanelOpts): string {
  const { x, y, width, height, preNeuronCount, postNeuronCount, preScore, postScore, pruned } =
    opts;
  const innerPad = 14;
  const lineHeight = 16;
  const lines: string[] = [];

  const titleY = y + 22;
  lines.push(
    `    <text x="${(x + innerPad).toFixed(2)}" y="${titleY.toFixed(2)}" ` +
      `font-family="sans-serif" font-size="13" font-weight="bold" fill="#222">Summary</text>`,
  );

  const stats = [
    `pre-prune  neurons = ${preNeuronCount}`,
    `post-prune neurons = ${postNeuronCount}`,
    `Δ neurons = ${preNeuronCount - postNeuronCount}`,
    `pre-prune  score = ${preScore.toFixed(6)}`,
    `post-prune score = ${postScore.toFixed(6)}`,
    `Δ score = ${(postScore - preScore).toFixed(6)}`,
  ];
  for (let i = 0; i < stats.length; i++) {
    lines.push(
      `    <text x="${(x + innerPad).toFixed(2)}" y="${
        (titleY + 22 + i * lineHeight).toFixed(2)
      }" font-family="sans-serif" font-size="11" fill="#333">${stats[i]}</text>`,
    );
  }

  const tableY = titleY + 22 + stats.length * lineHeight + 14;
  lines.push(
    `    <text x="${(x + innerPad).toFixed(2)}" y="${tableY.toFixed(2)}" ` +
      `font-family="sans-serif" font-size="12" font-weight="bold" fill="#222">` +
      `Pruned neurons (idx → bias-fold targets)</text>`,
  );

  for (let i = 0; i < pruned.length; i++) {
    const rec = pruned[i];
    const txt = `#${rec.neuronIndex} (out=${rec.constantOutput.toFixed(3)}) → [${
      rec.biasFoldTargets.join(", ")
    }]`;
    lines.push(
      `    <text x="${(x + innerPad).toFixed(2)}" y="${
        (tableY + 18 + i * lineHeight).toFixed(2)
      }" font-family="monospace" font-size="10.5" fill="#444">${txt}</text>`,
    );
  }

  return [
    `  <g class="summary">`,
    `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" ` +
    `height="${height.toFixed(2)}" fill="#ffffff" stroke="#cccccc" stroke-width="0.8"/>`,
    lines.join("\n"),
    `  </g>`,
  ].join("\n");
}

function renderLegend(x: number, y: number): string {
  return [
    `  <g class="legend" font-family="sans-serif" font-size="10" fill="#222">`,
    `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="540" height="62" ` +
    `fill="#ffffff" fill-opacity="0.92" stroke="#cccccc" stroke-width="0.5"/>`,
    `    <line x1="${(x + 12).toFixed(2)}" y1="${(y + 16).toFixed(2)}" ` +
    `x2="${(x + 38).toFixed(2)}" y2="${(y + 16).toFixed(2)}" stroke="#555" stroke-width="0.9"/>`,
    `    <text x="${(x + 46).toFixed(2)}" y="${
      (y + 19).toFixed(2)
    }">original synapse (kept)</text>`,
    `    <line x1="${(x + 12).toFixed(2)}" y1="${(y + 32).toFixed(2)}" ` +
    `x2="${(x + 38).toFixed(2)}" y2="${(y + 32).toFixed(2)}" stroke="#bdbdbd" stroke-width="0.9" ` +
    `stroke-dasharray="2 2"/>`,
    `    <text x="${(x + 46).toFixed(2)}" y="${(y + 35).toFixed(2)}">edge incident on pruned ` +
    `neuron (removed)</text>`,
    `    <line x1="${(x + 12).toFixed(2)}" y1="${(y + 48).toFixed(2)}" ` +
    `x2="${(x + 38).toFixed(2)}" y2="${(y + 48).toFixed(2)}" stroke="#e57373" stroke-width="1.4" ` +
    `marker-end="url(#bias-arrow)"/>`,
    `    <text x="${(x + 46).toFixed(2)}" y="${(y + 51).toFixed(2)}">bias-fold contribution to ` +
    `downstream neuron</text>`,
    `    <circle cx="${(x + 280).toFixed(2)}" cy="${(y + 16).toFixed(2)}" r="5" fill="#7fb069" ` +
    `stroke="#222" stroke-width="0.6"/>`,
    `    <text x="${(x + 292).toFixed(2)}" y="${(y + 19).toFixed(2)}">kept hidden neuron</text>`,
    `    <circle cx="${(x + 280).toFixed(2)}" cy="${(y + 32).toFixed(2)}" r="5" fill="#e0e0e0" ` +
    `stroke="#9e9e9e" stroke-width="0.6" stroke-dasharray="2 2"/>`,
    `    <text x="${(x + 292).toFixed(2)}" y="${(y + 35).toFixed(2)}">pruned neuron ` +
    `(constant activation)</text>`,
    `    <circle cx="${(x + 280).toFixed(2)}" cy="${(y + 48).toFixed(2)}" r="5" fill="#4d82a3" ` +
    `stroke="#222" stroke-width="0.6"/>`,
    `    <text x="${(x + 292).toFixed(2)}" y="${(y + 51).toFixed(2)}">input</text>`,
    `    <circle cx="${(x + 360).toFixed(2)}" cy="${(y + 48).toFixed(2)}" r="5" fill="#d18b48" ` +
    `stroke="#222" stroke-width="0.6"/>`,
    `    <text x="${(x + 372).toFixed(2)}" y="${(y + 51).toFixed(2)}">output</text>`,
    `  </g>`,
  ].join("\n");
}
