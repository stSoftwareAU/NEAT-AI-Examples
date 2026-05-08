/**
 * SVG rendering helpers for the synthetic-synapse demo.
 *
 * Produces a single SVG composed of:
 *
 * - **Three topology panels** — one per phase (sparse, densified, pruned).
 *   Original synapses are drawn in mid-grey; synthetic synapses added during
 *   densification are drawn in coral so the densify-then-prune effect is
 *   visible at a glance.
 * - **A bar chart** — synapse count per phase as bars and held-out score per
 *   phase as a line, all on a shared X axis. The matched-budget control run
 *   is drawn as a dashed line for the score and a hatched bar for the
 *   synapse count, so the comparison sits inside the same chart.
 *
 * Output is byte-deterministic for identical inputs — no timestamps, no
 * random values, no embedded run paths. Numeric coordinates are rounded to
 * two decimal places throughout for stable diffs.
 */
import type { PhaseName, PhaseRecord, TopologySnapshot } from "./synthetic_synapse_example.ts";

/** SVG canvas width. */
export const PLOT_WIDTH = 960;
/** SVG canvas height. */
export const PLOT_HEIGHT = 540;

/** CSS class assigned to original (non-synthetic) synapse lines. */
export const ORIGINAL_SYNAPSE_CLASS = "synapse-original";
/** CSS class assigned to synthetic synapse lines. */
export const SYNTHETIC_SYNAPSE_CLASS = "synapse-synthetic";
/** CSS class assigned to bars in the synapse-count bar chart. */
export const SYNAPSE_BAR_CLASS = "bar-synapse";
/** CSS class assigned to the matched-control bar. */
export const CONTROL_BAR_CLASS = "bar-control";
/** CSS class assigned to the held-out score polyline. */
export const SCORE_LINE_CLASS = "score-line";
/** CSS class assigned to the control-score reference line. */
export const CONTROL_SCORE_CLASS = "control-score-line";

const PHASE_ORDER: PhaseName[] = ["sparse", "densified", "pruned"];

/** Inputs to {@link renderSyntheticSynapseSVG}. */
export interface RenderSyntheticSynapseOptions {
  /** Phase records (3 entries: sparse, densified, pruned). */
  phases: readonly PhaseRecord[];
  /** Held-out score from the matched-budget control run. */
  controlScore: number;
  /** Synapse count of the control creature at the end of training. */
  controlSynapseCount: number;
  /** Topology snapshot per phase (used for the three topology panels). */
  topologies: Record<PhaseName, TopologySnapshot>;
}

const PANEL_TOP = 60;
const PANEL_HEIGHT = 220;
const PANEL_GAP = 16;
const SIDE_PADDING = 24;
const BARCHART_TOP = PANEL_TOP + PANEL_HEIGHT + 36;
const BARCHART_HEIGHT = 200;

/**
 * Render the synthetic-synapse comparison as an SVG string. Throws when
 * the inputs do not contain exactly three phase records in the expected
 * order.
 */
