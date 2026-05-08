/**
 * SVG rendering for the discovery-at-scale demo (issue #84).
 *
 * Output is a single SVG containing:
 *
 * - A "before" topology panel — every neuron drawn as a small circle,
 *   coloured by its defect category. Synapses are thin grey lines, with
 *   dormant synapses dashed.
 * - An "after" topology panel — same style, on the discovered (or
 *   crippled-fallback) creature.
 * - A summary panel showing baseline / crippled / discovered scores and
 *   per-category defect tallies.
 * - A legend mapping each colour to a defect type.
 *
 * Output is byte-deterministic for identical inputs — coordinates are
 * rounded to two decimal places throughout for stable diffs.
 */
import type { DefectCategory, TopologySnapshot } from "./discovery_at_scale.ts";

/** SVG canvas width. */
export const PLOT_WIDTH = 1100;
/** SVG canvas height. */
export const PLOT_HEIGHT = 620;

/** Colour for each defect category in the topology panels. */
export const DEFECT_COLOURS: Record<DefectCategory, string> = {
  healthy: "#7fb069",
  saturated: "#e74c3c",
  dead: "#34495e",
  dormant: "#95a5a6",
  bimodal: "#9b59b6",
  bottleneck: "#f39c12",
};

const HEADER_HEIGHT = 60;
const PANEL_TOP = HEADER_HEIGHT;
const PANEL_HEIGHT = 360;
const LEGEND_TOP = PANEL_TOP + PANEL_HEIGHT + 14;
const SUMMARY_TOP = LEGEND_TOP + 86;
const SIDE_PADDING = 24;

/** Inputs to {@link renderDiscoveryAtScaleSVG}. */
export interface RenderDiscoveryAtScaleOptions {
  before: TopologySnapshot;
  after: TopologySnapshot;
  baselineScore: number;
  crippledScore: number;
  discoveredScore: number | null;
  discoveryFound: boolean;
  discoveryNote: string | null;
}

