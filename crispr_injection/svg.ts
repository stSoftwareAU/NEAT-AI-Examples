/**
 * SVG rendering for the CRISPR gene-injection demo.
 *
 * The output combines two panels in one SVG:
 *
 * - Top: the injected gene's topology in isolation — input ports on
 *   the left, gene's hidden neurons in the middle, output port on the
 *   right, with the gene's input/output synapses drawn as lines.
 * - Bottom: a fitness-vs-generation line chart with a vertical dashed
 *   marker at the injection generation, so the post-injection lift is
 *   visually obvious.
 */
import type { FitnessRecord, InjectedGene } from "./crispr_injection.ts";

/** SVG canvas width. */
export const PLOT_WIDTH = 880;
/** SVG canvas height (top gene panel + bottom fitness chart). */
export const PLOT_HEIGHT = 540;
/** Height of the gene topology panel. */
export const GENE_PANEL_HEIGHT = 200;

const MARGIN_LEFT = 70;
const MARGIN_RIGHT = 32;
const CHART_TOP = GENE_PANEL_HEIGHT + 40;
const MARGIN_BOTTOM = 64;

const INNER_WIDTH = PLOT_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const CHART_HEIGHT = PLOT_HEIGHT - CHART_TOP - MARGIN_BOTTOM;

/** CSS class assigned to the vertical injection marker line. */
export const INJECTION_MARKER_CLASS = "injection-marker";
/** CSS class assigned to the gene topology group. */
export const GENE_TOPOLOGY_CLASS = "gene-topology";

/** Inputs to {@link renderCrisprSVG}. */
export interface RenderCrisprOptions {
  /** Per-generation fitness records. */
  records: readonly FitnessRecord[];
  /** Generation at which the gene was injected. */
  injectionGeneration: number;
  /** The hand-crafted gene whose topology is rendered in the top panel. */
  gene: InjectedGene;
}

/**
 * Render the combined gene-topology + fitness-curve SVG.
 *
 * The fitness panel uses the actual recorded values for axis bounds —
 * very flat pre-injection traces still get a visible spread.
 */