export function renderSyntheticSynapseSVG(options: RenderSyntheticSynapseOptions): string {
  const { phases, controlScore, controlSynapseCount, topologies } = options;
  if (phases.length !== 3) {
    throw new Error(`expected 3 phase records, got ${phases.length}`);
  }
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    if (phases[i].phase !== PHASE_ORDER[i]) {
      throw new Error(
        `phase[${i}] expected '${PHASE_ORDER[i]}', got '${phases[i].phase}'`,
      );
    }
  }

  const panelWidth = (PLOT_WIDTH - 2 * SIDE_PADDING - 2 * PANEL_GAP) / 3;

  const topologyPanels = PHASE_ORDER.map((phase, i) => {
    const x = SIDE_PADDING + i * (panelWidth + PANEL_GAP);
    return renderTopologyPanel({
      x,
      y: PANEL_TOP,
      width: panelWidth,
      height: PANEL_HEIGHT,
      phase,
      topology: topologies[phase],
      record: phases[i],
    });
  }).join("\n");

  const barChart = renderBarChart({
    x: SIDE_PADDING,
    y: BARCHART_TOP,
    width: PLOT_WIDTH - 2 * SIDE_PADDING,
    height: BARCHART_HEIGHT,
    phases,
    controlScore,
    controlSynapseCount,
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="Synthetic synapse training: sparse, densified, pruned">`,
    `  <title>Synthetic Synapse Training — Densify Then Prune</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="32" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="18" font-weight="bold" fill="#222">` +
    `Synthetic Synapse Training — Densify Then Prune</text>`,
    topologyPanels,
    barChart,
    `</svg>`,
    "",
  ].join("\n");
}

interface PanelOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  phase: PhaseName;
  topology: TopologySnapshot;
  record: PhaseRecord;
}

function renderTopologyPanel(opts: PanelOpts): string {
  const { x, y, width, height, phase, topology, record } = opts;
  const innerPad = 14;
  const titleHeight = 18;
  const subtitleHeight = 16;

  const drawX = x + innerPad;
  const drawY = y + titleHeight + subtitleHeight + innerPad;
  const drawW = width - 2 * innerPad;
  const drawH = height - titleHeight - subtitleHeight - 2 * innerPad;

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

  // Draw synaptic edges. Originals first so synthetic edges sit on top.
  const edgeLines: string[] = [];
  const sortedEdges = [...topology.edges].sort((a, b) => {
    if (a.synthetic !== b.synthetic) return a.synthetic ? 1 : -1;
    if (a.from !== b.from) return a.from - b.from;
    return a.to - b.to;
  });
  for (const edge of sortedEdges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    if (edge.synthetic) {
      edgeLines.push(
        `    <line class="${SYNTHETIC_SYNAPSE_CLASS}" x1="${from.x.toFixed(2)}" ` +
          `y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}" ` +
          `stroke="#e57373" stroke-width="0.6" stroke-opacity="0.55"/>`,
      );
    } else {
      edgeLines.push(
        `    <line class="${ORIGINAL_SYNAPSE_CLASS}" x1="${from.x.toFixed(2)}" ` +
          `y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}" ` +
          `stroke="#555" stroke-width="0.7" stroke-opacity="0.7"/>`,
      );
    }
  }

  // Draw neurons.
  const neuronCircles: string[] = [];
  for (const [idx, p] of positions.entries()) {
    let fill = "#7fb069";
    if (idx < inputCount) fill = "#4d82a3";
    else if (idx >= outStart) fill = "#d18b48";
    neuronCircles.push(
      `    <circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3.5" ` +
        `fill="${fill}" stroke="#222" stroke-width="0.4"/>`,
    );
  }

  return [
    `  <g class="topology topology-${phase}">`,
    `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" ` +
    `height="${height.toFixed(2)}" fill="#ffffff" stroke="#cccccc" stroke-width="0.8"/>`,
    `    <text x="${(x + width / 2).toFixed(2)}" y="${(y + 18).toFixed(2)}" ` +
    `text-anchor="middle" font-family="sans-serif" font-size="13" ` +
    `font-weight="bold" fill="#222">${labelFor(phase)}</text>`,
    `    <text x="${(x + width / 2).toFixed(2)}" y="${(y + 34).toFixed(2)}" ` +
    `text-anchor="middle" font-family="sans-serif" font-size="11" fill="#444">` +
    `${record.synapseCount} synapses · score ${record.heldOutScore.toFixed(4)}</text>`,
    edgeLines.join("\n"),
    neuronCircles.join("\n"),
    `  </g>`,
  ].join("\n");
}

function labelFor(phase: PhaseName): string {
  switch (phase) {
    case "sparse":
      return "1. sparse";
    case "densified":
      return "2. densified";
    case "pruned":
      return "3. pruned";
  }
}

interface BarChartOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  phases: readonly PhaseRecord[];
  controlScore: number;
  controlSynapseCount: number;
}

