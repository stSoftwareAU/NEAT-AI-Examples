/**
 * Multi-panel evolution-progress SVG renderer.
 *
 * Consumes the snapshots produced by `common/evolution_snapshot.ts` and
 * emits a single horizontal strip of panels — one per snapshot generation
 * — visualising how the network and its score evolved from the first
 * captured generation through to the last.
 *
 * Each panel contains:
 *
 *   - a small network topology diagram (inputs → hidden → outputs),
 *   - the generation label (e.g. "Gen 1", "Gen 10000"),
 *   - the score for that snapshot, formatted to a documented precision.
 *
 * A score progression polyline is drawn across the bottom of the strip,
 * linking all panels. An optional caption summarises the run (final
 * score, total generations, wall-clock time). SMIL `<animate>` elements
 * pulse each panel's background in sequence so the eye is led from the
 * first generation through to the last.
 *
 * The renderer is pure string emission — no DOM, no extra dependencies —
 * and is byte-deterministic for identical inputs.
 */

import type { Snapshot } from "./evolution_snapshot.ts";

/** Snapshot input shape — matches `Snapshot` from `evolution_snapshot.ts`. */
export type EvolutionProgressSnapshot = Snapshot;

/** Optional caption fields summarising the run. */
export interface EvolutionCaption {
  /** Final/best score reached during the run. */
  finalScore?: number;
  /** Total generations evolved (typically the highest checkpoint). */
  totalGenerations?: number;
  /** Wall-clock time in milliseconds. Rendered as seconds or minutes. */
  wallClockMs?: number;
  /** Optional free-form text appended after the structured fields. */
  text?: string;
}

/** Options controlling {@link renderEvolutionProgressSvg}. */
export interface RenderEvolutionProgressOptions {
  /** Width of an individual panel in user units. Default 200. */
  panelWidth?: number;
  /** Height of the topology + label area inside a panel. Default 200. */
  panelHeight?: number;
  /** Height reserved for the score-progression line strip. Default 100. */
  progressionHeight?: number;
  /** Number of decimals used when formatting score values. Default 3. */
  scorePrecision?: number;
  /** Title rendered at the top of the SVG. Default "Evolution Progress". */
  title?: string;
  /** Optional caption overlay summarising the run. */
  caption?: EvolutionCaption;
  /** Per-panel pulse duration in seconds. Default 0.6. */
  pulseSeconds?: number;
}

const DEFAULT_PANEL_WIDTH = 200;
const DEFAULT_PANEL_HEIGHT = 200;
const DEFAULT_PROGRESSION_HEIGHT = 100;
const DEFAULT_SCORE_PRECISION = 3;
const DEFAULT_PULSE_SECONDS = 0.6;
const TITLE_HEIGHT = 36;
const CAPTION_HEIGHT = 40;

const NEURON_COLOURS = {
  input: "#4a90d9",
  hidden: "#bd10e0",
  output: "#16a085",
  constant: "#888888",
} as const;

const PANEL_BG = "#ffffff";
const STRIP_BG = "#fafafa";
const PROGRESSION_COLOUR = "#1f77b4";
const SYNAPSE_POSITIVE = "#27ae60";
const SYNAPSE_NEGATIVE = "#e74c3c";

/**
 * Render snapshots as a single horizontal multi-panel SVG string.
 *
 * Throws if `snapshots` is empty.
 */