export function renderCrisprSVG(options: RenderCrisprOptions): string {
  const { records, injectionGeneration, gene } = options;
  if (records.length === 0) {
    throw new Error("records must contain at least one fitness entry");
  }
  if (gene.hidden.length === 0) {
    throw new Error("gene must contain at least one hidden neuron");
  }

  const totalGens = records.length;
  const xScale = (g: number) => MARGIN_LEFT + (g / Math.max(1, totalGens - 1)) * INNER_WIDTH;

  const fitnesses = records.map((r) => r.bestFitness);
  let yMin = Math.min(...fitnesses);
  let yMax = Math.max(...fitnesses);
  if (yMax === yMin) {
    yMin -= 0.5;
    yMax += 0.5;
  } else {
    const pad = (yMax - yMin) * 0.1;
    yMin -= pad;
    yMax += pad;
  }
  const yScale = (f: number) => {
    const norm = (f - yMin) / (yMax - yMin);
    return CHART_TOP + (1 - norm) * CHART_HEIGHT;
  };

  const fitnessPoints = records
    .map((r) => `${xScale(r.generation).toFixed(2)},${yScale(r.bestFitness).toFixed(2)}`)
    .join(" ");

  const injectionX = xScale(injectionGeneration);

  const yTickCount = 4;
  const yTicks: string[] = [];
  for (let i = 0; i < yTickCount; i++) {
    const t = i / (yTickCount - 1);
    const value = yMin + t * (yMax - yMin);
    const y = yScale(value);
    yTicks.push(
      `    <line x1="${MARGIN_LEFT.toFixed(2)}" y1="${y.toFixed(2)}" ` +
        `x2="${(MARGIN_LEFT - 5).toFixed(2)}" y2="${y.toFixed(2)}" ` +
        `stroke="#333" stroke-width="1"/>`,
    );
    yTicks.push(
      `    <text x="${(MARGIN_LEFT - 8).toFixed(2)}" y="${(y + 4).toFixed(2)}" ` +
        `text-anchor="end" font-size="11" fill="#333">${value.toFixed(3)}</text>`,
    );
  }

  const xTickCount = Math.min(6, totalGens);
  const xTicks: string[] = [];
  for (let i = 0; i < xTickCount; i++) {
    const t = i / Math.max(1, xTickCount - 1);
    const gen = Math.round(t * (totalGens - 1));
    const x = xScale(gen);
    xTicks.push(
      `    <line x1="${x.toFixed(2)}" y1="${(CHART_TOP + CHART_HEIGHT).toFixed(2)}" ` +
        `x2="${x.toFixed(2)}" y2="${(CHART_TOP + CHART_HEIGHT + 5).toFixed(2)}" ` +
        `stroke="#333" stroke-width="1"/>`,
    );
    xTicks.push(
      `    <text x="${x.toFixed(2)}" y="${(CHART_TOP + CHART_HEIGHT + 20).toFixed(2)}" ` +
        `text-anchor="middle" font-size="11" fill="#333">${gen}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" ` +
    `width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" role="img" ` +
    `aria-label="CRISPR gene injection — gene topology and fitness lift">`,
    `  <title>CRISPR Gene Injection — Topology and Fitness Lift</title>`,
    `  <rect width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${PLOT_WIDTH / 2}" y="28" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
    `CRISPR Gene Injection — Topology and Fitness Lift</text>`,
    renderGenePanel(gene),
    renderFitnessFrame(),
    yTicks.join("\n"),
    xTicks.join("\n"),
    renderInjectionMarker(injectionX),
    `  <polyline class="fitness" fill="none" stroke="#16a085" stroke-width="2" ` +
    `points="${fitnessPoints}"/>`,
    renderFitnessLabels(),
    `</svg>`,
    "",
  ].join("\n");
}

function renderGenePanel(gene: InjectedGene): string {
  const panelTop = 40;
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

function renderFitnessFrame(): string {
  return [
    `  <g class="fitness-frame" font-family="sans-serif">`,
    `    <rect x="${MARGIN_LEFT}" y="${CHART_TOP}" width="${INNER_WIDTH}" ` +
    `height="${CHART_HEIGHT}" fill="#ffffff" stroke="#333" stroke-width="1"/>`,
    `    <text x="${MARGIN_LEFT}" y="${CHART_TOP - 8}" font-size="13" ` +
    `font-weight="bold" fill="#222">Fitness vs generation</text>`,
    `  </g>`,
  ].join("\n");
}

function renderInjectionMarker(x: number): string {
  return [
    `  <g class="${INJECTION_MARKER_CLASS}" font-family="sans-serif">`,
    `    <line x1="${x.toFixed(2)}" y1="${CHART_TOP.toFixed(2)}" x2="${x.toFixed(2)}" ` +
    `y2="${(CHART_TOP + CHART_HEIGHT).toFixed(2)}" stroke="#e74c3c" stroke-width="2" ` +
    `stroke-dasharray="6 4"/>`,
    `    <text x="${(x + 6).toFixed(2)}" y="${(CHART_TOP + 14).toFixed(2)}" ` +
    `font-size="11" fill="#e74c3c">CRISPR injection</text>`,
    `  </g>`,
  ].join("\n");
}

function renderFitnessLabels(): string {
  const baseY = CHART_TOP + CHART_HEIGHT;
  const xMid = MARGIN_LEFT + INNER_WIDTH / 2;
  return [
    `  <g class="axis-labels" font-family="sans-serif" font-size="12" fill="#333">`,
    `    <text x="${xMid}" y="${baseY + 44}" text-anchor="middle">generation</text>`,
    `    <text x="${MARGIN_LEFT - 50}" y="${CHART_TOP + CHART_HEIGHT / 2}" ` +
    `text-anchor="middle" dominant-baseline="middle" ` +
    `transform="rotate(-90 ${MARGIN_LEFT - 50} ${CHART_TOP + CHART_HEIGHT / 2})">` +
    `best fitness</text>`,
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