/** Render the before/after discovery SVG as a deterministic string. */
export function renderDiscoveryAtScaleSVG(opts: RenderDiscoveryAtScaleOptions): string {
  const { before, after, baselineScore, crippledScore, discoveredScore } = opts;

  const panelWidth = (PLOT_WIDTH - 3 * SIDE_PADDING) / 2;
  const beforeX = SIDE_PADDING;
  const afterX = SIDE_PADDING * 2 + panelWidth;

  const beforePanel = renderTopologyPanel({
    x: beforeX,
    y: PANEL_TOP,
    width: panelWidth,
    height: PANEL_HEIGHT,
    title: "Before — crippled creature with injected defects",
    topology: before,
  });

  const afterPanel = renderTopologyPanel({
    x: afterX,
    y: PANEL_TOP,
    width: panelWidth,
    height: PANEL_HEIGHT,
    title: opts.discoveryFound
      ? "After — discovered creature"
      : "After — crippled (discovery unavailable / no improvement)",
    topology: after,
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="Discovery at scale: defect categories before and after">`,
    `  <title>Discovery at Scale — Before/After Defect Visualisation</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="34" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="20" font-weight="bold" fill="#222">` +
    `Discovery at Scale — Multi-Defect Detection</text>`,
    beforePanel,
    afterPanel,
    renderLegend(SIDE_PADDING, LEGEND_TOP),
    renderSummary({
      x: SIDE_PADDING,
      y: SUMMARY_TOP,
      width: PLOT_WIDTH - 2 * SIDE_PADDING,
      height: PLOT_HEIGHT - SUMMARY_TOP - SIDE_PADDING,
      before,
      after,
      baselineScore,
      crippledScore,
      discoveredScore,
      discoveryFound: opts.discoveryFound,
      discoveryNote: opts.discoveryNote,
    }),
    `</svg>`,
    "",
  ].join("\n");
}

interface TopologyPanelOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  topology: TopologySnapshot;
}

function renderTopologyPanel(opts: TopologyPanelOpts): string {
  const { x, y, width, height, title, topology } = opts;
  const innerPad = 18;
  const titleH = 22;
  const drawX = x + innerPad;
  const drawY = y + titleH + innerPad;
  const drawW = width - 2 * innerPad;
  const drawH = height - titleH - 2 * innerPad;

  const inputCount = topology.inputCount;
  const hiddenCount = topology.hiddenCount;
  const outputCount = topology.outputCount;
  const total = topology.neuronCount;
  const outStart = inputCount + hiddenCount;

  // Lay neurons in three vertical columns.
  const layerXs = [drawX, drawX + drawW / 2, drawX + drawW];
  const positions = new Map<number, { x: number; y: number }>();

  // For large hidden counts, arrange them in a grid within the centre column
  // so they remain visible.
  const place = (
    count: number,
    startIdx: number,
    centreX: number,
    isHidden: boolean,
  ): void => {
    if (count === 0) return;
    if (count === 1) {
      positions.set(startIdx, { x: centreX, y: drawY + drawH / 2 });
      return;
    }
    if (!isHidden) {
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        positions.set(startIdx + i, { x: centreX, y: drawY + t * drawH });
      }
      return;
    }
    // Hidden: arrange in a square-ish grid centred on centreX.
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * 0.6)));
    const rows = Math.ceil(count / cols);
    const colSpacing = Math.min(20, (drawW * 0.6) / Math.max(1, cols - 1));
    const rowSpacing = drawH / Math.max(1, rows - 1);
    const startX = centreX - ((cols - 1) * colSpacing) / 2;
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const px = startX + c * colSpacing;
      const py = drawY + (rows === 1 ? drawH / 2 : r * rowSpacing);
      positions.set(startIdx + i, { x: px, y: py });
    }
  };

  place(inputCount, 0, layerXs[0], false);
  place(hiddenCount, inputCount, layerXs[1], true);
  place(outputCount, outStart, layerXs[2], false);

  const edgeLines: string[] = [];
  // Sort dormant edges first so healthy ones render on top.
  const sortedEdges = [...topology.edges].sort((a, b) => {
    if (a.dormant !== b.dormant) return a.dormant ? -1 : 1;
    if (a.from !== b.from) return a.from - b.from;
    return a.to - b.to;
  });
  for (const e of sortedEdges) {
    const f = positions.get(e.from);
    const t = positions.get(e.to);
    if (!f || !t) continue;
    const stroke = e.dormant ? "#d0d0d0" : "#666";
    const dash = e.dormant ? ' stroke-dasharray="2 2"' : "";
    edgeLines.push(
      `    <line x1="${f.x.toFixed(2)}" y1="${f.y.toFixed(2)}" x2="${t.x.toFixed(2)}" ` +
        `y2="${
          t.y.toFixed(2)
        }" stroke="${stroke}" stroke-width="0.5" stroke-opacity="0.7"${dash}/>`,
    );
  }

  const neuronCircles: string[] = [];
  for (let i = 0; i < total; i++) {
    const p = positions.get(i);
    if (!p) continue;
    const cat: DefectCategory = topology.defects[i] ?? "healthy";
    const fill = DEFECT_COLOURS[cat];
    const r = i < inputCount || i >= outStart ? 6 : 4;
    neuronCircles.push(
      `    <circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r}" fill="${fill}" ` +
        `stroke="#222" stroke-width="0.6"/>`,
    );
  }

  return [
    `  <g class="topology">`,
    `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" ` +
    `height="${height.toFixed(2)}" fill="#ffffff" stroke="#cccccc" stroke-width="0.8"/>`,
    `    <text x="${(x + width / 2).toFixed(2)}" y="${(y + 18).toFixed(2)}" ` +
    `text-anchor="middle" font-family="sans-serif" font-size="13" ` +
    `font-weight="bold" fill="#222">${escapeXml(title)}</text>`,
    edgeLines.join("\n"),
    neuronCircles.join("\n"),
    `  </g>`,
  ].join("\n");
}