export function renderEvolutionProgressSvg(
  snapshots: readonly EvolutionProgressSnapshot[],
  options: RenderEvolutionProgressOptions = {},
): string {
  if (snapshots.length === 0) {
    throw new Error("renderEvolutionProgressSvg requires at least one snapshot");
  }

  const panelWidth = options.panelWidth ?? DEFAULT_PANEL_WIDTH;
  const panelHeight = options.panelHeight ?? DEFAULT_PANEL_HEIGHT;
  const progressionHeight = options.progressionHeight ?? DEFAULT_PROGRESSION_HEIGHT;
  const scorePrecision = options.scorePrecision ?? DEFAULT_SCORE_PRECISION;
  const title = options.title ?? "Evolution Progress";
  const pulseSeconds = options.pulseSeconds ?? DEFAULT_PULSE_SECONDS;
  const hasCaption = options.caption !== undefined;

  const totalWidth = panelWidth * snapshots.length;
  const totalHeight = TITLE_HEIGHT + panelHeight + progressionHeight +
    (hasCaption ? CAPTION_HEIGHT : 0);

  const scoreMin = Math.min(...snapshots.map((s) => s.score));
  const scoreMax = Math.max(...snapshots.map((s) => s.score));

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" ` +
      `width="${totalWidth}" height="${totalHeight}" role="img" ` +
      `aria-label="${escapeAttr(title)} multi-panel strip">`,
    `  <title>${escapeText(title)}</title>`,
    `  <rect width="${totalWidth}" height="${totalHeight}" fill="${STRIP_BG}"/>`,
    `  <text x="${fmt(totalWidth / 2)}" y="22" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
      escapeText(title) + `</text>`,
  );

  // Per-panel rendering.
  const totalPulseDuration = snapshots.length * pulseSeconds;
  for (let i = 0; i < snapshots.length; i++) {
    const x = i * panelWidth;
    lines.push(
      renderPanel(
        snapshots[i],
        x,
        TITLE_HEIGHT,
        panelWidth,
        panelHeight,
        scorePrecision,
        i,
        pulseSeconds,
        totalPulseDuration,
      ),
    );
  }

  // Score progression polyline across the bottom of the strip.
  lines.push(
    renderScoreProgression(
      snapshots,
      panelWidth,
      TITLE_HEIGHT + panelHeight,
      progressionHeight,
      scoreMin,
      scoreMax,
      scorePrecision,
    ),
  );

  if (hasCaption) {
    lines.push(
      renderCaption(
        options.caption!,
        totalWidth,
        TITLE_HEIGHT + panelHeight + progressionHeight,
        CAPTION_HEIGHT,
        scorePrecision,
      ),
    );
  }

  lines.push("</svg>", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

function renderPanel(
  snap: EvolutionProgressSnapshot,
  panelX: number,
  panelY: number,
  panelW: number,
  panelH: number,
  scorePrecision: number,
  index: number,
  pulseSeconds: number,
  totalPulseDuration: number,
): string {
  const inset = 6;
  const innerX = panelX + inset;
  const innerY = panelY + inset;
  const innerW = panelW - inset * 2;
  const innerH = panelH - inset * 2;

  // SMIL <animate> sequencing — each panel pulses in turn. begin offsets
  // by index * pulseSeconds; the cycle restarts after totalPulseDuration.
  const begin = (index * pulseSeconds).toFixed(2);
  const dur = pulseSeconds.toFixed(2);
  const cycle = totalPulseDuration.toFixed(2);

  const out: string[] = [];
  out.push(
    `  <g class="panel" data-generation="${snap.generation}" data-index="${index}">`,
    `    <rect x="${fmt(innerX)}" y="${fmt(innerY)}" width="${fmt(innerW)}" ` +
      `height="${fmt(innerH)}" fill="${PANEL_BG}" stroke="#cccccc" stroke-width="1" rx="4">`,
    `      <animate attributeName="fill" values="${PANEL_BG};#fff7c2;${PANEL_BG}" ` +
      `begin="${begin}s" dur="${dur}s" repeatCount="indefinite" ` +
      `repeatDur="${cycle}s"/>`,
    `    </rect>`,
  );

  // Generation label and score.
  out.push(
    `    <text x="${fmt(innerX + innerW / 2)}" y="${fmt(innerY + 16)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="12" ` +
      `font-weight="bold" fill="#222">Gen ${snap.generation}</text>`,
    `    <text x="${fmt(innerX + innerW / 2)}" y="${fmt(innerY + innerH - 8)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555">` +
      `score ${escapeText(formatScore(snap.score, scorePrecision))}</text>`,
  );

  // Topology drawing area.
  const topoTop = innerY + 22;
  const topoBottom = innerY + innerH - 22;
  out.push(renderTopology(snap.creature, innerX + 4, topoTop, innerW - 8, topoBottom - topoTop));

  // Index label below the generation, helps screen readers and stable
  // ordering — and feeds the assertion about `<g class="panel">` count.
  out.push(`  </g>`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Topology rendering — defensive against creature JSON shape variation
// ---------------------------------------------------------------------------

interface NeuronLike {
  type: "input" | "hidden" | "output" | "constant";
}

interface SynapseLike {
  from: number;
  to: number;
  weight: number;
}

/** Coerce arbitrary creature JSON to neurons + synapses arrays. */
function extractTopology(creature: unknown): {
  neurons: NeuronLike[];
  synapses: SynapseLike[];
} {
  if (creature === null || typeof creature !== "object") {
    return { neurons: [], synapses: [] };
  }
  const obj = creature as Record<string, unknown>;
  const rawNeurons = (obj.neurons ?? obj.nodes) as unknown;
  const rawSynapses = (obj.synapses ?? obj.connections) as unknown;

  const neurons: NeuronLike[] = [];
  if (Array.isArray(rawNeurons)) {
    for (const n of rawNeurons) {
      if (n && typeof n === "object") {
        const t = (n as Record<string, unknown>).type;
        const type = (t === "input" || t === "hidden" || t === "output" || t === "constant")
          ? t
          : "hidden";
        neurons.push({ type });
      }
    }
  }

  const synapses: SynapseLike[] = [];
  if (Array.isArray(rawSynapses)) {
    for (const s of rawSynapses) {
      if (s && typeof s === "object") {
        const so = s as Record<string, unknown>;
        const from = typeof so.from === "number" ? so.from : -1;
        const to = typeof so.to === "number" ? so.to : -1;
        const weight = typeof so.weight === "number" ? so.weight : 0;
        if (from >= 0 && to >= 0) synapses.push({ from, to, weight });
      }
    }
  }

  return { neurons, synapses };
}

function renderTopology(
  creature: unknown,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const { neurons, synapses } = extractTopology(creature);
  if (neurons.length === 0) {
    return `    <text x="${fmt(x + w / 2)}" y="${fmt(y + h / 2)}" ` +
      `text-anchor="middle" font-family="sans-serif" font-size="10" fill="#999">` +
      `(no topology)</text>`;
  }

  // Bucket neurons by layer.
  const inputs: number[] = [];
  const hidden: number[] = [];
  const outputs: number[] = [];
  for (let i = 0; i < neurons.length; i++) {
    if (neurons[i].type === "input") inputs.push(i);
    else if (neurons[i].type === "output") outputs.push(i);
    else hidden.push(i); // hidden + constant fold to the middle column
  }

  // Three columns: inputs (left), hidden (middle), outputs (right).
  const colXs = [x + 12, x + w / 2, x + w - 12];

  const positions = new Map<number, { x: number; y: number }>();
  layoutColumn(positions, inputs, colXs[0], y + 4, h - 8);
  layoutColumn(positions, hidden, colXs[1], y + 4, h - 8);
  layoutColumn(positions, outputs, colXs[2], y + 4, h - 8);

  const out: string[] = [];

  // Synapses behind nodes.
  for (const s of synapses) {
    const a = positions.get(s.from);
    const b = positions.get(s.to);
    if (!a || !b) continue;
    const colour = s.weight >= 0 ? SYNAPSE_POSITIVE : SYNAPSE_NEGATIVE;
    out.push(
      `    <line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" ` +
        `stroke="${colour}" stroke-width="0.8" stroke-opacity="0.7"/>`,
    );
  }

  // Nodes.
  for (let i = 0; i < neurons.length; i++) {
    const p = positions.get(i);
    if (!p) continue;
    const fill = NEURON_COLOURS[neurons[i].type] ?? NEURON_COLOURS.hidden;
    out.push(
      `    <circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="3" fill="${fill}" ` +
        `stroke="#222" stroke-width="0.5"/>`,
    );
  }

  return out.join("\n");
}

function layoutColumn(
  positions: Map<number, { x: number; y: number }>,
  indices: readonly number[],
  colX: number,
  topY: number,
  height: number,
): void {
  if (indices.length === 0) return;
  if (indices.length === 1) {
    positions.set(indices[0], { x: colX, y: topY + height / 2 });
    return;
  }
  for (let i = 0; i < indices.length; i++) {
    const t = i / (indices.length - 1);
    positions.set(indices[i], { x: colX, y: topY + t * height });
  }
}

// ---------------------------------------------------------------------------
// Score progression
// ---------------------------------------------------------------------------

function renderScoreProgression(
  snapshots: readonly EvolutionProgressSnapshot[],
  panelWidth: number,
  topY: number,
  height: number,
  scoreMin: number,
  scoreMax: number,
  scorePrecision: number,
): string {
  // Map each snapshot to the centre of its panel on the X axis.
  const padTop = 14;
  const padBottom = 14;
  const innerTop = topY + padTop;
  const innerHeight = Math.max(1, height - padTop - padBottom);

  const span = scoreMax - scoreMin;
  const yFor = (score: number) => {
    if (span === 0) return innerTop + innerHeight / 2;
    // Higher score → smaller y (top of strip).
    return innerTop + (1 - (score - scoreMin) / span) * innerHeight;
  };

  const points = snapshots.map((s, i) => {
    const x = i * panelWidth + panelWidth / 2;
    return `${fmt(x)},${fmt(yFor(s.score))}`;
  }).join(" ");

  const out: string[] = [];
  out.push(
    `  <g class="progression" data-min="${formatScore(scoreMin, scorePrecision)}" ` +
      `data-max="${formatScore(scoreMax, scorePrecision)}">`,
    `    <rect x="0" y="${fmt(topY)}" width="${fmt(snapshots.length * panelWidth)}" ` +
      `height="${fmt(height)}" fill="#f4f4f4"/>`,
    `    <polyline class="score-progression" fill="none" stroke="${PROGRESSION_COLOUR}" ` +
      `stroke-width="2" points="${points}"/>`,
  );
  for (const s of snapshots) {
    const i = snapshots.indexOf(s);
    const x = i * panelWidth + panelWidth / 2;
    out.push(
      `    <circle cx="${fmt(x)}" cy="${fmt(yFor(s.score))}" r="3" ` +
        `fill="${PROGRESSION_COLOUR}"/>`,
    );
  }
  // Min/max score labels at the strip edges.
  out.push(
    `    <text x="6" y="${fmt(topY + 12)}" font-family="sans-serif" font-size="10" fill="#555">` +
      `max ${escapeText(formatScore(scoreMax, scorePrecision))}</text>`,
    `    <text x="6" y="${fmt(topY + height - 4)}" font-family="sans-serif" ` +
      `font-size="10" fill="#555">min ${escapeText(formatScore(scoreMin, scorePrecision))}</text>`,
    `  </g>`,
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Caption
// ---------------------------------------------------------------------------

function renderCaption(
  caption: EvolutionCaption,
  totalWidth: number,
  topY: number,
  height: number,
  scorePrecision: number,
): string {
  const parts: string[] = [];
  if (caption.finalScore !== undefined) {
    parts.push(`final score ${formatScore(caption.finalScore, scorePrecision)}`);
  }
  if (caption.totalGenerations !== undefined) {
    parts.push(`${caption.totalGenerations} generations`);
  }
  if (caption.wallClockMs !== undefined) {
    parts.push(formatDuration(caption.wallClockMs));
  }
  if (caption.text) {
    parts.push(caption.text);
  }
  const text = parts.join(" • ") || " ";

  return [
    `  <g class="caption">`,
    `    <rect x="0" y="${fmt(topY)}" width="${fmt(totalWidth)}" height="${fmt(height)}" ` +
    `fill="#222222"/>`,
    `    <text x="${fmt(totalWidth / 2)}" y="${fmt(topY + height / 2 + 4)}" ` +
    `text-anchor="middle" font-family="sans-serif" font-size="12" fill="#ffffff">` +
    escapeText(text) + `</text>`,
    `  </g>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatScore(v: number, precision: number): string {
  if (!Number.isFinite(v)) return "0";
  const factor = Math.pow(10, precision);
  return (Math.round(v * factor) / factor).toFixed(precision);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 60_000) {
    const secs = ms / 1000;
    return `${(Math.round(secs * 10) / 10).toFixed(1)}s`;
  }
  const mins = ms / 60_000;
  return `${(Math.round(mins * 10) / 10).toFixed(1)}min`;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 100) / 100).toString();
}

function escapeText(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replaceAll('"', "&quot;");
}
