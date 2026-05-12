/**
 * SVG rendering for the CRISPR gene-injection demo.
 *
 * The output combines two panels in one SVG:
 *
 * - Top: the injected gene's topology in isolation — input ports on the
 *   left, gene's hidden neurons in the middle, output port on the right,
 *   with the gene's input/output synapses drawn as lines.
 * - Bottom: a before-vs-after milestone panel sourced from two
 *   {@link EvolveDirSummary} records — the pre-injection summary on the
 *   left, the post-injection summary on the right. Numeric callouts
 *   compare `finalScore`, `finalError`, generations and topology counts
 *   side by side so the "fitness lift" lands without a per-generation
 *   trace.
 */
import type { EvolveDirSummary } from "../common/evolve_dir_summary.ts";
import type { InjectedGene } from "./crispr_injection.ts";

/** SVG canvas width. */
export const PLOT_WIDTH = 880;
/** SVG canvas height (top gene panel + bottom milestone panel). */
export const PLOT_HEIGHT = 540;
/** Height of the gene topology panel. */
export const GENE_PANEL_HEIGHT = 200;

const MARGIN_LEFT = 60;
const MARGIN_RIGHT = 32;
const PANEL_TOP_OFFSET = 40;
const MILESTONE_TOP = GENE_PANEL_HEIGHT + 40;
const MARGIN_BOTTOM = 40;

const INNER_WIDTH = PLOT_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const MILESTONE_HEIGHT = PLOT_HEIGHT - MILESTONE_TOP - MARGIN_BOTTOM;

/** CSS class assigned to the gene topology group. */
export const GENE_TOPOLOGY_CLASS = "gene-topology";
/** CSS class assigned to the before-vs-after milestone group. */
export const MILESTONE_PANEL_CLASS = "milestone-panel";

/** Inputs to {@link renderCrisprInjectionSvg}. */
export interface RenderCrisprInjectionOptions {
  /** The hand-crafted gene whose topology is rendered in the top panel. */
  gene: InjectedGene;
  /** Milestone summary from the pre-injection `evolveDir` run. */
  pre: EvolveDirSummary;
  /** Milestone summary from the post-injection `evolveDir` run. */
  post: EvolveDirSummary;
}

/**
 * Render the combined gene-topology + before/after milestone SVG.
 *
 * The fitness-lift narrative is driven by the deltas between the
 * supplied pre-injection and post-injection summaries — no
 * per-generation rows are required.
 */
export function renderCrisprInjectionSvg(options: RenderCrisprInjectionOptions): string {
  const { gene, pre, post } = options;
  if (gene.hidden.length === 0) {
    throw new Error("gene must contain at least one hidden neuron");
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="CRISPR gene injection — gene topology and before-vs-after milestone summary">`,
    `  <title>CRISPR Gene Injection — Topology and Before-vs-After Milestone Summary</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="28" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
    `CRISPR Gene Injection — Topology and Fitness Lift</text>`,
    renderGenePanel(gene),
    renderMilestonePanel(pre, post),
    `</svg>`,
    "",
  ].join("\n");
}

function renderGenePanel(gene: InjectedGene): string {
  const panelTop = PANEL_TOP_OFFSET;
  const panelBottom = panelTop + GENE_PANEL_HEIGHT - 40;
  const inputXs = new Set<number>();
  for (const s of gene.inputSynapses) inputXs.add(s.fromInputIndex);
  const inputIndices = Array.from(inputXs).sort((a, b) => a - b);

  const outputUUIDs = new Set<string>();
  for (const s of gene.outputSynapses) outputUUIDs.add(s.toOutputUUID);

  const inputX = MARGIN_LEFT + 40;
  const hiddenX = MARGIN_LEFT + INNER_WIDTH / 2;
  const outputX = MARGIN_LEFT + INNER_WIDTH - 40;

  const positions = new Map<string, { x: number; y: number }>();
  inputIndices.forEach((idx, i) => {
    const y = panelTop + 30 + (panelBottom - panelTop - 30) *
        (inputIndices.length === 1 ? 0.5 : i / (inputIndices.length - 1));
    positions.set(`in:${idx}`, { x: inputX, y });
  });

  gene.hidden.forEach((n, i) => {
    const y = panelTop + 30 + (panelBottom - panelTop - 30) *
        (gene.hidden.length === 1 ? 0.5 : i / (gene.hidden.length - 1));
    positions.set(`h:${n.uuid}`, { x: hiddenX, y });
  });

  const outputList = Array.from(outputUUIDs);
  outputList.forEach((u, i) => {
    const y = panelTop + 30 + (panelBottom - panelTop - 30) *
        (outputList.length === 1 ? 0.5 : i / (outputList.length - 1));
    positions.set(`out:${u}`, { x: outputX, y });
  });

  const synapseLines: string[] = [];
  for (const s of gene.inputSynapses) {
    const a = positions.get(`in:${s.fromInputIndex}`);
    const b = positions.get(`h:${s.toUUID}`);
    if (!a || !b) continue;
    synapseLines.push(synapseLine(a, b, s.weight));
  }
  for (const s of gene.internalSynapses) {
    const a = positions.get(`h:${s.fromUUID}`);
    const b = positions.get(`h:${s.toUUID}`);
    if (!a || !b) continue;
    synapseLines.push(synapseLine(a, b, s.weight));
  }
  for (const s of gene.outputSynapses) {
    const a = positions.get(`h:${s.fromUUID}`);
    const b = positions.get(`out:${s.toOutputUUID}`);
    if (!a || !b) continue;
    synapseLines.push(synapseLine(a, b, s.weight));
  }

  const nodes: string[] = [];
  for (const idx of inputIndices) {
    const p = positions.get(`in:${idx}`);
    if (!p) continue;
    nodes.push(neuronCircle(p.x, p.y, "#4a90d9", `in[${idx}]`));
  }
  for (const n of gene.hidden) {
    const p = positions.get(`h:${n.uuid}`);
    if (!p) continue;
    nodes.push(neuronCircle(p.x, p.y, "#bd10e0", n.squash ?? "?"));
  }
  for (const u of outputList) {
    const p = positions.get(`out:${u}`);
    if (!p) continue;
    nodes.push(neuronCircle(p.x, p.y, "#16a085", "out"));
  }

  return [
    `  <g class="${GENE_TOPOLOGY_CLASS}" font-family="sans-serif">`,
    `    <text x="${MARGIN_LEFT}" y="${panelTop - 6}" font-size="13" ` +
    `font-weight="bold" fill="#222">Injected gene topology</text>`,
    ...synapseLines,
    ...nodes,
    `  </g>`,
  ].join("\n");
}