function renderLegend(x: number, y: number): string {
  const entries: Array<[DefectCategory, string]> = [
    ["healthy", "healthy"],
    ["saturated", "saturated"],
    ["dead", "dead"],
    ["dormant", "dormant"],
    ["bimodal", "bimodal"],
    ["bottleneck", "bottleneck"],
  ];
  const lines: string[] = [];
  const itemWidth = 165;
  for (let i = 0; i < entries.length; i++) {
    const [cat, label] = entries[i];
    const cx = x + 12 + i * itemWidth;
    lines.push(
      `    <circle cx="${cx.toFixed(2)}" cy="${(y + 30).toFixed(2)}" r="6" ` +
        `fill="${DEFECT_COLOURS[cat]}" stroke="#222" stroke-width="0.6"/>`,
    );
    lines.push(
      `    <text x="${(cx + 12).toFixed(2)}" y="${(y + 33).toFixed(2)}" ` +
        `font-family="sans-serif" font-size="11" fill="#222">${label}</text>`,
    );
  }
  // Dormant synapse swatch.
  lines.push(
    `    <line x1="${(x + 12).toFixed(2)}" y1="${(y + 56).toFixed(2)}" ` +
      `x2="${(x + 38).toFixed(2)}" y2="${(y + 56).toFixed(2)}" stroke="#d0d0d0" ` +
      `stroke-width="0.9" stroke-dasharray="2 2"/>`,
  );
  lines.push(
    `    <text x="${(x + 46).toFixed(2)}" y="${(y + 59).toFixed(2)}" ` +
      `font-family="sans-serif" font-size="11" fill="#222">dormant synapse</text>`,
  );

  return [
    `  <g class="legend">`,
    `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${
      (PLOT_WIDTH - 2 * x).toFixed(2)
    }" height="76" fill="#ffffff" stroke="#cccccc" stroke-width="0.5"/>`,
    `    <text x="${(x + 12).toFixed(2)}" y="${(y + 16).toFixed(2)}" ` +
    `font-family="sans-serif" font-size="12" font-weight="bold" fill="#222">Legend</text>`,
    lines.join("\n"),
    `  </g>`,
  ].join("\n");
}

interface SummaryOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  before: TopologySnapshot;
  after: TopologySnapshot;
  baselineScore: number;
  crippledScore: number;
  discoveredScore: number | null;
  discoveryFound: boolean;
  discoveryNote: string | null;
}

function renderSummary(opts: SummaryOpts): string {
  const tally = (snap: TopologySnapshot): Record<DefectCategory, number> => {
    const t: Record<DefectCategory, number> = {
      healthy: 0,
      saturated: 0,
      dead: 0,
      dormant: 0,
      bimodal: 0,
      bottleneck: 0,
    };
    for (const cat of Object.values(snap.defects)) t[cat]++;
    return t;
  };
  const before = tally(opts.before);
  const after = tally(opts.after);

  const lines: string[] = [];
  const lh = 16;
  const innerPad = 12;
  let cy = opts.y + 22;
  lines.push(
    `    <text x="${(opts.x + innerPad).toFixed(2)}" y="${cy.toFixed(2)}" ` +
      `font-family="sans-serif" font-size="13" font-weight="bold" fill="#222">Summary</text>`,
  );
  cy += lh + 4;

  const scoreLines = [
    `baseline   = ${opts.baselineScore.toPrecision(6)}`,
    `crippled   = ${opts.crippledScore.toPrecision(6)}`,
    opts.discoveredScore !== null
      ? `discovered = ${opts.discoveredScore.toPrecision(6)}`
      : `discovered = (n/a${opts.discoveryNote ? ` — ${opts.discoveryNote}` : ""})`,
  ];
  for (const line of scoreLines) {
    lines.push(
      `    <text x="${(opts.x + innerPad).toFixed(2)}" y="${cy.toFixed(2)}" ` +
        `font-family="monospace" font-size="11" fill="#333">${escapeXml(line)}</text>`,
    );
    cy += lh;
  }

  const tallyX = opts.x + opts.width / 2;
  let ty = opts.y + 22;
  lines.push(
    `    <text x="${tallyX.toFixed(2)}" y="${ty.toFixed(2)}" ` +
      `font-family="sans-serif" font-size="13" font-weight="bold" ` +
      `fill="#222">Defect tally  before → after</text>`,
  );
  ty += lh + 4;
  for (
    const cat of [
      "saturated",
      "dead",
      "dormant",
      "bimodal",
      "bottleneck",
    ] as const
  ) {
    lines.push(
      `    <text x="${tallyX.toFixed(2)}" y="${ty.toFixed(2)}" ` +
        `font-family="monospace" font-size="11" fill="#333">${cat.padEnd(11)} ${
          String(before[cat]).padStart(3)
        }  →  ${String(after[cat]).padStart(3)}</text>`,
    );
    ty += lh;
  }

  return [
    `  <g class="summary">`,
    `    <rect x="${opts.x.toFixed(2)}" y="${opts.y.toFixed(2)}" ` +
    `width="${opts.width.toFixed(2)}" height="${opts.height.toFixed(2)}" ` +
    `fill="#ffffff" stroke="#cccccc" stroke-width="0.5"/>`,
    lines.join("\n"),
    `  </g>`,
  ].join("\n");
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