function renderBarChart(opts: BarChartOpts): string {
  const { x, y, width, height, phases, controlScore, controlSynapseCount } = opts;
  const margin = { top: 24, right: 64, bottom: 36, left: 56 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const innerX = x + margin.left;
  const innerY = y + margin.top;

  const labels = [...phases.map((p) => p.phase), "control"];
  const synapseCounts = [...phases.map((p) => p.synapseCount), controlSynapseCount];
  const scores = [...phases.map((p) => p.heldOutScore), controlScore];

  const maxSynapses = Math.max(...synapseCounts, 1);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const scoreSpan = (maxScore - minScore) || 1;
  const scoreMin = minScore - scoreSpan * 0.1;
  const scoreMax = maxScore + scoreSpan * 0.1;
  const scoreScale = (s: number) =>
    innerY + innerH - ((s - scoreMin) / (scoreMax - scoreMin)) * innerH;
  const synapseScale = (n: number) => innerY + innerH - (n / maxSynapses) * innerH;

  const barWidth = innerW / labels.length * 0.55;
  const groupCentre = (i: number) => innerX + (i + 0.5) * (innerW / labels.length);

  const bars = labels.map((label, i) => {
    const isControl = label === "control";
    const cls = isControl ? CONTROL_BAR_CLASS : SYNAPSE_BAR_CLASS;
    const fill = isControl ? "#bdbdbd" : "#90caf9";
    const stroke = isControl ? "#616161" : "#1976d2";
    const cx = groupCentre(i);
    const top = synapseScale(synapseCounts[i]);
    const bottom = innerY + innerH;
    return [
      `    <rect class="${cls}" x="${(cx - barWidth / 2).toFixed(2)}" ` +
      `y="${top.toFixed(2)}" width="${barWidth.toFixed(2)}" ` +
      `height="${(bottom - top).toFixed(2)}" fill="${fill}" stroke="${stroke}" ` +
      `stroke-width="0.6"${isControl ? ' stroke-dasharray="3 2"' : ""}/>`,
      `    <text x="${cx.toFixed(2)}" y="${(top - 4).toFixed(2)}" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="11" fill="#222">${synapseCounts[i]}</text>`,
    ].join("\n");
  }).join("\n");

  // Score polyline across the synthetic phases.
  const scorePts = phases
    .map((p, i) => `${groupCentre(i).toFixed(2)},${scoreScale(p.heldOutScore).toFixed(2)}`)
    .join(" ");
  const controlScoreY = scoreScale(controlScore);
  const controlScoreX = groupCentre(labels.length - 1);

  // Y axes (left = synapses, right = score).
  const synapseTicks = renderAxisYTicks({
    x: innerX,
    y: innerY,
    height: innerH,
    min: 0,
    max: maxSynapses,
    side: "left",
    label: "synapses",
    format: (v) => v.toFixed(0),
  });
  const scoreTicks = renderAxisYTicks({
    x: innerX + innerW,
    y: innerY,
    height: innerH,
    min: scoreMin,
    max: scoreMax,
    side: "right",
    label: "held-out score",
    format: (v) => v.toFixed(3),
  });
  const xLabels = labels
    .map((label, i) =>
      `    <text x="${groupCentre(i).toFixed(2)}" y="${
        (innerY + innerH + 18).toFixed(2)
      }" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#333">${label}</text>`
    )
    .join("\n");

  return [
    `  <g class="bar-chart">`,
    `    <rect x="${innerX.toFixed(2)}" y="${innerY.toFixed(2)}" ` +
    `width="${innerW.toFixed(2)}" height="${innerH.toFixed(2)}" ` +
    `fill="#ffffff" stroke="#cccccc" stroke-width="0.8"/>`,
    synapseTicks,
    scoreTicks,
    bars,
    `    <polyline class="${SCORE_LINE_CLASS}" fill="none" stroke="#2e7d32" ` +
    `stroke-width="2" points="${scorePts}"/>`,
    ...phases.map((p, i) =>
      `    <circle cx="${groupCentre(i).toFixed(2)}" ` +
      `cy="${scoreScale(p.heldOutScore).toFixed(2)}" r="3.6" fill="#2e7d32"/>`
    ),
    `    <line class="${CONTROL_SCORE_CLASS}" x1="${innerX.toFixed(2)}" ` +
    `y1="${controlScoreY.toFixed(2)}" x2="${(innerX + innerW).toFixed(2)}" ` +
    `y2="${controlScoreY.toFixed(2)}" stroke="#c62828" stroke-width="1.4" ` +
    `stroke-dasharray="6 4"/>`,
    `    <circle cx="${controlScoreX.toFixed(2)}" cy="${controlScoreY.toFixed(2)}" ` +
    `r="3.6" fill="#c62828"/>`,
    xLabels,
    renderLegend(innerX + innerW - 220, innerY + 4),
    `  </g>`,
  ].join("\n");
}

interface AxisYOpts {
  x: number;
  y: number;
  height: number;
  min: number;
  max: number;
  side: "left" | "right";
  label: string;
  format: (v: number) => string;
}

function renderAxisYTicks(opts: AxisYOpts): string {
  const ticks = 4;
  const lines: string[] = [`    <g class="axis-y axis-y-${opts.side}">`];
  for (let i = 0; i <= ticks; i++) {
    const t = i / ticks;
    const value = opts.min + t * (opts.max - opts.min);
    const ty = opts.y + opts.height - t * opts.height;
    const tickX1 = opts.side === "left" ? opts.x - 4 : opts.x;
    const tickX2 = opts.side === "left" ? opts.x : opts.x + 4;
    const textX = opts.side === "left" ? opts.x - 6 : opts.x + 6;
    const anchor = opts.side === "left" ? "end" : "start";
    lines.push(
      `      <line x1="${tickX1.toFixed(2)}" y1="${ty.toFixed(2)}" ` +
        `x2="${tickX2.toFixed(2)}" y2="${ty.toFixed(2)}" stroke="#666" stroke-width="0.6"/>`,
    );
    lines.push(
      `      <text x="${textX.toFixed(2)}" y="${(ty + 3.5).toFixed(2)}" ` +
        `text-anchor="${anchor}" font-family="sans-serif" font-size="10" fill="#333">${
          opts.format(value)
        }</text>`,
    );
  }
  const labelX = opts.side === "left" ? opts.x - 40 : opts.x + 50;
  const labelY = opts.y + opts.height / 2;
  lines.push(
    `      <text x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="11" fill="#333" ` +
      `transform="rotate(-90 ${labelX.toFixed(2)} ${labelY.toFixed(2)})">${opts.label}</text>`,
  );
  lines.push(`    </g>`);
  return lines.join("\n");
}

function renderLegend(x: number, y: number): string {
  return [
    `    <g class="legend" font-family="sans-serif" font-size="10" fill="#222">`,
    `      <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="216" height="62" ` +
    `fill="#ffffff" fill-opacity="0.92" stroke="#cccccc" stroke-width="0.5"/>`,
    `      <rect x="${(x + 8).toFixed(2)}" y="${(y + 8).toFixed(2)}" width="14" height="10" ` +
    `fill="#90caf9" stroke="#1976d2" stroke-width="0.6"/>`,
    `      <text x="${(x + 28).toFixed(2)}" y="${
      (y + 17).toFixed(2)
    }">synapse count (per phase)</text>`,
    `      <line x1="${(x + 8).toFixed(2)}" y1="${(y + 30).toFixed(2)}" ` +
    `x2="${(x + 22).toFixed(2)}" y2="${(y + 30).toFixed(2)}" stroke="#2e7d32" stroke-width="2"/>`,
    `      <text x="${(x + 28).toFixed(2)}" y="${(y + 33).toFixed(2)}">held-out score</text>`,
    `      <line x1="${(x + 8).toFixed(2)}" y1="${(y + 46).toFixed(2)}" ` +
    `x2="${(x + 22).toFixed(2)}" y2="${(y + 46).toFixed(2)}" stroke="#c62828" stroke-width="1.4" ` +
    `stroke-dasharray="6 4"/>`,
    `      <text x="${(x + 28).toFixed(2)}" y="${
      (y + 49).toFixed(2)
    }">control (no densification)</text>`,
    `    </g>`,
  ].join("\n");
}