function synapseLine(
  a: { x: number; y: number },
  b: { x: number; y: number },
  weight: number,
): string {
  const colour = weight >= 0 ? "#27ae60" : "#e74c3c";
  const strokeWidth = Math.min(3, Math.max(1, Math.abs(weight)));
  return `    <line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" ` +
    `y2="${b.y.toFixed(2)}" stroke="${colour}" stroke-width="${strokeWidth.toFixed(2)}" ` +
    `stroke-opacity="0.7"/>`;
}

function neuronCircle(x: number, y: number, fill: string, label: string): string {
  return [
    `    <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="14" fill="${fill}" ` +
    `stroke="#222" stroke-width="1"/>`,
    `    <text x="${x.toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="middle" ` +
    `font-size="10" fill="#fff" font-weight="bold">${escapeXml(label)}</text>`,
  ].join("\n");
}

/**
 * Render the bottom panel — two milestone columns drawn from the
 * supplied `EvolveDirSummary` records, with a "lift" callout between
 * them quoting the post-vs-pre score delta.
 */
function renderMilestonePanel(pre: EvolveDirSummary, post: EvolveDirSummary): string {
  const lift = post.finalScore - pre.finalScore;
  const panelX = MARGIN_LEFT;
  const panelY = MILESTONE_TOP;
  const panelW = INNER_WIDTH;
  const panelH = MILESTONE_HEIGHT;

  const colW = (panelW - 20) / 2;
  const preX = panelX;
  const postX = panelX + colW + 20;

  const out: string[] = [];
  out.push(`  <g class="${MILESTONE_PANEL_CLASS}" font-family="sans-serif">`);
  out.push(
    `    <text x="${panelX}" y="${(panelY - 8).toFixed(2)}" font-size="13" ` +
      `font-weight="bold" fill="#222">Before vs after gene injection</text>`,
  );
  out.push(renderMilestoneColumn(preX, panelY, colW, panelH, "pre-injection", pre, "#9ecae1"));
  out.push(renderMilestoneColumn(postX, panelY, colW, panelH, "post-injection", post, "#1f77b4"));

  // Lift callout in the gap between the two columns.
  const liftX = panelX + colW + 10;
  const liftY = panelY + panelH / 2;
  const liftColour = lift >= 0 ? "#27ae60" : "#e74c3c";
  const sign = lift >= 0 ? "+" : "";
  out.push(
    `    <text x="${liftX.toFixed(2)}" y="${(liftY - 8).toFixed(2)}" text-anchor="middle" ` +
      `font-size="10" fill="#555">fitness lift</text>`,
    `    <text x="${liftX.toFixed(2)}" y="${(liftY + 10).toFixed(2)}" text-anchor="middle" ` +
      `font-size="14" font-weight="bold" fill="${liftColour}">${sign}${formatScore(lift)}</text>`,
  );

  out.push(`  </g>`);
  return out.join("\n");
}

function renderMilestoneColumn(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  summary: EvolveDirSummary,
  accent: string,
): string {
  const rows: Array<[string, string]> = [
    ["final score", formatScore(summary.finalScore)],
    ["final error", formatScore(summary.finalError)],
    ["generations", String(Math.round(summary.generations))],
    ["neurons", String(summary.finalNeurons)],
    ["synapses", String(summary.finalSynapses)],
  ];
  const headerH = 28;
  const rowH = Math.max(18, (h - headerH - 8) / rows.length);

  const out: string[] = [];
  out.push(
    `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" ` +
      `height="${h.toFixed(2)}" fill="#ffffff" stroke="#333" stroke-width="1"/>`,
    `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" ` +
      `height="${headerH.toFixed(2)}" fill="${accent}"/>`,
    `    <text x="${(x + w / 2).toFixed(2)}" y="${(y + 18).toFixed(2)}" text-anchor="middle" ` +
      `font-size="12" font-weight="bold" fill="#ffffff">${escapeXml(label)}</text>`,
  );

  for (let i = 0; i < rows.length; i++) {
    const [k, v] = rows[i];
    const rowY = y + headerH + i * rowH + rowH / 2;
    out.push(
      `    <text x="${(x + 10).toFixed(2)}" y="${rowY.toFixed(2)}" ` +
        `dominant-baseline="middle" font-size="11" fill="#333">${escapeXml(k)}</text>`,
      `    <text x="${(x + w - 10).toFixed(2)}" y="${rowY.toFixed(2)}" text-anchor="end" ` +
        `dominant-baseline="middle" font-size="11" font-weight="bold" ` +
        `fill="#222">${escapeXml(v)}</text>`,
    );
  }
  return out.join("\n");
}

function formatScore(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 1000) / 1000).toString();
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
